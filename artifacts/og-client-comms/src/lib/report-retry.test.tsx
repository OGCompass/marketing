import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver, MutationObserver } from "@tanstack/react-query";
import { getWorkspaceStatus, getFieldInventory, getGetWorkspaceStatusQueryKey, getGetFieldInventoryQueryKey } from "@workspace/api-client-react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBlock, RetryButton } from "../components/kit";
import { accessRetryAt, getAccessCooldown } from "./access-retry";
import { getReportCooldown, reportQueryOptions, reportDiscoveryOptions } from "./report-retry";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function response(status: number, retryAfter = "1", data: unknown = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Retry-After": retryAfter },
  });
}

test("both report GETs recover after synthetic 429 then 503, never before the server deadline", async () => {
  const original = globalThis.fetch;
  try {
    for (const [key, read] of [
      [getGetWorkspaceStatusQueryKey(), getWorkspaceStatus],
      [getGetFieldInventoryQueryKey(), getFieldInventory],
    ] as const) {
      const client = new QueryClient();
      const times: number[] = [];
      globalThis.fetch = async (_url, options) => {
        assert.equal(options?.method, "GET");
        times.push(Date.now());
        return response(times.length === 1 ? 429 : times.length === 2 ? 503 : 200,
          "1", { recovered: true });
      };
      try {
        const result = await client.fetchQuery(reportQueryOptions<unknown>(getReportCooldown(client, "a"), key,
          (signal) => read({ signal }), true));
        assert.deepEqual(result, { recovered: true });
        assert.equal(times.length, 3);
        assert.ok(times[1] - times[0] >= 1000);
        assert.ok(times[2] - times[1] >= 1000);
      } finally {
        client.clear();
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("report failures exhaust bounded retries, expose countdowns, and concurrent manual retries wait", async () => {
  const original = globalThis.fetch;
  const client = new QueryClient();
  const times: number[] = [];
  globalThis.fetch = async () => {
    times.push(Date.now());
    return response(times.length <= 3 ? 429 : 200, "1", { report: null });
  };
  const observer = new QueryObserver(client, reportQueryOptions(getReportCooldown(client, "a"),
    getGetFieldInventoryQueryKey(), (signal) => getFieldInventory({ signal }), true));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch({ cancelRefetch: false });
    const state = observer.getCurrentResult();
    assert.equal(state.isError, true);
    assert.equal(times.length, 3);
    const retryAt = accessRetryAt(state.error);
    const markup = renderToStaticMarkup(<ErrorBlock id="inventory" message="Busy" retryAt={retryAt} onRetry={() => {}} />);
    assert.match(markup, /Retry in 1s/);
    assert.match(markup, /disabled=""/);
    const retries = Array.from({ length: 15 }, () => observer.refetch({ cancelRefetch: false }));
    await sleep(50);
    assert.equal(times.length, 3);
    await Promise.all(retries);
    assert.equal(times.length, 4);
    assert.ok(times[3] - times[2] >= 1000);
    assert.deepEqual(observer.getCurrentResult().data, { report: null });
  } finally {
    unsubscribe();
    client.clear();
    globalThis.fetch = original;
  }
});

test("a remount or different report cannot bypass the user-scoped cooldown; cancellation sends nothing", async () => {
  const original = globalThis.fetch;
  const client = new QueryClient();
  const cooldown = getReportCooldown(client, "a");
  assert.equal(getReportCooldown(client, "a"), cooldown);
  assert.notEqual(getReportCooldown(client, "b"), cooldown);
  assert.notEqual(getReportCooldown({}, "a"), cooldown);
  assert.notEqual(getAccessCooldown(client, "a"), cooldown);
  const times: number[] = [];
  globalThis.fetch = async () => {
    times.push(Date.now());
    return response(times.length === 1 ? 503 : 200, "1", { report: null });
  };
  try {
    await assert.rejects(client.fetchQuery({
      ...reportQueryOptions(cooldown, getGetWorkspaceStatusQueryKey(), (signal) => getWorkspaceStatus({ signal }), true),
      retry: false,
    }));
    const cancelled = client.fetchQuery(reportQueryOptions(getReportCooldown(client, "a"),
      ["cancelled-report"], (signal) => getFieldInventory({ signal }), true));
    await client.cancelQueries({ queryKey: ["cancelled-report"] });
    await assert.rejects(cancelled);
    assert.equal(times.length, 1);
    await client.fetchQuery(reportQueryOptions(getReportCooldown(client, "a"),
      getGetFieldInventoryQueryKey(), (signal) => getFieldInventory({ signal }), true));
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 1000);
  } finally {
    client.clear();
    globalThis.fetch = original;
  }
});

test("report reads do not retry authentication, permission or non-temporary failures", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 500]) {
      const client = new QueryClient();
      let calls = 0;
      globalThis.fetch = async () => { calls++; return response(status); };
      try {
        await assert.rejects(client.fetchQuery(reportQueryOptions(getReportCooldown(client, "a"),
          getGetWorkspaceStatusQueryKey(), (signal) => getWorkspaceStatus({ signal }), true)));
        assert.equal(calls, 1);
      } finally {
        client.clear();
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("discovery never replays automatically, keeps confirmation, and delays only a new explicit action", async () => {
  const original = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3 } } });
  const cooldown = getReportCooldown(client, "a");
  const times: number[] = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(options?.body as string), { confirmReadOnly: true });
    times.push(Date.now());
    return response(times.length === 1 ? 503 : 200);
  };
  const observer = new MutationObserver(client, reportDiscoveryOptions(cooldown));
  try {
    await assert.rejects(observer.mutate({ data: { confirmReadOnly: true } }));
    assert.equal(times.length, 1);
    const error = observer.getCurrentResult().error;
    const markup = renderToStaticMarkup(<RetryButton id="discovery" retryAt={accessRetryAt(error)}
      label="Run read-only discovery" onRetry={() => {}} />);
    assert.match(markup, /Retry in 1s/);
    assert.match(markup, /disabled=""/);
    await sleep(50);
    assert.equal(times.length, 1);
    await observer.mutate({ data: { confirmReadOnly: true } });
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 1000);
  } finally {
    client.clear();
    globalThis.fetch = original;
  }
});

test("signed-out report observers stay disabled", async () => {
  const client = new QueryClient();
  let calls = 0;
  const observer = new QueryObserver(client, reportQueryOptions(getReportCooldown(client, ""),
    ["signed-out"], async () => { calls++; return {}; }, false));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await sleep(20);
    assert.equal(calls, 0);
  } finally {
    unsubscribe();
    client.clear();
  }
});