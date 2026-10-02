import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { GetFieldInventoryResponse, DiscoverFubFieldsResponse } from "@workspace/api-zod";
import { getApprovalDatabasePool, type DatabaseClient } from "../approval-database";
import { withApprovalSourceTransaction } from "../approval-source-lock";
import { workspaceRoot } from "../workspace-root";
import { discoverInventory, type InventoryReport } from "./inventory";
export type { InventoryReport } from "./inventory";

const INVENTORY_ID = "current-masked-inventory";
let running = false;
const reportDirectory = () => join(workspaceRoot(), "reports");
type InventoryQueryable = { query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

async function readActiveInventory(queryable: InventoryQueryable): Promise<InventoryReport | null> {
  const result = await queryable.query<{ report: unknown }>(
    "SELECT report FROM masked_inventory_source WHERE id = $1",
    [INVENTORY_ID],
  );
  if (!result.rows[0]) return null;
  return GetFieldInventoryResponse.parse({ report: result.rows[0].report }).report as InventoryReport;
}

export async function latestInventory(queryable?: InventoryQueryable): Promise<InventoryReport | null> {
  if (queryable) return readActiveInventory(queryable);
  const pool = await getApprovalDatabasePool();
  return readActiveInventory(pool);
}

async function publishFilesystemMirror(report: InventoryReport): Promise<void> {
  const directory = reportDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const reportTemporary = join(directory, `field_inventory.${nonce}.json.tmp`);
  const markdownTemporary = join(directory, `field_inventory.${nonce}.md.tmp`);
  await writeFile(reportTemporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(markdownTemporary, report.markdown, { mode: 0o600 });
  await rename(reportTemporary, join(directory, "field_inventory.json"));
  await rename(markdownTemporary, join(directory, "field_inventory.md"));
}

export async function runDiscovery(): Promise<InventoryReport> {
  if (running) throw new Error("DISCOVERY_RUNNING");
  running = true;
  let client: DatabaseClient | null = null;
  try {
    const pool = await getApprovalDatabasePool();
    client = await pool.connect();
    let published: InventoryReport | null = null;
    await withApprovalSourceTransaction(client, async () => {
      // Source is read only after the same transaction lock used by approval commits.
      const prior = await readActiveInventory(client!);
      const report = DiscoverFubFieldsResponse.parse(await discoverInventory());
      const revalidated = await readActiveInventory(client!);
      if ((prior ? reportFingerprint(prior) : null) !== (revalidated ? reportFingerprint(revalidated) : null)) {
        throw new Error("MASKED_SOURCE_CHANGED_DURING_PUBLICATION");
      }
      await publishFilesystemMirror(report);
      await client!.query(
        "INSERT INTO masked_inventory_source (id, source_version, report, published_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (id) DO UPDATE SET source_version = EXCLUDED.source_version, report = EXCLUDED.report, published_at = EXCLUDED.published_at",
        [INVENTORY_ID, reportFingerprint(report), JSON.stringify(report)],
      );
      const current = await readActiveInventory(client!);
      if (!current || reportFingerprint(current) !== reportFingerprint(report)) {
        throw new Error("MASKED_SOURCE_CHANGED_DURING_PUBLICATION");
      }
      published = current;
    });
    return published!;
  } finally {
    client?.release();
    running = false;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function reportFingerprint(report: InventoryReport): string {
  return createHash("sha256").update(canonical(report)).digest("hex");
}