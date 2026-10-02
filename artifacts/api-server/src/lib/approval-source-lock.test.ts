import { test } from "node:test";
import assert from "node:assert/strict";
import { withApprovalSourceTransaction } from "./approval-source-lock";
import { insertApprovalHistorySnapshot } from "./approval-history";
import type { DatabaseClient } from "./approval-database";

class SharedLock {
  private tail = Promise.resolve();

  async acquire() {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

function clientFor(lock: SharedLock, events: string[], failHistoryInsert = false): DatabaseClient {
  let unlock: (() => void) | null = null;
  return {
    async query<T>(sql: string, values?: unknown[]) {
      events.push(sql === "SELECT pg_advisory_xact_lock($1, $2)" ? `LOCK:${values?.join(",")}` : sql);
      if (failHistoryInsert && sql.includes("INSERT INTO program_approval_history")) {
        throw new Error("history snapshot insert failed");
      }
      if (sql === "SELECT pg_advisory_xact_lock($1, $2)") unlock = await lock.acquire();
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        unlock?.();
        unlock = null;
      }
      return { rows: [] as T[], rowCount: 1 };
    },
    release() {},
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("source publisher and approval transactions serialize source/revision decisions", async () => {
  const lock = new SharedLock();
  let activeSource = "source-1";
  let reviewRevision = 0;
  let finalSignoffSource: string | null = null;

  const publisherEntered = deferred();
  const continuePublisher = deferred();
  const publisherEvents: string[] = [];
  const approvalEvents: string[] = [];
  const publisher = withApprovalSourceTransaction(clientFor(lock, publisherEvents), async () => {
    publisherEntered.resolve();
    await continuePublisher.promise;
    activeSource = "source-2";
  });
  await publisherEntered.promise;
  const staleApproval = withApprovalSourceTransaction(clientFor(lock, approvalEvents), async () => {
    if (activeSource !== "source-1") throw new Error("stale approval source");
    reviewRevision += 1;
  });
  const rejection = assert.rejects(staleApproval, /stale approval source/);
  continuePublisher.resolve();
  await publisher;
  await rejection;
  assert.equal(reviewRevision, 0);
  assert.deepEqual(publisherEvents.slice(0, 2), ["BEGIN", "LOCK:5195597,4280400"]);
  assert.deepEqual(approvalEvents.slice(0, 2), ["BEGIN", "LOCK:5195597,4280400"]);

  const lock2 = new SharedLock();
  activeSource = "source-1";
  reviewRevision = 0;
  finalSignoffSource = null;
  const approvalLocked = deferred();
  const releaseApproval = deferred();
  const approvalFirst = withApprovalSourceTransaction(clientFor(lock2, []), async () => {
    const sourceObservedUnderLock = activeSource;
    approvalLocked.resolve();
    await releaseApproval.promise;
    reviewRevision += 1;
    finalSignoffSource = sourceObservedUnderLock;
  });
  await approvalLocked.promise;
  const publisherSecond = withApprovalSourceTransaction(clientFor(lock2, []), async () => {
    activeSource = "source-2";
  });
  releaseApproval.resolve();
  await Promise.all([approvalFirst, publisherSecond]);
  assert.equal(reviewRevision, 1);
  assert.equal(finalSignoffSource, "source-1");
  assert.notEqual(finalSignoffSource, activeSource, "the prior signoff is stale after publication and cannot pass readiness");
});

test("source transaction rolls back and releases its advisory lock on failures", async () => {
  const events: string[] = [];
  await assert.rejects(withApprovalSourceTransaction(clientFor(new SharedLock(), events), async () => {
    throw new Error("test rollback");
  }), /test rollback/);
  assert.deepEqual(events, ["BEGIN", "LOCK:5195597,4280400", "ROLLBACK"]);

  const historyFailureEvents: string[] = [];
  const historyFailureClient = clientFor(new SharedLock(), historyFailureEvents, true);
  await assert.rejects(withApprovalSourceTransaction(
    historyFailureClient,
    async () => {
      await historyFailureClient.query("UPDATE program_approval_review SET revision = 2");
      await insertApprovalHistorySnapshot(historyFailureClient, {
        revision: 2,
        action: "save",
        sectionId: null,
        actorUserId: "reviewer-id",
        reviewerLabel: "Cassandra",
        sourceVersion: "source-hash",
        summary: "Draft answers saved.",
        stateSnapshot: {
          revision: 2,
          sourceVersion: "source-hash",
          ruleVersion: "rule-hash",
          inventoryGeneratedAt: null,
          answers: {},
          sectionApprovals: {},
          finalSignoff: null,
        },
      });
    },
  ), /history snapshot insert failed/);
  assert.equal(historyFailureEvents.at(-1), "ROLLBACK");
  assert.equal(historyFailureEvents.includes("COMMIT"), false);
});