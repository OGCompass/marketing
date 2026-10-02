import type { DatabaseClient } from "./approval-database";

// All masked-source publishers and approval mutations acquire this lock first.
export const APPROVAL_SOURCE_LOCK_KEYS = [0x4f474d, 0x415050] as const;

export async function acquireApprovalSourceLock(client: DatabaseClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [...APPROVAL_SOURCE_LOCK_KEYS]);
}

export async function withApprovalSourceTransaction<T>(client: DatabaseClient, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await acquireApprovalSourceLock(client);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}