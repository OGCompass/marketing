import { test } from "node:test";
import assert from "node:assert/strict";
import { insertApprovalHistorySnapshot } from "./approval-history";
import type { DatabaseClient } from "./approval-database";
import type { ReviewState } from "./program-approval-engine";

test("every audit-history insert stores the complete metadata state snapshot as JSONB", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] = [];
  const client: DatabaseClient = {
    async query<T>(sql: string, values?: unknown[]) {
      capturedSql = sql;
      capturedValues = values ?? [];
      return { rows: [] as T[], rowCount: 1 };
    },
    release() {},
  };
  const snapshot: ReviewState = {
    revision: 9,
    sourceVersion: "source-hash",
    ruleVersion: "rule-hash",
    inventoryGeneratedAt: "2026-10-01T12:30:00.000Z",
    answers: {
      stage_semantics: {
        fieldId: "stages.name", meaning: "open_opportunity", confirmedValues: ["Qualified"],
        evidence: "approved stage mapping", decision: "approved", notes: "",
      },
    },
    sectionApprovals: {
      mapping: { userId: "verified-reviewer-id", reviewerLabel: "Cassandra", approvedAt: "2026-10-01T12:35:00.000Z", revision: 9 },
    },
    finalSignoff: null,
  };
  await insertApprovalHistorySnapshot(client, {
    revision: snapshot.revision,
    action: "review_item",
    sectionId: "mapping",
    actorUserId: "verified-reviewer-id",
    reviewerLabel: "Cassandra",
    sourceVersion: snapshot.sourceVersion,
    summary: "Item explicitly approved.",
    stateSnapshot: snapshot,
  });
  assert.match(capturedSql, /state_snapshot\) VALUES/);
  assert.equal(capturedValues.length, 8);
  const stored = JSON.parse(capturedValues[7] as string);
  assert.deepEqual(stored, snapshot);
  assert.equal("inventory" in stored, false);
  assert.equal("rawSamples" in stored, false);
});