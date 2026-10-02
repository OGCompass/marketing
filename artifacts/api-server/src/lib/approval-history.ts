import type { DatabaseClient } from "./approval-database";
import type { ReviewState } from "./program-approval-engine";

export type ApprovalHistorySnapshotInput = {
  revision: number;
  action: string;
  sectionId: string | null;
  actorUserId: string;
  reviewerLabel: string;
  sourceVersion: string;
  summary: string;
  stateSnapshot: ReviewState;
};

export async function insertApprovalHistorySnapshot(
  client: DatabaseClient,
  input: ApprovalHistorySnapshotInput,
): Promise<void> {
  await client.query(
    "INSERT INTO program_approval_history (revision, action, section_id, actor_user_id, reviewer_label, source_version, summary, state_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)",
    [
      input.revision, input.action, input.sectionId, input.actorUserId, input.reviewerLabel,
      input.sourceVersion, input.summary, JSON.stringify(input.stateSnapshot),
    ],
  );
}