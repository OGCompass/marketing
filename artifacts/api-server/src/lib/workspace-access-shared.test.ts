import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntheticAccessReplica, SyntheticAdmissionAuthority } from "./workspace-access-shared.fixture";
import { WorkspaceAccessLimiter, type AccessLimits } from "./workspace-access-limits";
import type { WorkspaceAccessPolicyOptions, WorkspaceIdentity } from "./workspace-access-policy";

const limits: AccessLimits = {
  burst: 6, refillMs: 1000, maxConcurrent: 2,
  maxConcurrentPerPrincipal: 1, maxPrincipals: 10, retrySeconds: 1,
};
const identity = (id: string): WorkspaceIdentity => ({
  id, banned: false, locked: false, primaryEmailAddressId: "primary",
  emailAddresses: [{
    id: "primary", emailAddress: "approved@example.test", verification: { status: "verified" },
  }],
});
const request = (id = "fixture-a"): WorkspaceAccessPolicyOptions => ({
  userId: id, authorizedUserIds: id, lookupIdentity: async () => identity(id),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const denial = (status: 429 | 503) => ({
  authorized: false, unavailable: true, retryStatus: status, retryAfterSeconds: 1,
});

test("control fixture demonstrates why independent process limits cannot be scaled", async () => {
  const locals = [new WorkspaceAccessLimiter(limits, () => 0), new WorkspaceAccessLimiter(limits, () => 0)];
  for (const local of locals) {
    for (let i = 0; i < limits.burst; i++) assert.equal((await local.evaluate(request())).authorized, true);
    assert.equal((await local.evaluate(request())).retryStatus, 429);
  }
  // A restart creates another full allowance under the current live implementation.
  assert.equal((await new WorkspaceAccessLimiter(limits, () => 0).evaluate(request())).authorized, true);
});

test("one authority limits alternating replicas and retains depleted budgets after API restarts", async () => {
  let now = 0;
  let calls = 0;
  const authority = new SyntheticAdmissionAuthority(limits, () => now);
  let replicas = [new SyntheticAccessReplica(authority), new SyntheticAccessReplica(authority)];
  const options = { ...request(), lookupIdentity: async (id: string) => { calls++; return identity(id); } };
  for (let i = 0; i < limits.burst; i++) {
    assert.equal((await replicas[i % 2].evaluate(options)).authorized, true);
  }
  replicas = Array.from({ length: 5 }, () => new SyntheticAccessReplica(authority));
  const flood = await Promise.all(Array.from({ length: 100 }, (_, i) => replicas[i % 5].evaluate(options)));
  for (const result of flood) assert.deepEqual(result, denial(429));
  assert.equal(calls, limits.burst);
  assert.equal((await replicas[0].evaluate(request("fixture-b"))).authorized, true);
  now = 999;
  assert.deepEqual(await replicas[1].evaluate(options), denial(429));
  now = 1000;
  assert.equal((await replicas[4].evaluate(options)).authorized, true);
  assert.deepEqual(await replicas[0].evaluate(options), denial(429));
  assert.equal(calls, limits.burst + 1);
});

test("simultaneous multi-replica debits cannot overspend the shared burst", async () => {
  const authority = new SyntheticAdmissionAuthority({
    ...limits, maxConcurrent: 20, maxConcurrentPerPrincipal: 20,
  }, () => 0);
  const replicas = Array.from({ length: 8 }, () => new SyntheticAccessReplica(authority));
  const results = await Promise.all(Array.from({ length: 48 }, (_, i) => replicas[i % 8].evaluate(request())));
  assert.equal(results.filter((result) => result.authorized).length, limits.burst);
  assert.equal(results.filter((result) => result.retryStatus === 429).length, 48 - limits.burst);
});

test("provider permits remain shared and occupied during replica replacement and release on settlement", async () => {
  const authority = new SyntheticAdmissionAuthority(limits, () => 0);
  const replicaA = new SyntheticAccessReplica(authority);
  const replicaB = new SyntheticAccessReplica(authority);
  const a = deferred<WorkspaceIdentity>();
  const b = deferred<WorkspaceIdentity>();
  const first = replicaA.evaluate({ ...request("a"), lookupIdentity: () => a.promise });
  const second = replicaB.evaluate({ ...request("b"), lookupIdentity: () => b.promise });
  const replacement = new SyntheticAccessReplica(authority);
  assert.deepEqual(await replacement.evaluate(request("a")), denial(429));
  assert.deepEqual(await replacement.evaluate(request("c")), denial(503));
  a.reject(new Error("Synthetic provider failure"));
  assert.deepEqual(await first, { authorized: false, unavailable: true });
  assert.equal((await replacement.evaluate(request("c"))).authorized, true);
  b.resolve(identity("b"));
  assert.equal((await second).authorized, true);
  assert.equal((await replacement.evaluate(request("b"))).authorized, true);
});

test("authority outage never falls back locally or calls the identity provider", async () => {
  const authority = new SyntheticAdmissionAuthority(limits, () => 0);
  const replica = new SyntheticAccessReplica(authority);
  for (let i = 0; i < limits.burst; i++) await replica.evaluate(request());
  authority.available = false;
  const offline = { ...request("b"), lookupIdentity: async (): Promise<WorkspaceIdentity> => {
    assert.fail("Provider called while authority unavailable");
  } };
  assert.deepEqual(await new SyntheticAccessReplica(authority).evaluate(offline), denial(503));
  // Model an outage between debit and provider acquire, not just before debit.
  authority.available = true;
  assert.equal(authority.debit("b"), undefined);
  authority.available = false;
  assert.deepEqual(authority.acquire("b"), denial(503));
  authority.available = true;
  assert.deepEqual(await replica.evaluate(request()), denial(429));
  assert.equal((await replica.evaluate(request("b"))).authorized, true);
  assert.deepEqual(await replica.evaluate({ ...offline, userId: null }), {
    authorized: false, unavailable: false,
  });
});

test("shared counters cannot cache a grant across replicas or API restarts", async () => {
  const authority = new SyntheticAdmissionAuthority({ ...limits, burst: 20 }, () => 0);
  for (const changed of [
    { banned: true }, { locked: true },
    { emailAddresses: [{ id: "primary", emailAddress: "changed@example.test", verification: { status: "verified" } }] },
  ]) {
    let lookups = 0;
    const options = {
      ...request(), authorizedUserIds: "", authorizedEmails: "approved@example.test",
      lookupIdentity: async (id: string) => { lookups++; return identity(id); },
    };
    assert.equal((await new SyntheticAccessReplica(authority).evaluate(options)).authorized, true);
    const revoked = await new SyntheticAccessReplica(authority).evaluate({
      ...options, lookupIdentity: async (id) => { lookups++; return { ...identity(id), ...changed }; },
    });
    assert.equal(revoked.authorized, false);
    assert.equal(lookups, 2);
  }
  const replacement = new SyntheticAccessReplica(authority);
  assert.equal((await replacement.evaluate(request())).authorized, true);
  assert.equal((await replacement.evaluate({ ...request(), authorizedUserIds: "" })).authorized, false);
  assert.deepEqual(await replacement.evaluate({
    ...request(), lookupIdentity: async () => { throw new Error("Synthetic provider outage"); },
  }), { authorized: false, unavailable: true });
});

test("tracking stays bounded without evicting depleted or active entries; releases are idempotent", () => {
  let now = 0;
  const authority = new SyntheticAdmissionAuthority({
    ...limits, burst: 1, maxPrincipals: 1,
  }, () => now);
  assert.equal(authority.debit("a"), undefined);
  const permit = authority.acquire("a");
  assert.ok("release" in permit);
  assert.equal(authority.debit("b")?.retryStatus, 503);
  now = 1000;
  assert.equal(authority.debit("b")?.retryStatus, 503); // Refilled but still active.
  permit.release();
  permit.release();
  assert.equal(authority.debit("b"), undefined);
  const second = authority.acquire("b");
  assert.ok("release" in second);
  assert.deepEqual(authority.acquire("b"), denial(429)); // Duplicate release did not undercount.
  second.release();
});

test("authority clock rollback cannot replenish a principal twice", () => {
  let now = 0;
  const authority = new SyntheticAdmissionAuthority({ ...limits, burst: 1 }, () => now);
  assert.equal(authority.debit("a"), undefined);
  now = 500;
  assert.equal(authority.debit("a")?.retryStatus, 429);
  now = 0;
  assert.equal(authority.debit("a")?.retryStatus, 429);
  now = 500;
  assert.equal(authority.debit("a")?.retryStatus, 429);
  now = 1000;
  assert.equal(authority.debit("a"), undefined);
});