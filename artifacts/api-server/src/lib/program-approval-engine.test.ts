import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalAuthorityError, ApprovalValidationError, StaleApprovalError,
  answerEligibilityBlockers, applyAnswerChanges, approveSection, assertApprover,
  assertExpectedRevision, assertMutationSource, createReviewStateSnapshot, currentFinalApprovalBlockers,
  emptyReviewState, finalizeReview, fieldSemanticsFor, programReviewSections,
  reviewItem, validateReviewAnswer, type FieldOption, type ReviewAnswer, type ReviewProposal,
} from "./program-approval-engine";
import { approvalSourceVersions } from "./approval-source-version";

const proposal: ReviewProposal = {
  audiences: [
    { code: "BUY", name: "Buyers", purpose: "Support active buyers.", cadenceDays: 8, contentDirection: "Search tips.", identificationRules: ["Active buyer stage or property-search activity."], reviewNotes: ["Preserve UNKNOWN."], unassignedDirection: "Route to a reviewer." },
    { code: "OWN", name: "Owners", purpose: "Support property owners.", cadenceDays: 12, contentDirection: "Ownership updates.", identificationRules: ["Mapped ownership evidence."], reviewNotes: [], unassignedDirection: "Hold." },
    { code: "SPH", name: "Sphere", purpose: "Support sphere relationships.", cadenceDays: 20, contentDirection: "Relationship notes.", identificationRules: ["Explicit sphere relationship."], reviewNotes: [], unassignedDirection: "Review." },
    { code: "NUR", name: "Nurture", purpose: "Nurture qualified prospects.", cadenceDays: 15, contentDirection: "Helpful education.", identificationRules: ["Configured nurture window."], reviewNotes: [], unassignedDirection: "Hold." },
    { code: "DOR", name: "Dormant", purpose: "Hold dormant contacts.", cadenceDays: 60, contentDirection: "No automatic outreach.", identificationRules: ["Configured dormant window."], reviewNotes: ["Overlap is REVIEW-only."], unassignedDirection: "Hold." },
  ],
  assignmentStrategies: [
    { code: "ASSIGNED", name: "Assigned agent", identification: "A verified FUB assignment.", communicationDirection: "Use assigned agent.", responsibleParty: "Agent.", releaseRequirements: ["Explicit review."] },
    { code: "UNASSIGNED", name: "Unassigned", identification: "Readable empty assignment.", communicationDirection: "Hold pending team exception.", responsibleParty: "Reviewer.", releaseRequirements: ["Named owner."] },
    { code: "REVIEW", name: "Unknown", identification: "Missing field.", communicationDirection: "Hold.", responsibleParty: "Operations.", releaseRequirements: ["Resolve evidence."] },
  ],
  priceBands: [
    { code: "P1", label: "Entry", min: 0, maxExclusive: 500000 },
    { code: "P2", label: "Upper", min: 500000, maxExclusive: 1000000 },
  ],
  classificationSteps: ["Unknown values remain UNKNOWN.", "Overlaps route to REVIEW."],
  numericRules: {
    windows: { buyer_days: 35, nurture_min_days: 30, nurture_max_days: 120, dormant_min_days: 120, event_market_days: 180, sync_event_history_days: 365 },
    limits: { market_events_required: 4, program_emails_per_30_days: 6 },
  },
};
const sections = programReviewSections(proposal);
const fields: FieldOption[] = [
  ["people", "assignedTo"], ["people", "status"], ["deals", "status"], ["stages", "name"],
  ["people", "stage"], ["people", "source"], ["people", "market"], ["people", "address"],
  ["deals", "price"], ["events", "created"], ["events", "type"], ["people", "pastClient"],
  ["people", "sphere"], ["people", "emailStatus"], ["people", "emailConsent"],
  ["people", "unsubscribe"], ["users", "sender"],
].map(([entity, name]) => ({
  id: `${entity}.${name}`, entity, name, type: "string", semantics: fieldSemanticsFor(entity, name),
}));
const cassandra = { userId: "verified-cassandra", reviewerLabel: "Cassandra", canApprove: true };
const caitlin = { userId: "verified-caitlin", reviewerLabel: "Caitlin", canApprove: true };

function answerFor(itemId: string, decision: ReviewAnswer["decision"] = "approved"): ReviewAnswer {
  const item = sections.flatMap((section) => section.items).find((entry) => entry.id === itemId)!;
  const option = fields.find((field) => item.entities.includes(field.entity)
    && field.semantics.some((semantic) => item.acceptedFieldSemantics.includes(semantic)));
  return {
    fieldId: item.fieldRequired ? option?.id ?? null : null,
    meaning: item.approvalEligibleMeanings[0] ?? item.meanings[0].value,
    confirmedValues: item.confirmedValuesRequired ? ["confirmed-value"] : [],
    evidence: "review evidence reference",
    decision,
    notes: decision === "needs_changes" ? "Needs a clearer source mapping." : "",
  };
}

function completeAnswers() {
  return Object.fromEntries(sections.flatMap((section) => section.items.map((item) => [item.id, answerFor(item.id)])));
}

function fullyReviewedState() {
  const state = emptyReviewState("v1", "rules1", "2025-01-01T00:00:00.000Z");
  state.answers = completeAnswers();
  sections.forEach((section) => {
    state.sectionApprovals[section.id] = { userId: cassandra.userId, reviewerLabel: cassandra.reviewerLabel, approvedAt: "2025-01-01T00:00:00.000Z", revision: 1 };
  });
  return state;
}

test("five audience decisions and numerical guidance come from the actual blueprint", () => {
  const rules = sections.find(({ id }) => id === "rules")!;
  const audiences = rules.items.filter(({ id }) => id.startsWith("audience_rule_"));
  assert.deepEqual(audiences.map(({ id }) => id), ["audience_rule_buy", "audience_rule_own", "audience_rule_sph", "audience_rule_nur", "audience_rule_dor"]);
  assert.match(audiences[0].guidance, /active buyer stage or property-search activity/i);
  assert.match(audiences[4].guidance, /Overlap is REVIEW-only/);
  assert.ok(audiences.every((item) => item.guidance.includes("Proposed cadence:")));
  assert.ok(audiences.every((item) => item.approvalEligibleMeanings.includes("proposal_reviewed")));
  assert.match(rules.items[1].guidance, /4 qualifying events in 180 days/);
  assert.match(rules.items[1].guidance, /6 emails per 30 days/);
  assert.match(sections.find(({ id }) => id === "mapping")!.items.find(({ id }) => id === "price_mapping")!.guidance, /P2 Upper; minimum 500000; exclusive maximum 1000000/);
});

test("unresolved meanings cannot approve a mapping, even when UNKNOWN/REVIEW policy is acknowledged", () => {
  const state = emptyReviewState("v1", "rules1", null);
  const mapping = sections.find(({ id }) => id === "mapping")!.items.find(({ id }) => id === "source_semantics")!;
  const policy = sections.find(({ id }) => id === "rules")!.items.find(({ id }) => id === "unknown_overlap_policy")!;
  const unresolved = { ...answerFor(mapping.id), meaning: "unknown" };
  assert.ok(answerEligibilityBlockers(mapping, unresolved, fields).some((blocker) => /not approval-eligible/.test(blocker)));
  assert.throws(() => reviewItem(state, mapping.id, unresolved, cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  const policyAck = answerFor(policy.id);
  assert.equal(policyAck.meaning, "safe_policy_acknowledged");
  assert.equal(answerEligibilityBlockers(policy, policyAck, fields).length, 0);
  assert.ok(answerEligibilityBlockers(mapping, unresolved, fields).length > 0);
});

test("only current observed fields with per-item relevant semantics and exact value labels qualify", () => {
  const source = sections.find(({ id }) => id === "mapping")!.items.find(({ id }) => id === "source_semantics")!;
  const base = answerFor(source.id);
  assert.throws(() => reviewItem(emptyReviewState("v1", "r1", null), source.id, {
    ...base, fieldId: "people.assignedTo",
  }, cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  assert.throws(() => reviewItem(emptyReviewState("v1", "r1", null), source.id, {
    ...base, confirmedValues: [],
  }, cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  assert.throws(() => reviewItem(emptyReviewState("v1", "r1", null), source.id, {
    ...base, confirmedValues: ["a@b.example"],
  }, cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  assert.equal(source.confirmedValuesRequired, true);
  assert.deepEqual(fieldSemanticsFor("events", "type"), ["event_type"]);
});

test("confirmed empty assignment is UNASSIGNED, distinct from UNKNOWN and unrelated to shared-sender approval", () => {
  const assignment = sections[0].items[0];
  const unassigned = { ...answerFor("agent_assignment"), meaning: "unassigned_agent", confirmedValues: [] };
  assert.equal(answerEligibilityBlockers(assignment, unassigned, fields).length, 0);
  const unknown = { ...unassigned, meaning: "unknown" };
  assert.ok(answerEligibilityBlockers(assignment, unknown, fields).some((blocker) => /not approval-eligible/.test(blocker)));
  const sender = sections[3].items.find(({ id }) => id === "sender_reply_human_approval")!;
  const teamException = { ...answerFor(sender.id), meaning: "team_sender_exception" };
  assert.ok(answerEligibilityBlockers(sender, teamException, fields).some((blocker) => /not approval-eligible/.test(blocker)));
});

test("save is draft-only, upstream edits revoke dependent approvals, and explicit review approves exact submitted values", () => {
  const state = fullyReviewedState();
  state.finalSignoff = { userId: cassandra.userId, reviewerLabel: "Cassandra", signedAt: "2025-01-01T00:00:00.000Z", revision: 2, proposalOnly: true };
  const revised = { ...state.answers.agent_assignment, confirmedValues: ["Agent A"] };
  const draft = applyAnswerChanges(state, { agent_assignment: { ...revised, decision: "approved" } }, sections, fields);
  assert.equal(draft.answers.agent_assignment.decision, "pending");
  assert.equal(draft.answers.stage_semantics.decision, "pending");
  assert.equal(draft.sectionApprovals.ownership, undefined);
  assert.equal(draft.finalSignoff, null);

  const firstSection = sections[0];
  let reviewed = draft;
  for (const item of firstSection.items) {
    const exactAnswer = { ...(reviewed.answers[item.id] ?? answerFor(item.id)), decision: "approved" as const };
    reviewed = reviewItem(reviewed, item.id, exactAnswer, cassandra, sections, fields, "2025-01-02T00:00:00.000Z");
  }
  assert.equal(reviewed.answers.agent_assignment.decision, "approved");
  assert.deepEqual(reviewed.answers.agent_assignment.confirmedValues, ["Agent A"]);
});

test("item review, section approval, and final signoff proceed in order without losing submitted values", () => {
  let state = emptyReviewState("v1", "rules1", "2025-01-01T00:00:00.000Z");
  for (const section of sections) {
    for (const item of section.items) {
      const submitted = answerFor(item.id);
      state = reviewItem(state, item.id, submitted, cassandra, sections, fields, "2025-01-01T00:00:00.000Z");
      assert.deepEqual(state.answers[item.id].confirmedValues, submitted.confirmedValues);
    }
    state = approveSection(state, section.id, cassandra, sections, fields, "2025-01-01T00:00:00.000Z");
  }
  assert.equal(currentFinalApprovalBlockers(state, sections, fields, true).length, 0);
  const finalState = finalizeReview(state, caitlin, sections, fields, true, true, "2025-01-01T00:00:00.000Z");
  assert.equal(finalState.finalSignoff?.reviewerLabel, "Caitlin");
});

test("revision CAS, stale source binding, and finalization all require eligible current answers", () => {
  assert.throws(() => assertExpectedRevision(8, 7), StaleApprovalError);
  assert.throws(() => assertMutationSource("old-version", "new-version", "save"), StaleApprovalError);
  assert.doesNotThrow(() => assertMutationSource("old-version", "new-version", "reset"));
  assert.doesNotThrow(() => assertExpectedRevision(4, 4));
  const state = fullyReviewedState();
  assert.equal(currentFinalApprovalBlockers(state, sections, fields, true).length, 0);
  assert.throws(() => finalizeReview(state, caitlin, sections, fields, false, true, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  assert.throws(() => finalizeReview(state, caitlin, sections, fields, true, false, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  const final = finalizeReview(state, caitlin, sections, fields, true, true, "2025-01-01T00:00:00.000Z");
  assert.equal(final.finalSignoff?.proposalOnly, true);
  const unresolved = fullyReviewedState();
  unresolved.answers.source_semantics = { ...answerFor("source_semantics"), meaning: "unknown" };
  assert.ok(currentFinalApprovalBlockers(unresolved, sections, fields, true).length > 0);
});

test("approval-definition and validation-policy versions invalidate source bindings", () => {
  const baseline = approvalSourceVersions({ version: "masked-a" }, "rule-a", sections, "policy-v1");
  const policyChanged = approvalSourceVersions({ version: "masked-a" }, "rule-a", sections, "policy-v2");
  const definitionsChanged = approvalSourceVersions({ version: "masked-a" }, "rule-a", [...sections, { ...sections[0], id: "new" }], "policy-v1");
  const inventoryChanged = approvalSourceVersions({ version: "masked-b" }, "rule-a", sections, "policy-v1");
  assert.notEqual(baseline.approvalDefinitionVersion, policyChanged.approvalDefinitionVersion);
  assert.notEqual(baseline.approvalDefinitionVersion, definitionsChanged.approvalDefinitionVersion);
  assert.notEqual(baseline.sourceVersion, policyChanged.sourceVersion);
  assert.notEqual(baseline.sourceVersion, inventoryChanged.sourceVersion);
});

test("review-state history snapshots retain full metadata without inventory data or mutable aliases", () => {
  const state = fullyReviewedState();
  state.answers.agent_assignment.confirmedValues = ["Agent A"];
  const extendedState = {
    ...state,
    inventory: { rawContacts: [{ email: "never-copy-this@example.test" }] },
  };
  const snapshot = createReviewStateSnapshot(extendedState, sections, fields);
  assert.deepEqual(snapshot.answers.agent_assignment, state.answers.agent_assignment);
  assert.equal(snapshot.sectionApprovals.ownership.approvedAt, "2025-01-01T00:00:00.000Z");
  assert.equal(snapshot.finalSignoff, null);
  assert.equal("inventory" in snapshot, false);
  assert.deepEqual(Object.keys(snapshot.answers.agent_assignment).sort(), [
    "confirmedValues", "decision", "evidence", "fieldId", "meaning", "notes",
  ]);
  state.answers.agent_assignment.confirmedValues[0] = "changed after snapshot";
  assert.deepEqual(snapshot.answers.agent_assignment.confirmedValues, ["Agent A"]);
});

test("ISO-date policy references are allowed while actual phone numbers remain rejected", () => {
  const item = sections.find(({ id }) => id === "mapping")!.items.find(({ id }) => id === "source_semantics")!;
  const base = answerFor(item.id);
  assert.doesNotThrow(() => validateReviewAnswer(item, {
    ...base, evidence: "Policy review reference dated 2026-10-01",
  }, fields));
  assert.throws(() => validateReviewAnswer(item, {
    ...base, evidence: "Policy reviewer callback 1 (415) 555-0101",
  }, fields), ApprovalValidationError);
  assert.throws(() => validateReviewAnswer(item, {
    ...base, evidence: "Reviewer contact 123 456 789",
  }, fields), ApprovalValidationError);
  assert.throws(() => validateReviewAnswer(item, {
    ...base, evidence: "Invalid date is still phone-like: 2026-99-99",
  }, fields), ApprovalValidationError);
});

test("only trusted reviewers can approve and later sections require prior section approval", () => {
  const state = emptyReviewState("v1", "rules1", null);
  assert.throws(() => approveSection(state, "mapping", cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  assert.throws(() => reviewItem(state, "source_semantics", answerFor("source_semantics"), cassandra, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalValidationError);
  const unauthorized = { userId: "staff", reviewerLabel: null as unknown as string, canApprove: false };
  assert.throws(() => assertApprover(unauthorized), ApprovalAuthorityError);
  assert.throws(() => approveSection(state, "ownership", unauthorized, sections, fields, "2025-01-01T00:00:00.000Z"), ApprovalAuthorityError);
});