import { approvalSourceVersions } from "./approval-source-version";
import { insertApprovalHistorySnapshot } from "./approval-history";
import { getApprovalDatabasePool, type DatabaseClient } from "./approval-database";
import { withApprovalSourceTransaction } from "./approval-source-lock";
import { latestInventory, type InventoryReport } from "./fub/inventory-store";
import { programBlueprint } from "./program";
import {
  ApprovalAuthorityError, ApprovalValidationError, StaleApprovalError,
  answerEligibilityBlockers, applyAnswerChanges, approveSection, assertApprover,
  assertExpectedRevision, assertMutationSource, createReviewStateSnapshot, currentFinalApprovalBlockers,
  emptyReviewState, fieldSemanticsFor, finalizeReview, programReviewSections, reviewItem,
  APPROVAL_VALIDATION_POLICY_VERSION,
  type ApprovalAction, type Approver, type FieldOption, type ReviewAnswer, type ReviewState,
} from "./program-approval-engine";

const DOCUMENT_ID = "program-approvals";

type HistoryRow = {
  revision: number;
  action: string;
  section_id: string | null;
  actor_user_id: string;
  reviewer_label: string;
  occurred_at: Date | string;
  source_version: string;
  summary: string;
};

type StoredRow = {
  revision: number;
  source_version: string;
  rule_version: string;
  inventory_generated_at: Date | string | null;
  answers: Record<string, ReviewAnswer>;
  section_approvals: ReviewState["sectionApprovals"];
  final_signoff: ReviewState["finalSignoff"];
};

function datestring(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stateFromRow(row: StoredRow): ReviewState {
  return {
    revision: row.revision,
    sourceVersion: row.source_version,
    ruleVersion: row.rule_version,
    inventoryGeneratedAt: datestring(row.inventory_generated_at),
    answers: Object.fromEntries(Object.entries(row.answers ?? {}).map(([id, answer]) => [
      id, { ...answer, confirmedValues: Array.isArray(answer.confirmedValues) ? answer.confirmedValues : [] },
    ])),
    sectionApprovals: row.section_approvals ?? {},
    finalSignoff: row.final_signoff ?? null,
  };
}

function fieldsFromInventory(inventory: InventoryReport | null): FieldOption[] {
  if (!inventory) return [];
  return inventory.sections.filter((section) => section.status === "read").flatMap((section) =>
    section.fields.map((field) => ({
      id: `${section.entity}.${field.name}`,
      entity: section.entity,
      name: field.name,
      type: field.type.slice(0, 160),
      semantics: fieldSemanticsFor(section.entity, field.name),
    })),
  );
}

async function currentSource(client: DatabaseClient) {
  // Caller holds the shared transaction advisory lock before this query.
  const inventory = await latestInventory(client);
  const proposal = programBlueprint(); // Immutable process snapshot; config changes activate only on restart.
  const sections = programReviewSections(proposal);
  const ruleVersion = proposal.ruleVersion;
  const { approvalDefinitionVersion, sourceVersion } = approvalSourceVersions(
    inventory, ruleVersion, sections, APPROVAL_VALIDATION_POLICY_VERSION,
  );
  return {
    inventory, proposal, sections, ruleVersion, approvalDefinitionVersion,
    sourceVersion, fields: fieldsFromInventory(inventory),
  };
}

async function readStored(client: DatabaseClient): Promise<{ state: ReviewState | null; history: HistoryRow[] }> {
  const document = await client.query<StoredRow>(
    "SELECT revision, source_version, rule_version, inventory_generated_at, answers, section_approvals, final_signoff FROM program_approval_review WHERE id = $1",
    [DOCUMENT_ID],
  );
  const history = await client.query<HistoryRow>(
    "SELECT revision, action, section_id, actor_user_id, reviewer_label, occurred_at, source_version, summary FROM program_approval_history ORDER BY id DESC",
  );
  return { state: document.rows[0] ? stateFromRow(document.rows[0]) : null, history: history.rows };
}

function answerBlockers(
  answer: ReviewAnswer | undefined,
  item: ReturnType<typeof programReviewSections>[number]["items"][number],
  fields: FieldOption[],
  stale: boolean,
) {
  const currentAnswer = answer && stale ? { ...answer, decision: "pending" as const } : answer;
  return answerEligibilityBlockers(item, currentAnswer, fields);
}

function sectionIsCurrentlyApproved(
  index: number,
  sections: ReturnType<typeof programReviewSections>,
  state: ReviewState,
  fields: FieldOption[],
  stale: boolean,
) {
  const section = sections[index];
  return !stale
    && !!state.sectionApprovals[section.id]
    && (index === 0 || !!state.sectionApprovals[sections[index - 1].id])
    && section.items.every((item) => answerBlockers(state.answers[item.id], item, fields, false).length === 0);
}

function buildBlockers(
  state: ReviewState,
  sourceVersion: string,
  inventory: InventoryReport | null,
  sections: ReturnType<typeof programReviewSections>,
  fields: FieldOption[],
  stale: boolean,
) {
  const blockers: string[] = [];
  if (stale) blockers.push("The masked inventory, program rules, or approval definitions changed. Explicitly reset this stale review before continuing.");
  if (!inventory || inventory.status !== "complete") blockers.push("A complete current masked inventory is required before final setup signoff.");
  const answers = stale
    ? Object.fromEntries(Object.entries(state.answers).map(([id, answer]) => [id, { ...answer, decision: "pending" as const }]))
    : state.answers;
  for (const section of sections) {
    for (const item of section.items) blockers.push(...answerEligibilityBlockers(item, answers[item.id], fields));
  }
  if (sections.some((section, index) => !sectionIsCurrentlyApproved(index, sections, state, fields, stale))) {
    blockers.push("Every section must be currently approved in order after all required mappings are eligible.");
  }
  if (state.sourceVersion !== sourceVersion) blockers.push("The saved approval is not bound to the current exact source version.");
  return [...new Set(blockers)];
}

async function withLockedSource<T>(operation: (client: DatabaseClient, source: Awaited<ReturnType<typeof currentSource>>) => Promise<T>): Promise<T> {
  const pool = await getApprovalDatabasePool();
  const client = await pool.connect();
  try {
    return await withApprovalSourceTransaction(client, async () => {
      const source = await currentSource(client);
      return operation(client, source);
    });
  } finally {
    client.release();
  }
}

export async function getApprovalReview(actor: Approver) {
  return withLockedSource(async (client, current) => {
    const { state: saved, history } = await readStored(client);
    const isStale = !!saved && saved.sourceVersion !== current.sourceVersion;
    const state = saved ?? emptyReviewState(current.sourceVersion, current.ruleVersion, current.inventory?.generatedAt ?? null);
    const blockers = buildBlockers(state, current.sourceVersion, current.inventory, current.sections, current.fields, isStale);
    const approvedItems = isStale ? 0 : current.sections.reduce((count, section) =>
      count + section.items.filter((item) => answerBlockers(state.answers[item.id], item, current.fields, false).length === 0).length, 0);
    const totalItems = current.sections.reduce((count, section) => count + section.items.length, 0);
    const sectionResults = current.sections.map((section, index) => ({
      ...section,
      approval: sectionIsCurrentlyApproved(index, current.sections, state, current.fields, isStale)
        ? state.sectionApprovals[section.id] : null,
      approved: sectionIsCurrentlyApproved(index, current.sections, state, current.fields, isStale),
      items: section.items.map((item) => {
        const storedAnswer = state.answers[item.id];
        const savedAnswer = storedAnswer && isStale ? { ...storedAnswer, decision: "pending" as const } : storedAnswer ?? null;
        const itemBlockers = answerEligibilityBlockers(item, savedAnswer ?? undefined, current.fields);
        return {
          ...item,
          fieldOptions: current.fields.filter((field) => item.entities.includes(field.entity)
            && field.semantics.some((semantic) => item.acceptedFieldSemantics.includes(semantic))),
          savedAnswer,
          blockers: itemBlockers,
          approvalEligible: itemBlockers.length === 0,
        };
      }),
    }));
    const currentFinal = !isStale && !!state.finalSignoff
      && currentFinalApprovalBlockers(state, current.sections, current.fields, current.inventory?.status === "complete").length === 0;
    const status = isStale ? "stale"
      : currentFinal ? "final_approved"
        : blockers.length && approvedItems === 0 ? "pending"
          : blockers.length ? "in_progress" : "ready_for_signoff";
    return {
      revision: state.revision,
      sourceVersion: current.sourceVersion,
      ruleVersion: current.ruleVersion,
      approvalDefinitionVersion: current.approvalDefinitionVersion,
      inventoryDate: current.inventory?.generatedAt ?? null,
      inventoryStatus: current.inventory?.status ?? "not_checked",
      inventoryComplete: current.inventory?.status === "complete",
      status,
      canApprove: actor.canApprove,
      currentReviewer: actor.reviewerLabel,
      sections: sectionResults,
      fieldOptions: current.fields,
      savedAnswers: isStale
        ? Object.fromEntries(Object.entries(state.answers).map(([id, answer]) => [id, { ...answer, decision: "pending" as const }]))
        : state.answers,
      progress: {
        approvedItems,
        totalItems,
        approvedSections: sectionResults.filter((section) => section.approved).length,
      },
      blockers,
      history: history.map((entry) => ({
        revision: entry.revision,
        action: entry.action,
        sectionId: entry.section_id,
        principalId: entry.actor_user_id,
        reviewerLabel: entry.reviewer_label,
        occurredAt: datestring(entry.occurred_at),
        sourceVersion: entry.source_version,
        summary: entry.summary,
      })),
      finalApproval: currentFinal ? state.finalSignoff : null,
      proposal: current.proposal,
    };
  });
}

export async function getCurrentFinalApprovalStatus(): Promise<{
  approved: boolean; unavailable: boolean; detail: string; inventory: InventoryReport | null;
}> {
  return withLockedSource(async (client, current) => {
    const { state } = await readStored(client);
    if (!state || state.sourceVersion !== current.sourceVersion || !state.finalSignoff) {
      return {
        approved: false, unavailable: false,
        detail: "A current final setup signoff is not recorded for the complete current inventory, rules, and approval definitions.",
        inventory: current.inventory,
      };
    }
    const blockers = currentFinalApprovalBlockers(
      state, current.sections, current.fields, current.inventory?.status === "complete",
    );
    if (blockers.length) {
      return {
        approved: false, unavailable: false,
        detail: `The saved final signoff is not currently eligible: ${blockers[0]}`,
        inventory: current.inventory,
      };
    }
    return {
      approved: true, unavailable: false,
      detail: `Current proposed-setup signoff recorded by ${state.finalSignoff.reviewerLabel} on ${state.finalSignoff.signedAt}. This is not evidence of individual recipient consent.`,
      inventory: current.inventory,
    };
  });
}

async function mutateUnderLock(input: {
  expectedRevision: number;
  sourceVersion: string;
  operation: ApprovalAction;
}, actor: Approver): Promise<void> {
  await withLockedSource(async (client, current) => {
    if (input.sourceVersion !== current.sourceVersion) {
      throw new StaleApprovalError("The current masked inventory, program rules, or approval definitions changed. Reload and explicitly reset the stale review.");
    }
    await client.query(
      "INSERT INTO program_approval_review (id, revision, source_version, rule_version, inventory_generated_at, answers, section_approvals, final_signoff) VALUES ($1, 0, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, NULL) ON CONFLICT (id) DO NOTHING",
      [DOCUMENT_ID, current.sourceVersion, current.ruleVersion, current.inventory?.generatedAt ?? null],
    );
    const selected = await client.query<StoredRow>(
      "SELECT revision, source_version, rule_version, inventory_generated_at, answers, section_approvals, final_signoff FROM program_approval_review WHERE id = $1 FOR UPDATE",
      [DOCUMENT_ID],
    );
    const stored = stateFromRow(selected.rows[0]);
    assertExpectedRevision(stored.revision, input.expectedRevision);
    assertMutationSource(stored.sourceVersion, current.sourceVersion, input.operation.action);
    if (input.operation.action === "reset" && stored.sourceVersion === current.sourceVersion) {
      throw new ApprovalValidationError("This review is current; reset is only available for a stale inventory, rule, or definition version.");
    }

    let next: ReviewState;
    let sectionId: string | null = null;
    let summary: string;
    switch (input.operation.action) {
      case "reset":
        next = emptyReviewState(current.sourceVersion, current.ruleVersion, current.inventory?.generatedAt ?? null);
        summary = "Stale review explicitly reset; immutable prior history is retained.";
        break;
      case "save":
        next = applyAnswerChanges(stored, input.operation.answers, current.sections, current.fields);
        summary = `Draft answers saved as pending: ${Object.keys(input.operation.answers).join(", ") || "no item changes"}.`;
        break;
      case "review_item": {
        const itemId = input.operation.itemId;
        const itemSection = current.sections.find((section) => section.items.some((item) => item.id === itemId));
        sectionId = itemSection?.id ?? null;
        next = reviewItem(stored, itemId, input.operation.answer, actor, current.sections, current.fields, new Date().toISOString());
        summary = `Item ${itemId} explicitly marked ${input.operation.answer.decision} with submitted answer values.`;
        break;
      }
      case "approve":
        sectionId = input.operation.sectionId;
        next = approveSection(stored, sectionId, actor, current.sections, current.fields, new Date().toISOString());
        summary = "Section approved after current eligible decisions for every required item.";
        break;
      case "finalize":
        next = finalizeReview(
          stored, actor, current.sections, current.fields, current.inventory?.status === "complete",
          input.operation.confirmProposalOnly, new Date().toISOString(),
        );
        summary = "Final signoff recorded for proposed setup only; individual recipient consent is not established.";
        break;
    }

    // Re-read under the still-held publication lock immediately before writing.
    const revalidated = await currentSource(client);
    if (revalidated.sourceVersion !== current.sourceVersion) {
      throw new StaleApprovalError("The current approval source changed during this mutation; no decision was committed.");
    }
    const revision = stored.revision + 1;
    next.revision = revision;
    const stateSnapshot = createReviewStateSnapshot(next, current.sections, current.fields);
    const update = await client.query(
      "UPDATE program_approval_review SET revision = $1, source_version = $2, rule_version = $3, inventory_generated_at = $4, answers = $5::jsonb, section_approvals = $6::jsonb, final_signoff = $7::jsonb, updated_at = now() WHERE id = $8 AND revision = $9",
      [revision, current.sourceVersion, current.ruleVersion, current.inventory?.generatedAt ?? null, JSON.stringify(next.answers), JSON.stringify(next.sectionApprovals), next.finalSignoff ? JSON.stringify(next.finalSignoff) : null, DOCUMENT_ID, stored.revision],
    );
    if (update.rowCount !== 1) throw new StaleApprovalError("This review changed concurrently. Reload the latest revision before saving.");
    await insertApprovalHistorySnapshot(client, {
      revision,
      action: input.operation.action,
      sectionId,
      actorUserId: actor.userId,
      reviewerLabel: actor.reviewerLabel,
      sourceVersion: current.sourceVersion,
      summary,
      stateSnapshot,
    });
  });
}

export async function updateApprovalReview(input: {
  expectedRevision: number;
  sourceVersion: string;
  operation: ApprovalAction;
}, actor: Approver) {
  assertApprover(actor);
  await mutateUnderLock(input, actor);
  return getApprovalReview(actor);
}

export { ApprovalAuthorityError, ApprovalValidationError, StaleApprovalError };