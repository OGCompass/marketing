import { performance } from "node:perf_hooks";
import {
  evaluateWorkspaceAccess,
  type WorkspaceAccessDecision,
  type WorkspaceAccessPolicyOptions,
} from "./workspace-access-policy";

export interface AccessLimits {
  burst: number;
  refillMs: number;
  maxConcurrent: number;
  maxConcurrentPerPrincipal: number;
  maxPrincipals: number;
  retrySeconds: number;
}

export function accessLimitsFromEnv(env: NodeJS.ProcessEnv): AccessLimits {
  const integer = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`${key} must be a positive safe integer.`);
    }
    return Number(raw);
  };
  return {
    burst: integer("OG_ACCESS_BURST", 60),
    refillMs: integer("OG_ACCESS_REFILL_MS", 1000),
    maxConcurrent: integer("OG_ACCESS_MAX_CONCURRENT", 8),
    maxConcurrentPerPrincipal: integer("OG_ACCESS_MAX_CONCURRENT_PER_PRINCIPAL", 2),
    maxPrincipals: integer("OG_ACCESS_MAX_PRINCIPALS", 10000),
    retrySeconds: integer("OG_ACCESS_RETRY_SECONDS", 1),
  };
}

export type LimitedAccessDecision = WorkspaceAccessDecision & {
  retryStatus?: 429 | 503;
  retryAfterSeconds?: number;
};

type Bucket = { tokens: number; updatedAt: number; active: number };

/**
 * Process-local admission control, not an authorization/identity cache.
 * No queue: busy lookups fail closed immediately. A permit stays occupied
 * until the actual provider promise settles, even if the HTTP client leaves.
 */
export class WorkspaceAccessLimiter {
  private readonly principals = new Map<string, Bucket>();
  private active = 0;

  constructor(
    private readonly limits: AccessLimits,
    private readonly now: () => number = () => performance.now(),
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("Access limits must be positive safe integers.");
      }
    }
  }

  async evaluate(options: WorkspaceAccessPolicyOptions): Promise<LimitedAccessDecision> {
    if (!options.userId) return evaluateWorkspaceAccess(options);
    const now = this.now();
    let bucket = this.principals.get(options.userId);
    if (!bucket) {
      // Only remove fully replenished, idle entries. Eviction must never
      // reset a depleted principal's allowance or forget an active lookup.
      if (this.principals.size >= this.limits.maxPrincipals) {
        for (const [id, candidate] of this.principals) {
          if (candidate.active === 0 &&
              now - candidate.updatedAt >=
                (this.limits.burst - candidate.tokens) * this.limits.refillMs) {
            this.principals.delete(id);
          }
        }
      }
      if (this.principals.size >= this.limits.maxPrincipals) {
        return this.retry(503, Math.ceil(this.limits.burst * this.limits.refillMs / 1000));
      }
      bucket = { tokens: this.limits.burst, updatedAt: now, active: 0 };
      this.principals.set(options.userId, bucket);
    }
    bucket.tokens = Math.min(this.limits.burst,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) / this.limits.refillMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return this.retry(429, Math.ceil((1 - bucket.tokens) * this.limits.refillMs / 1000));
    }
    bucket.tokens--;
    const principal = bucket;
    let busyStatus: 429 | 503 | undefined;
    // Reserve provider slots only when policy actually needs an identity.
    const decision = await evaluateWorkspaceAccess({
      ...options,
      lookupIdentity: async (id) => {
        if (principal.active >= this.limits.maxConcurrentPerPrincipal) {
          busyStatus = 429;
          throw new Error("Principal identity lookup capacity exhausted.");
        }
        if (this.active >= this.limits.maxConcurrent) {
          busyStatus = 503;
          throw new Error("Global identity lookup capacity exhausted.");
        }
        this.active++;
        principal.active++;
        try {
          return await options.lookupIdentity(id);
        } finally {
          this.active--;
          principal.active--;
        }
      },
    });
    return busyStatus ? this.retry(busyStatus, this.limits.retrySeconds) : decision;
  }

  private retry(status: 429 | 503, seconds: number): LimitedAccessDecision {
    return {
      authorized: false, unavailable: true,
      retryStatus: status, retryAfterSeconds: Math.max(1, seconds),
    };
  }
}