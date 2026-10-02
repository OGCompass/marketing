import { test } from "node:test";
import assert from "node:assert/strict";
import { createLazyDatabasePool } from "./approval-database";

test("missing DATABASE_URL is explicit and does not attempt a database module load", async () => {
  let imported = false;
  const getPool = createLazyDatabasePool(async () => {
    imported = true;
    throw new Error("database module import should not run without configuration");
  });
  await assert.rejects(getPool({}), /DATABASE_URL is not configured/);
  assert.equal(imported, false);
});

test("configured lazy database loading caches only the caller's module promise path", async () => {
  const expected = {
    async connect() { throw new Error("not needed"); },
    async query() { return { rows: [], rowCount: 0 }; },
  };
  let calls = 0;
  const getPool = createLazyDatabasePool(async () => {
    calls += 1;
    return { pool: expected as never };
  });
  assert.equal(await getPool({ DATABASE_URL: "postgres://configured" }), expected);
  assert.equal(calls, 1);
});