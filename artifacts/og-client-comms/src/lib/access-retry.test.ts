import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getWorkspaceAccess } from "@workspace/api-client-react";
import { ApiError } from "../../../../lib/api-client-react/src/custom-fetch";
import {
  AccessCooldown, accessRetryAt, accessRetryDelay, getAccessCooldown,
  isTemporaryAccessError, shouldRetryAccess,
} from "./access-retry";

function temporary(status = 429, retryAfter?: string) {
  const response = new Response(JSON.stringify({ authorized: false }), {
    status, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
  return new ApiError(response, null, { method: "GET", url: "/api/workspace-access" });
}

test("Retry-After seconds and dates become stable deadlines, with a safe fallback", () => {
  const now = Date.now();
  const seconds = temporary(429, "3");
  assert.equal(accessRetryAt(seconds, now), now + 3000);
  assert.equal(accessRetryAt(seconds, now + 1000), now + 3000);
  const date = new Date(now + 10000).toUTCString();
  assert.equal(accessRetryAt(temporary(503, date), now), Date.parse(date));
  assert.equal(accessRetryAt(temporary(503, new Date(now - 10000).toUTCString()), now), now);
  for (const header of [undefined, "invalid", "-1"]) {
    assert.equal(accessRetryAt(temporary(503, header), now), now + 5000);
  }
  assert.equal(accessRetryAt(temporary(403, "5"), now), 0);
  assert.ok(isTemporaryAccessError(temporary(429)));
  assert.equal(isTemporaryAccessError(new Error("offline")), false);
});

test("automatic retries are bounded and never retry 401/403", () => {
  for (const status of [429, 503]) {
    assert.equal(shouldRetryAccess(0, temporary(status)), true);
    assert.equal(shouldRetryAccess(1, temporary(status)), true);
    assert.equal(shouldRetryAccess(2, temporary(status)), false);
  }
  for (const status of [401, 403, 500]) {
    assert.equal(shouldRetryAccess(0, temporary(status)), false);
  }
  assert.equal(shouldRetryAccess(0, new TypeError("Failed to fetch")), true);
  assert.equal(accessRetryDelay(0, temporary(429, "2")) > 1900, true);
});

test("cooldowns survive remounts, are scoped by user/client, and cancel without a request", async () => {
  const client = {};
  const cooldown = getAccessCooldown(client, "user-a");
  assert.equal(getAccessCooldown(client, "user-a"), cooldown);
  assert.notEqual(getAccessCooldown(client, "user-b"), cooldown);
  assert.notEqual(getAccessCooldown({}, "user-a"), cooldown);
  await assert.rejects(cooldown.run(async () => { throw temporary(429, "1"); }));
  const abort = new AbortController();
  let calls = 0;
  const waiting = cooldown.run(async () => { calls++; }, abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("real synthetic HTTP 429/503 responses recover automatically only after Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const times: number[] = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.cache, "no-store");
    times.push(Date.now());
    const status = times.length === 1 ? 429 : times.length === 2 ? 503 : 200;
    return new Response(JSON.stringify({ authorized: times.length === 3, userId: "test", reason: "test" }), {
      status, headers: { "content-type": "application/json", "Retry-After": "1", "Cache-Control": "no-store" },
    });
  };
  const client = new QueryClient();
  const cooldown = new AccessCooldown();
  try {
    const result = await client.fetchQuery({
      queryKey: ["synthetic-access"],
      queryFn: ({ signal }) => cooldown.run(() => getWorkspaceAccess({ signal, cache: "no-store" }), signal),
      retry: shouldRetryAccess, retryDelay: accessRetryDelay,
    });
    assert.equal(result.authorized, true);
    assert.equal(times.length, 3);
    assert.ok(times[1] - times[0] >= 1000);
    assert.ok(times[2] - times[1] >= 1000);
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test("manual refetches cannot bypass a cooldown or flood/cancel the request", async () => {
  const client = new QueryClient();
  const cooldown = new AccessCooldown();
  const times: number[] = [];
  const observer = new QueryObserver(client, {
    queryKey: ["manual-access"], retry: false,
    queryFn: ({ signal }) => cooldown.run(async () => {
      times.push(Date.now());
      if (times.length === 1) throw temporary(429, "1");
      return { authorized: false };
    }, signal),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch({ cancelRefetch: false });
    assert.equal(observer.getCurrentResult().isError, true);
    const pending = Array.from({ length: 20 }, () => observer.refetch({ cancelRefetch: false }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(times.length, 1);
    await Promise.all(pending);
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 1000);
    assert.equal(observer.getCurrentResult().data?.authorized, false);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("signed-out queries do not check access and old grants are not fresh successes after a failure", async () => {
  const client = new QueryClient();
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["grant"], enabled: false, retry: false,
    queryFn: async () => {
      calls++;
      if (calls === 1) return { authorized: true };
      throw temporary(503, "1");
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 0);
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data?.authorized, true);
    await observer.refetch();
    const state = observer.getCurrentResult();
    // TanStack retains data; the gate MUST check failures before consuming it.
    assert.equal(state.data?.authorized, true);
    assert.equal(state.isError, true);
    assert.ok(isTemporaryAccessError(state.failureReason));
  } finally {
    unsubscribe();
    client.clear();
  }
});