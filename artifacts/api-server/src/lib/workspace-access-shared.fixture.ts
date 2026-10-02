/**
 * Synthetic reference model only. NOT a distributed backend or production fallback.
 * All replicas consult one authority; operations are atomic in this synchronous
 * model. A real implementation requires approved infrastructure and transactions.
 * Stores counters/opaque permits only, never identity responses or access grants.
 */
import type { AccessLimits, LimitedAccessDecision } from "./workspace-access-limits";
import { evaluateWorkspaceAccess, type WorkspaceAccessPolicyOptions } from "./workspace-access-policy";

type Denial = LimitedAccessDecision & { authorized: false; retryStatus: 429 | 503 };
type Permit = { release: () => void };
type Bucket = { tokens: number; updatedAt: number; active: number };

export class SyntheticAdmissionAuthority {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  available = true;

  constructor(private readonly limits: AccessLimits, private readonly clock: () => number) {}

  private deny(status: 429 | 503, seconds = this.limits.retrySeconds): Denial {
    return {
      authorized: false, unavailable: true, retryStatus: status,
      retryAfterSeconds: Math.max(1, Math.ceil(seconds)),
    };
  }

  debit(principal: string): Denial | undefined {
    if (!this.available) return this.deny(503);
    const now = this.clock();
    let bucket = this.buckets.get(principal);
    if (!bucket) {
      if (this.buckets.size >= this.limits.maxPrincipals) {
        for (const [key, entry] of this.buckets) {
          if (!entry.active &&
              now - entry.updatedAt >= (this.limits.burst - entry.tokens) * this.limits.refillMs) {
            this.buckets.delete(key);
          }
        }
      }
      if (this.buckets.size >= this.limits.maxPrincipals) {
        return this.deny(503, this.limits.burst * this.limits.refillMs / 1000);
      }
      bucket = { tokens: this.limits.burst, updatedAt: now, active: 0 };
      this.buckets.set(principal, bucket);
    }
    bucket.tokens = Math.min(this.limits.burst,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) / this.limits.refillMs);
    // An authority clock moving backwards must not create extra refill later.
    bucket.updatedAt = Math.max(bucket.updatedAt, now);
    if (bucket.tokens < 1) return this.deny(429, (1 - bucket.tokens) * this.limits.refillMs / 1000);
    bucket.tokens--;
    return undefined;
  }

  acquire(principal: string): Permit | Denial {
    if (!this.available) return this.deny(503);
    const bucket = this.buckets.get(principal);
    if (!bucket) return this.deny(503);
    if (bucket.active >= this.limits.maxConcurrentPerPrincipal) return this.deny(429);
    if (this.active >= this.limits.maxConcurrent) return this.deny(503);
    bucket.active++;
    this.active++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      bucket.active--;
      this.active--;
    } };
  }
}

/** A replica owns no admission state; rebuilding it models an API restart. */
export class SyntheticAccessReplica {
  constructor(private readonly authority: SyntheticAdmissionAuthority) {}

  async evaluate(options: WorkspaceAccessPolicyOptions): Promise<LimitedAccessDecision> {
    if (!options.userId) return evaluateWorkspaceAccess(options);
    const rejected = this.authority.debit(options.userId);
    if (rejected) return rejected;
    let busy: Denial | undefined;
    const decision = await evaluateWorkspaceAccess({
      ...options,
      lookupIdentity: async (principal) => {
        const permit = this.authority.acquire(principal);
        if (!("release" in permit)) {
          busy = permit;
          throw new Error("Synthetic admission refused.");
        }
        try {
          return await options.lookupIdentity(principal);
        } finally {
          permit.release();
        }
      },
    });
    return busy ?? decision;
  }
}