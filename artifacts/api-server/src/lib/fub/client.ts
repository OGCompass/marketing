import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../logger";

const BASE = new URL("https://api.followupboss.com/v1/");
export const resources = ["people", "events", "deals", "stages", "users", "customFields"] as const;
export type FubResource = (typeof resources)[number];
export type FubRecord = Record<string, unknown>;

export class FubReadError extends Error {
  constructor(public readonly resource: FubResource, public readonly status: number | null, message: string) {
    super(message);
  }
}

let active = 0;
const waiting: (() => void)[] = [];
let nextRequestAt = 0;

async function acquire() {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export function fubCredentialsConfigured() {
  return ["FUB_API_KEY", "FUB_X_SYSTEM", "FUB_X_SYSTEM_KEY"].every((key) => !!process.env[key]);
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (millis > 0) return Math.min(millis, 60000);
  }
  return Math.min(1000 * 2 ** attempt + Math.random() * 400, 15000);
}

function rateLimitCooldown(response: Response) {
  const remaining = response.headers.get("x-ratelimit-remaining") ?? response.headers.get("x-rate-limit-remaining");
  if (remaining === null || Number(remaining) > 2) return;
  const reset = response.headers.get("x-ratelimit-reset") ?? response.headers.get("x-rate-limit-reset");
  const resetNumber = Number(reset);
  const resetAt = resetNumber > 1e9 ? resetNumber * 1000 : Date.now() + (resetNumber || 2) * 1000;
  nextRequestAt = Math.max(nextRequestAt, Math.min(resetAt, Date.now() + 60000));
}

async function getPage(url: URL, resource: FubResource): Promise<Record<string, unknown>> {
  if (url.origin !== BASE.origin || url.pathname !== `${BASE.pathname}${resource}`) {
    throw new FubReadError(resource, null, "Unsafe pagination link rejected.");
  }
  if (!fubCredentialsConfigured()) throw new FubReadError(resource, null, "FUB credentials are not configured.");
  await acquire();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(Math.max(0, nextRequestAt - Date.now()));
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64")}`,
            "X-System": process.env.FUB_X_SYSTEM!,
            "X-System-Key": process.env.FUB_X_SYSTEM_KEY!,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        logger.warn({ method: "GET", path: `/${resource}`, status: null, durationMs: Date.now() - started }, "FUB read transport failure");
        if (attempt === 3) throw new FubReadError(resource, null, "FUB request timed out or could not connect.");
        await sleep(retryDelay(null, attempt));
        continue;
      }
      logger.info({ method: "GET", path: `/${resource}`, status: response.status, durationMs: Date.now() - started }, "FUB read");
      rateLimitCooldown(response);
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < 3) {
          await sleep(retryDelay(response, attempt));
          continue;
        }
      }
      if (!response.ok) {
        let detail = `FUB returned HTTP ${response.status}. Check API permissions or registration; no response body was retained.`;
        if (response.status === 401) {
          // Classify provider errors, but never retain or log arbitrary response text.
          const failureText = await response.text().catch(() => "");
          if (/invalid api key|api key is invalid|invalid api token/i.test(failureText)) {
            detail = "FUB explicitly rejected the API key (HTTP 401). Replace it with a current admin-level API key through Replit Secrets.";
          } else if (/x-system|system.?key|system registration/i.test(failureText)) {
            detail = "FUB rejected the registered system credentials (HTTP 401). Verify X-System and X-System-Key through Replit Secrets.";
          } else {
            detail = "FUB authentication was rejected (HTTP 401). Verify the current admin API key and the registered system credentials through Replit Secrets.";
          }
        }
        throw new FubReadError(resource, response.status, detail);
      }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new FubReadError(resource, response.status, "Unexpected FUB response shape.");
      }
      return result as Record<string, unknown>;
    }
    throw new FubReadError(resource, null, "FUB retry limit reached.");
  } finally {
    release();
  }
}

export async function readSample(resource: FubResource, maximum: number) {
  let url: URL | null = new URL(resource, BASE);
  url.searchParams.set("limit", String(Math.min(100, maximum)));
  if (resource === "people") url.searchParams.set("fields", "allFields");
  const rows: FubRecord[] = [];
  const seen = new Set<string>();
  let truncated = false;
  while (url && rows.length < maximum) {
    if (seen.has(url.href)) throw new FubReadError(resource, null, "Repeated pagination link rejected.");
    seen.add(url.href);
    const page = await getPage(url, resource);
    // FUB's camel-cased customFields endpoint has a lowercase JSON collection.
    const collectionKey = resource === "customFields" ? "customfields" : resource;
    if (!Array.isArray(page[collectionKey])) {
      throw new FubReadError(resource, null, `FUB response did not contain the expected ${collectionKey} array.`);
    }
    const items = page[collectionKey] as unknown[];
    if (items.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new FubReadError(resource, null, "FUB returned an invalid record shape.");
    }
    const remainingCapacity = maximum - rows.length;
    rows.push(...(items as FubRecord[]).slice(0, remainingCapacity));
    const metadata = page._metadata as { nextLink?: unknown } | undefined;
    const next = metadata?.nextLink;
    if (next != null && typeof next !== "string") throw new FubReadError(resource, null, "Invalid pagination metadata.");
    truncated = !!next || items.length > remainingCapacity;
    url = typeof next === "string" && next ? new URL(next, BASE) : null;
  }
  return { rows, truncated };
}