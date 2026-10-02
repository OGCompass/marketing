import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  WorkspaceAccessLimiter, accessLimitsFromEnv, type AccessLimits,
} from "./workspace-access-limits";
import type { WorkspaceAccessPolicyOptions, WorkspaceIdentity } from "./workspace-access-policy";
import { createWorkspaceAccessHandlers } from "../middlewares/workspace-access-handlers";

const defaults: AccessLimits = {
  burst: 6, refillMs: 1000, maxConcurrent: 4,
  maxConcurrentPerPrincipal: 2, maxPrincipals: 10, retrySeconds: 1,
};
function identity(id: string, overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return {
    id, banned: false, locked: false, primaryEmailAddressId: "primary",
    emailAddresses: [{
      id: "primary", emailAddress: "approved@example.test", verification: { status: "verified" },
    }],
    ...overrides,
  };
}
function options(id = "fixture-a"): WorkspaceAccessPolicyOptions {
  return {
    userId: id, authorizedEmails: "approved@example.test",
    lookupIdentity: async (userId) => identity(userId),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("configuration uses safe defaults and rejects invalid values rather than disabling limits", () => {
  assert.equal(accessLimitsFromEnv({}).burst, 60);
  assert.equal(accessLimitsFromEnv({ OG_ACCESS_BURST: "12" }).burst, 12);
  for (const key of [
    "OG_ACCESS_BURST", "OG_ACCESS_REFILL_MS", "OG_ACCESS_MAX_CONCURRENT",
    "OG_ACCESS_MAX_CONCURRENT_PER_PRINCIPAL", "OG_ACCESS_MAX_PRINCIPALS", "OG_ACCESS_RETRY_SECONDS",
  ]) {
    for (const value of ["0", "-1", "NaN", "1.5", "", "Infinity", "9007199254740992"]) {
      assert.throws(() => accessLimitsFromEnv({ [key]: value }), /positive safe integer/);
    }
  }
});

test("legitimate bursts remain fresh; abusive repeats skip the provider and recover with time", async () => {
  let now = 0;
  let lookups = 0;
  const limiter = new WorkspaceAccessLimiter(defaults, () => now);
  const request = { ...options(), lookupIdentity: async (id: string) => {
    lookups++;
    return identity(id);
  } };
  for (let i = 0; i < defaults.burst; i++) {
    assert.equal((await limiter.evaluate(request)).authorized, true);
  }
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(await limiter.evaluate(request), {
      authorized: false, unavailable: true, retryStatus: 429, retryAfterSeconds: 1,
    });
  }
  assert.equal(lookups, defaults.burst);
  assert.equal((await limiter.evaluate(options("fixture-b"))).authorized, true);
  now = 999;
  assert.equal((await limiter.evaluate(request)).retryStatus, 429);
  now = 1000;
  assert.equal((await limiter.evaluate(request)).authorized, true);
  assert.equal(lookups, defaults.burst + 1);
  assert.equal((await limiter.evaluate(request)).retryStatus, 429);
});

test("per-principal concurrency leaves capacity for teammates and does not coalesce identities", async () => {
  const limiter = new WorkspaceAccessLimiter(defaults);
  const pending = deferred<WorkspaceIdentity>();
  let calls = 0;
  const request = { ...options(), lookupIdentity: () => { calls++; return pending.promise; } };
  const first = limiter.evaluate(request);
  const second = limiter.evaluate(request);
  assert.equal((await limiter.evaluate(request)).retryStatus, 429);
  assert.equal(calls, 2);
  assert.equal((await limiter.evaluate(options("fixture-b"))).authorized, true);
  pending.resolve(identity("fixture-a"));
  assert.equal((await first).authorized, true);
  assert.equal((await second).authorized, true);
});

test("global capacity is bounded with no queued provider work; permits release after failures", async () => {
  const limiter = new WorkspaceAccessLimiter({ ...defaults, maxConcurrent: 2 });
  const a = deferred<WorkspaceIdentity>();
  const b = deferred<WorkspaceIdentity>();
  const first = limiter.evaluate({ ...options("a"), lookupIdentity: () => a.promise });
  const second = limiter.evaluate({ ...options("b"), lookupIdentity: () => b.promise });
  let rejectedCalls = 0;
  const third = await limiter.evaluate({
    ...options("c"), lookupIdentity: async (id) => { rejectedCalls++; return identity(id); },
  });
  assert.equal(third.authorized, false);
  assert.equal(third.retryStatus, 503);
  assert.equal(rejectedCalls, 0);
  a.reject(new Error("Synthetic provider outage"));
  assert.deepEqual(await first, { authorized: false, unavailable: true });
  assert.equal((await limiter.evaluate(options("c"))).authorized, true);
  b.resolve(identity("b"));
  assert.equal((await second).authorized, true);
});

test("bounded principal tracking cannot evict depleted or active entries to bypass limits", async () => {
  let now = 0;
  const limiter = new WorkspaceAccessLimiter({
    ...defaults, burst: 1, maxPrincipals: 1,
  }, () => now);
  const pending = deferred<WorkspaceIdentity>();
  const first = limiter.evaluate({ ...options("a"), lookupIdentity: () => pending.promise });
  now = 2000; // A full bucket alone is insufficient while a lookup is still active.
  assert.equal((await limiter.evaluate(options("b"))).retryStatus, 503);
  pending.resolve(identity("a"));
  await first;
  assert.equal((await limiter.evaluate(options("b"))).authorized, true);
  assert.equal((await limiter.evaluate(options("a"))).retryStatus, 503);
  assert.equal((await limiter.evaluate(options("b"))).retryStatus, 429);
  now = 3000;
  assert.equal((await limiter.evaluate(options("a"))).authorized, true);
});

test("limits never reuse a grant: bans, locks, primary email and approvals revoke on next request", async () => {
  for (const change of [
    { banned: true }, { locked: true },
    { emailAddresses: [{ id: "primary", emailAddress: "changed@example.test", verification: { status: "verified" } }] },
  ]) {
    const limiter = new WorkspaceAccessLimiter(defaults);
    let calls = 0;
    const request = { ...options(), lookupIdentity: async (id: string) => {
      calls++;
      return identity(id, calls === 1 ? {} : change);
    } };
    assert.equal((await limiter.evaluate(request)).authorized, true);
    assert.equal((await limiter.evaluate(request)).authorized, false);
    assert.equal(calls, 2);
  }
  const limiter = new WorkspaceAccessLimiter(defaults);
  assert.equal((await limiter.evaluate(options())).authorized, true);
  assert.equal((await limiter.evaluate({ ...options(), authorizedEmails: "" })).authorized, false);
  const idApproved = { ...options(), authorizedEmails: "", authorizedUserIds: "fixture-a" };
  assert.equal((await limiter.evaluate(idApproved)).authorized, true);
  assert.equal((await limiter.evaluate({
    ...idApproved, lookupIdentity: async (id) => identity(id, { banned: true }),
  })).authorized, false);
  assert.deepEqual(await limiter.evaluate({
    ...idApproved, lookupIdentity: async () => { throw new Error("Provider unavailable"); },
  }), { authorized: false, unavailable: true });
});

test("anonymous, default-denied and malformed-policy requests do not use provider capacity", async () => {
  const limiter = new WorkspaceAccessLimiter(defaults);
  const request = { ...options(), lookupIdentity: async (): Promise<WorkspaceIdentity> => {
    assert.fail("Unexpected provider lookup");
  } };
  assert.deepEqual(await limiter.evaluate({ ...request, userId: null }),
    { authorized: false, unavailable: false });
  assert.deepEqual(await limiter.evaluate({ ...request, authorizedEmails: "" }),
    { authorized: false, unavailable: false });
  assert.deepEqual(await limiter.evaluate({ ...request, authorizedEmails: "invalid" }),
    { authorized: false, unavailable: true });
});

test("HTTP fixtures share status/private budgets, deny safely, and leave public paths unaffected", async () => {
  // This fixture injects authenticated principals; no live Clerk/FUB calls or credentials.
  let now = 0;
  let failProvider = false;
  let banned = false;
  let lookups = 0;
  let privateRuns = 0;
  const handlers = createWorkspaceAccessHandlers({
    userId: (req) => req.headers["x-fixture-principal"] as string ?? null,
    approvals: () => ({ authorizedEmails: "approved@example.test" }),
    lookupIdentity: async (id) => {
      lookups++;
      if (failProvider) throw new Error("Synthetic outage");
      return identity(id, { banned });
    },
    limiter: new WorkspaceAccessLimiter({ ...defaults, burst: 3 }, () => now),
  });
  const app = express();
  app.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/clerk-fixture", (_req, res) => { res.sendStatus(204); });
  app.use(["/workspace", "/inventory", "/program"], handlers.requireWorkspaceSignIn);
  app.get("/workspace/access", handlers.respondWorkspaceAccess);
  app.use(["/workspace/status", "/inventory", "/program"], handlers.requireWorkspaceAccess);
  for (const path of ["/workspace/status", "/inventory", "/program/blueprint"]) {
    app.get(path, (_req, res) => { privateRuns++; res.json({ private: true }); });
  }
  app.post("/inventory/discover", (_req, res) => { privateRuns++; res.json({ private: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, principal: string | null = "a") => fetch(url + path, {
    headers: principal ? { "x-fixture-principal": principal } : {},
  });
  try {
    const unsigned = await get("/workspace/access", null);
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.headers.get("cache-control"), "no-store");
    assert.equal(lookups, 0);
    assert.equal((await get("/workspace/access")).status, 200);
    assert.equal((await get("/inventory")).status, 200);
    assert.equal((await get("/program/blueprint")).status, 200);
    for (const path of ["/workspace/access", "/workspace/status", "/inventory", "/program/blueprint"]) {
      const response = await get(path);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "1");
      const body = await response.json() as { authorized?: boolean; error: string };
      if (path === "/workspace/access") assert.equal(body.authorized, false);
      else assert.match(body.error, /retry/i);
    }
    assert.equal(privateRuns, 2);
    assert.equal(lookups, 3);
    const discovery = await fetch(url + "/inventory/discover", {
      method: "POST", headers: { "x-fixture-principal": "a" },
    });
    assert.equal(discovery.status, 429);
    assert.equal(discovery.headers.get("cache-control"), "no-store");
    assert.equal(privateRuns, 2);
    assert.equal((await get("/inventory", "b")).status, 200);
    assert.equal((await get("/healthz")).status, 200);
    assert.equal((await get("/clerk-fixture")).status, 204);
    now = 3000;
    banned = true;
    assert.equal((await get("/inventory")).status, 403);
    banned = false;
    failProvider = true;
    for (const path of ["/workspace/access", "/inventory"]) {
      const response = await get(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "1");
      const body = await response.json() as { authorized?: boolean; error: string };
      if (path === "/workspace/access") assert.equal(body.authorized, false);
    }
    now = 6000;
    failProvider = false;
    assert.equal((await get("/inventory")).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP capacity responses include retry headers and never reach private handlers", async () => {
  const pending = deferred<WorkspaceIdentity>();
  const entered = deferred<void>();
  let calls = 0;
  let privateRuns = 0;
  const handlers = createWorkspaceAccessHandlers({
    userId: (req) => req.headers["x-fixture-principal"] as string ?? null,
    approvals: () => ({ authorizedEmails: "approved@example.test" }),
    lookupIdentity: () => { calls++; entered.resolve(); return pending.promise; },
    limiter: new WorkspaceAccessLimiter({
      ...defaults, maxConcurrent: 1, maxConcurrentPerPrincipal: 1,
    }),
  });
  const app = express();
  app.use(handlers.requireWorkspaceSignIn);
  app.get("/access", handlers.respondWorkspaceAccess);
  app.get("/private", handlers.requireWorkspaceAccess, (_req, res) => {
    privateRuns++;
    res.sendStatus(200);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, principal: string) => fetch(url + path, {
    headers: { "x-fixture-principal": principal },
  });
  const first = get("/access", "a");
  try {
    await entered.promise;
    for (const path of ["/access", "/private"]) {
      for (const [principal, status] of [["a", 429], ["b", 503]] as const) {
        const response = await get(path, principal);
        assert.equal(response.status, status);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("retry-after"), "1");
        if (path === "/access") {
          const body = await response.json() as { authorized: boolean; reason: string };
          assert.equal(body.authorized, false);
          assert.match(body.reason, /retry/i);
        }
      }
    }
    assert.equal(calls, 1);
    assert.equal(privateRuns, 0);
    pending.resolve(identity("a"));
    assert.equal((await first).status, 200);
  } finally {
    pending.resolve(identity("a"));
    await first;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("private requests expose reviewer authority only for a verified configured primary email", async () => {
  const identities: Record<string, WorkspaceIdentity> = {
    cassandra: identity("cassandra", {
      primaryEmailAddressId: "primary",
      emailAddresses: [{
        id: "primary", emailAddress: "cassandra@example.test",
        verification: { status: "verified" },
      }],
    }),
    caitlin: identity("caitlin", {
      primaryEmailAddressId: "primary",
      emailAddresses: [{
        id: "primary", emailAddress: "caitlin@example.test",
        verification: { status: "verified" },
      }],
    }),
    secondary: identity("secondary", {
      primaryEmailAddressId: "primary",
      emailAddresses: [
        { id: "primary", emailAddress: "member@example.test", verification: { status: "verified" } },
        { id: "secondary", emailAddress: "cassandra@example.test", verification: { status: "verified" } },
      ],
    }),
    unverified: identity("unverified", {
      primaryEmailAddressId: "primary",
      emailAddresses: [{
        id: "primary", emailAddress: "caitlin@example.test",
        verification: { status: "unverified" },
      }],
    }),
    nonReviewer: identity("nonReviewer", {
      primaryEmailAddressId: "primary",
      emailAddresses: [{
        id: "primary", emailAddress: "member@example.test",
        verification: { status: "verified" },
      }],
    }),
    idOnly: identity("idOnly", { primaryEmailAddressId: null, emailAddresses: [] }),
  };
  let lookups = 0;
  const handlers = createWorkspaceAccessHandlers({
    userId: (req) => req.headers["x-fixture-principal"] as string ?? null,
    approvals: () => ({
      authorizedUserIds: Object.keys(identities).join(","),
      approvalCassandraEmail: "cassandra@example.test",
      approvalCaitlinEmail: "caitlin@example.test",
    }),
    lookupIdentity: async (id) => {
      lookups++;
      const found = identities[id];
      if (!found) throw new Error("Unknown synthetic identity.");
      return found;
    },
    limiter: new WorkspaceAccessLimiter({ ...defaults, burst: 10 }),
  });
  const app = express();
  app.use(handlers.requireWorkspaceAccess);
  app.get("/private", (_req, res) => res.json(res.locals.workspaceActor));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private`;
  try {
    for (const [id, reviewerLabel] of [
      ["cassandra", "Cassandra"],
      ["caitlin", "Caitlin"],
      ["secondary", null],
      ["unverified", null],
      ["nonReviewer", null],
      ["idOnly", null],
    ] as const) {
      const response = await fetch(url, { headers: { "x-fixture-principal": id } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        userId: id,
        reviewerLabel,
        canApprove: reviewerLabel !== null,
      });
    }
    assert.equal(lookups, 6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});