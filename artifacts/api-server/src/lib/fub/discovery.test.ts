import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readSample, FubReadError } from "./client";
import { fieldInventory } from "./inventory";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
process.env.FUB_API_KEY = "fixture-only";
process.env.FUB_X_SYSTEM = "fixture-system";
process.env.FUB_X_SYSTEM_KEY = "fixture-key";

test("bounded discovery uses GET, allFields, limit <=100 and nextLink, not deep offsets", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.href);
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("fields"), "allFields");
    assert.ok(Number(url.searchParams.get("limit")) <= 100);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["X-System"], "fixture-system");
    return new Response(JSON.stringify(paths.length === 1
      ? { people: [{ id: 1 }], _metadata: { nextLink: "https://api.followupboss.com/v1/people?fields=allFields&limit=1&cursor=next" } }
      : { people: [{ id: 2 }], _metadata: {} }), { status: 200 });
  };
  const result = await readSample("people", 2);
  assert.equal(result.rows.length, 2);
  assert.equal(paths.length, 2);
  assert.equal(result.truncated, false);
});

test("untrusted nextLink can never leak the API key to another host", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ people: [{}], _metadata: { nextLink: "https://attacker.invalid/v1/people" } }));
  };
  await assert.rejects(readSample("people", 2), /Unsafe pagination link/);
  assert.equal(calls, 1);
});

test("authentication errors are explicit and are not retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("not retained", { status: 401 }); };
  await assert.rejects(readSample("people", 50), (error: unknown) => error instanceof FubReadError && error.status === 401);
  assert.equal(calls, 1);
});

test("an unexpected record schema fails instead of silently returning zero contacts", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ wrongKey: [] }));
  await assert.rejects(readSample("people", 50), /expected people array/);
});

test("customFields reads FUB's lowercase customfields JSON envelope", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).pathname, "/v1/customFields");
    return new Response(JSON.stringify({
      customfields: [{ id: 1, name: "customFixtureField", label: "Fixture field", type: "text" }],
      _metadata: {},
    }));
  };
  const result = await readSample("customFields", 500);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.name, "customFixtureField");
  assert.equal(result.truncated, false);
});

test("masked aggregate output retains neither PII nor contact IDs, prices or timestamps", () => {
  const fields = fieldInventory("people", [{
    id: 987654, firstName: "FixturePrivateName", name: "FixtureFullName",
    emails: [{ value: "private-fixture@example.invalid", status: "valid" }],
    phones: [{ value: "4155550199" }],
    addresses: [{ street: "123 FixtureSecretStreet", city: "Burlingame", zip: "94010" }],
    notes: "FixturePrivateNote",
    updated: "2026-10-01T18:00:00Z",
    price: 8765432,
  }]);
  const serialized = JSON.stringify(fields);
  for (const privateValue of ["987654", "FixturePrivateName", "FixtureFullName", "private-fixture@", "4155550199", "FixtureSecretStreet", "FixturePrivateNote", "2026-10-01", "8765432"]) {
    assert.ok(!serialized.includes(privateValue), `Private fixture leaked: ${privateValue}`);
  }
  assert.equal(fields.find((field) => field.name === "addresses[].city")?.safeExample, "Burlingame");
});

test("population percentages count records, not duplicate array entries", () => {
  const fields = fieldInventory("people", [
    { emails: [{ value: "a@example.invalid" }, { value: "b@example.invalid" }] },
    { emails: [] },
  ]);
  assert.equal(fields.find((field) => field.name === "emails[].value")?.populatedPercent, 50);
});