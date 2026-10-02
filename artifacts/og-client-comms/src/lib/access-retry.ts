// Cooldowns are request scheduling only, never cached authorization decisions.
type HttpError = { status: number; headers: Headers };
const deadlines = new WeakMap<object, number>();

export function isTemporaryAccessError(error: unknown): error is HttpError {
  return !!error && typeof error === "object" && "status" in error &&
    (error.status === 429 || error.status === 503);
}

export function accessRetryAt(error: unknown, now = Date.now()): number {
  if (!isTemporaryAccessError(error)) return 0;
  const existing = deadlines.get(error);
  if (existing !== undefined) return existing;
  const header = error.headers?.get("Retry-After")?.trim();
  const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
  // Date.parse also accepts values like "-1"; those are not HTTP dates.
  const date = header && /^[A-Za-z]{3,9}[,\s]/.test(header) ? Date.parse(header) : NaN;
  const deadline = Number.isFinite(seconds * 1000) ? now + seconds * 1000
    : Number.isFinite(date) ? Math.max(now, date) : now + 5000;
  deadlines.set(error, deadline);
  return deadline;
}

export function shouldRetryAccess(failureCount: number, error: unknown): boolean {
  // Never retry authentication/permission errors automatically.
  return failureCount < 2 && (isTemporaryAccessError(error) || error instanceof TypeError);
}

export function accessRetryDelay(attempt: number, error: unknown): number {
  return isTemporaryAccessError(error)
    ? Math.min(2_147_483_647, Math.max(0, accessRetryAt(error) - Date.now()))
    : Math.min(1000 * 2 ** attempt, 5000);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Access check cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, Math.min(ms, 2_147_483_647));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class AccessCooldown {
  private retryAt = 0;

  async run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Recheck after each timer so very long server delays cannot overflow.
    while (this.retryAt > Date.now()) await wait(this.retryAt - Date.now(), signal);
    if (signal?.aborted) throw new DOMException("Access check cancelled", "AbortError");
    try {
      return await request();
    } catch (error) {
      this.retryAt = Math.max(this.retryAt, accessRetryAt(error));
      throw error;
    }
  }
}

const cooldowns = new WeakMap<object, Map<string, AccessCooldown>>();
export function getAccessCooldown(client: object, userId: string): AccessCooldown {
  let users = cooldowns.get(client);
  if (!users) {
    users = new Map();
    cooldowns.set(client, users);
  }
  let cooldown = users.get(userId);
  if (!cooldown) {
    cooldown = new AccessCooldown();
    users.set(userId, cooldown);
  }
  return cooldown;
}