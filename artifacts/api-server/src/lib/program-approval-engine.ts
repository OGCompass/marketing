export type ReviewDecision = "pending" | "approved" | "needs_changes";

export type ReviewItem = {
  id: string;
  title: string;
  guidance: string;
  required: true;
  entities: string[];
  fieldRequired: boolean;
  acceptedFieldSemantics: string[];
  confirmedValuesRequired: boolean;
  meanings: { value: string; label: string }[];
  approvalEligibleMeanings: string[];
};

export type ReviewSection = {
  id: string;
  title: string;
  guidance: string;
  items: ReviewItem[];
};

export type ReviewAnswer = {
  fieldId: string | null;
  meaning: string | null;
  confirmedValues: string[];
  evidence: string;
  decision: ReviewDecision;
  notes: string;
};

export type FieldOption = { id: string; entity: string; name: string; type: string; semantics: string[] };
export type Approver = { userId: string; reviewerLabel: string; canApprove: boolean };
export type SectionApproval = { userId: string; reviewerLabel: string; approvedAt: string; revision: number };
export type FinalSignoff = { userId: string; reviewerLabel: string; signedAt: string; revision: number; proposalOnly: true };
export type ReviewState = {
  revision: number;
  sourceVersion: string;
  ruleVersion: string;
  inventoryGeneratedAt: string | null;
  answers: Record<string, ReviewAnswer>;
  sectionApprovals: Record<string, SectionApproval>;
  finalSignoff: FinalSignoff | null;
};

export type ApprovalAction =
  | { action: "save"; answers: Record<string, ReviewAnswer> }
  | { action: "review_item"; itemId: string; answer: ReviewAnswer }
  | { action: "approve"; sectionId: string }
  | { action: "finalize"; confirmProposalOnly: true }
  | { action: "reset" };

export type ReviewProposal = {
  audiences: {
    code: string; name: string; purpose: string; cadenceDays: number; contentDirection: string;
    identificationRules: string[]; reviewNotes: string[]; unassignedDirection: string;
  }[];
  assignmentStrategies: {
    code: string; name: string; identification: string; communicationDirection: string;
    responsibleParty: string; releaseRequirements: string[];
  }[];
  priceBands: { code: string; label: string; min?: number; maxExclusive?: number }[];
  classificationSteps: string[];
  numericRules: { windows: Record<string, number>; limits: Record<string, number> };
};

export const APPROVAL_VALIDATION_POLICY_VERSION = "guided-setup-review-eligibility-v4";

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalValidationError";
  }
}

export class StaleApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleApprovalError";
  }
}

export class ApprovalAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalAuthorityError";
  }
}

const meaning = (value: string, label: string) => ({ value, label });
const overlapText = (proposal: ReviewProposal) => {
  const { windows } = proposal.numericRules;
  const start = Math.max(windows.nurture_min_days, windows.dormant_min_days);
  const end = windows.nurture_max_days;
  return start <= end
    ? `The configured nurture/dormant overlap is ${start}–${end} days. This overlap requires human review; each match is REVIEW-only. Do not add another threshold.`
    : "The configured nurture and dormant windows do not overlap.";
};

const mapping = (
  item: Omit<ReviewItem, "required" | "entities" | "fieldRequired" | "acceptedFieldSemantics" | "confirmedValuesRequired" | "approvalEligibleMeanings"> & {
    entities: string[];
    acceptedFieldSemantics: string[];
    eligible: string[];
    confirmedValuesRequired?: boolean;
    fieldRequired?: boolean;
  },
): ReviewItem => ({
  ...item,
  required: true,
  fieldRequired: item.fieldRequired ?? true,
  confirmedValuesRequired: item.confirmedValuesRequired ?? true,
  approvalEligibleMeanings: item.eligible,
});

function policyItem(id: string, title: string, guidance: string, acknowledgementLabel: string): ReviewItem {
  return {
    id, title, guidance, required: true, entities: [], fieldRequired: false, acceptedFieldSemantics: [],
    confirmedValuesRequired: false,
    meanings: [
      meaning("safe_policy_acknowledged", acknowledgementLabel),
      meaning("needs_rule_changes", "Policy needs changes"),
      meaning("unresolved", "Policy remains unresolved"),
    ],
    approvalEligibleMeanings: ["safe_policy_acknowledged"],
  };
}

export function programReviewSections(proposal: ReviewProposal): ReviewSection[] {
  const { windows, limits } = proposal.numericRules;
  const audienceItems = proposal.audiences.map((audience) => ({
    id: `audience_rule_${audience.code.toLowerCase()}`,
    title: `${audience.code} — ${audience.name}`,
    guidance: [
      audience.purpose,
      `Proposed cadence: ${audience.cadenceDays} days.`,
      `Content direction: ${audience.contentDirection}`,
      ...audience.identificationRules.map((rule) => `Identification: ${rule}`),
      ...audience.reviewNotes.map((note) => `Review note: ${note}`),
      `Unassigned-record direction: ${audience.unassignedDirection}`,
      "This confirms only the proposed rule, not that any individual record matches it.",
    ].join(" "),
    required: true as const, entities: [], fieldRequired: false, acceptedFieldSemantics: [],
    confirmedValuesRequired: false,
    meanings: [
      meaning("proposal_reviewed", "This audience proposal is reviewed as written"),
      meaning("needs_rule_changes", "This audience rule needs changes"),
      meaning("unresolved", "This audience rule remains unresolved"),
    ],
    approvalEligibleMeanings: ["proposal_reviewed"],
  }));
  const numericProposal = [
    `Market evidence requires ${limits.market_events_required} qualifying events in ${windows.event_market_days} days.`,
    `The global program cap is ${limits.program_emails_per_30_days} emails per 30 days across campaigns and agent outreach.`,
    `The configured buyer window is ${windows.buyer_days} days; nurture is ${windows.nurture_min_days}–${windows.nurture_max_days} days; dormant begins at ${windows.dormant_min_days} days.`,
    `Dormant reactivation is limited to ${limits.dormant_attempts} attempts; readable event history must cover ${windows.sync_event_history_days} days.`,
    `Later-phase accuracy targets are ${limits.accuracy_percent}% across ${limits.reviewed_contacts_required} reviewed contacts and ${limits.golden_contacts_required} golden contacts.`,
    `All configured windows: ${Object.entries(windows).map(([key, value]) => `${key}=${value}`).join(", ")}. All configured limits: ${Object.entries(limits).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    overlapText(proposal),
    ...proposal.classificationSteps,
  ].join(" ");
  const priceText = proposal.priceBands.map((band) =>
    `${band.code} ${band.label}${band.min === undefined ? "" : `; minimum ${band.min}`}${band.maxExclusive === undefined ? "" : `; exclusive maximum ${band.maxExclusive}`}`,
  ).join(". ");

  return [
    {
      id: "ownership",
      title: "Assignment and record scope",
      guidance: [
        "Confirm actual ownership signals and the boundary between eligible records and records that must stay out. UNASSIGNED means an explicitly readable assignment field whose confirmed empty value means no agent; UNKNOWN means missing, unreadable, deleted, or conflicting evidence. They are distinct states.",
        ...proposal.assignmentStrategies.map((strategy) => `${strategy.code} — ${strategy.name}: ${strategy.identification} ${strategy.communicationDirection} Responsible party: ${strategy.responsibleParty} Release requirements: ${strategy.releaseRequirements.join("; ")}`),
      ].join(" "),
      items: [
        mapping({
          id: "agent_assignment", title: "Agent assignment and UNASSIGNED versus UNKNOWN",
          guidance: "Select a relevant person-assignment field and enter its actual confirmed values. Explicitly map the empty assignment value to UNASSIGNED; absent or unreadable fields remain UNKNOWN. An unassigned record does not authorize a team sender; that exception remains unapproved and unimplemented.",
          entities: ["people"], acceptedFieldSemantics: ["agent_assignment"], eligible: ["assigned_agent", "unassigned_agent"],
          meanings: [
            meaning("assigned_agent", "Confirmed individual agent assignment"),
            meaning("unassigned_agent", "Confirmed empty assignment means UNASSIGNED"),
            meaning("unknown", "Missing or unreadable evidence remains UNKNOWN"),
            meaning("no_reliable_signal", "No reliable assignment signal was identified"),
          ],
        }),
        mapping({
          id: "record_exclusions", title: "Record exclusions and status",
          guidance: "Map actual exclusion, do-not-contact, archive, or inactive values. A meaning must be explicit; an unknown value cannot be approved as eligible.",
          entities: ["people", "deals"], acceptedFieldSemantics: ["exclusion", "suppression", "status"], eligible: ["eligible", "excluded", "inactive_or_archived"],
          meanings: [meaning("eligible", "Explicit in-scope value"), meaning("excluded", "Explicit exclusion value"), meaning("inactive_or_archived", "Explicit inactive/archive value"), meaning("unknown", "Meaning remains UNKNOWN")],
        }),
        mapping({
          id: "active_transactions", title: "Active transaction protection",
          guidance: "Confirm actual deal/stage status values for active transactions. Active transaction protection is an exclusion; status_unknown is not an established mapping.",
          entities: ["deals", "stages"], acceptedFieldSemantics: ["transaction_status", "stage", "status"],
          eligible: ["active_transaction", "not_active_transaction"],
          meanings: [meaning("active_transaction", "Confirmed active transaction"), meaning("not_active_transaction", "Confirmed not an active transaction"), meaning("status_unknown", "Status meaning is unresolved")],
        }),
      ],
    },
    {
      id: "mapping",
      title: "CRM mapping and category meaning",
      guidance: "Use only currently observed readable fields with relevant semantics. For stage, tag, source, event, status, and consent mappings, enter exact observed value labels in confirmedValues; notes/evidence are references and cannot substitute for values.",
      items: [
        mapping({
          id: "stage_semantics", title: "Stages, tags, and status meanings",
          guidance: "Map exact observed values for stage, tag, or status fields to one explicit business meaning. Unmapped values remain UNKNOWN.",
          entities: ["stages", "people", "deals"], acceptedFieldSemantics: ["stage", "tag", "status"], eligible: ["new_lead", "open_opportunity", "under_contract", "closed_won", "closed_lost", "exclusion", "other_explicit_meaning"],
          meanings: [
            meaning("new_lead", "Confirmed new lead"), meaning("open_opportunity", "Confirmed open opportunity"),
            meaning("under_contract", "Confirmed under contract"), meaning("closed_won", "Confirmed closed/won"),
            meaning("closed_lost", "Confirmed closed/lost"), meaning("exclusion", "Confirmed exclusion"),
            meaning("other_explicit_meaning", "Another explicitly documented meaning"), meaning("unknown", "Meaning remains UNKNOWN"),
          ],
        }),
        mapping({
          id: "source_semantics", title: "Lead source meaning",
          guidance: "Select a source/origin field and enter exact confirmed source values. Excluded sources remain excluded; not_a_source and unknown do not approve a source mapping.",
          entities: ["people"], acceptedFieldSemantics: ["lead_source"], eligible: ["known_source", "excluded_source"],
          meanings: [meaning("known_source", "Confirmed eligible/source value"), meaning("excluded_source", "Confirmed excluded source"), meaning("not_a_source", "Field/value is not a source"), meaning("unknown", "Source remains UNKNOWN")],
        }),
        mapping({
          id: "market_property_mapping", title: "Market and property-location mapping",
          guidance: `Map observed location values and semantics. ${numericProposal}`,
          entities: ["people", "events", "deals"], acceptedFieldSemantics: ["market", "property_location"], eligible: ["market", "property_city_or_zip"],
          meanings: [meaning("market", "Confirmed market/location value"), meaning("property_city_or_zip", "Confirmed property city or ZIP"), meaning("not_reliable", "Not reliable for this meaning"), meaning("unknown", "Meaning remains UNKNOWN")],
        }),
        mapping({
          id: "price_mapping", title: "Price and configured price bands",
          guidance: `Confirm the price field's meaning and documented units in the evidence/notes, not individual client prices or sample numeric values. Configured bands: ${priceText}. The label alone is not evidence that a CRM field has this meaning.`,
          entities: ["events", "deals"], acceptedFieldSemantics: ["price"], eligible: ["property_price", "deal_price"],
          confirmedValuesRequired: false,
          meanings: [meaning("property_price", "Confirmed property price"), meaning("deal_price", "Confirmed deal price"), meaning("not_price", "Field is not price evidence"), meaning("unknown", "Price meaning remains UNKNOWN")],
        }),
        mapping({
          id: "activity_timestamp_events", title: "Activity timestamp meaning",
          guidance: "Map a timestamp field only when its time meaning is confirmed. A timestamp alone does not establish activity; missing history remains UNKNOWN, not inactive.",
          entities: ["people", "events", "deals"], acceptedFieldSemantics: ["activity_timestamp"], eligible: ["event_timestamp", "last_activity"],
          confirmedValuesRequired: false,
          meanings: [meaning("event_timestamp", "Confirmed timestamp for mapped event"), meaning("last_activity", "Confirmed last-activity timestamp"), meaning("not_activity_evidence", "Not activity evidence"), meaning("unknown", "Timestamp/history is UNKNOWN")],
        }),
        mapping({
          id: "activity_event_semantics", title: "Activity event type meaning",
          guidance: "Map actual event-type values for delivered email, open, click, reply, appointment, transaction, or another explicit event. Delivery is not engagement.",
          entities: ["events", "people", "deals"], acceptedFieldSemantics: ["event_type"], eligible: ["delivered_email", "open", "click", "reply", "appointment", "transaction", "other_explicit_event"],
          meanings: [
            meaning("delivered_email", "Confirmed delivery event"), meaning("open", "Confirmed open event"),
            meaning("click", "Confirmed click event"), meaning("reply", "Confirmed reply event"),
            meaning("appointment", "Confirmed appointment event"), meaning("transaction", "Confirmed transaction event"),
            meaning("other_explicit_event", "Another explicitly documented event"), meaning("unknown", "Event semantics are UNKNOWN"),
          ],
        }),
        mapping({
          id: "buyer_history_mapping", title: "Buyer interest evidence",
          guidance: "Buyer evidence may be an explicitly mapped active-buyer stage or dated property/search activity. Closed transaction history alone does not establish current buying interest.",
          entities: ["people", "events", "deals", "stages"], acceptedFieldSemantics: ["buyer_interest", "event_type", "stage"], eligible: ["active_buyer_stage", "property_search_activity"],
          meanings: [meaning("active_buyer_stage", "Confirmed active-buyer stage"), meaning("property_search_activity", "Confirmed dated property/search activity"), meaning("closed_transaction_only", "Closed transaction evidence only"), meaning("not_evidence", "Not buyer-interest evidence"), meaning("unknown", "Buyer interest remains UNKNOWN")],
        }),
        mapping({
          id: "past_client_mapping", title: "Past-client relationship mapping",
          guidance: "Map only explicit prior-client relationship evidence; buyer status alone or a sphere relationship is insufficient.",
          entities: ["people", "events", "deals"], acceptedFieldSemantics: ["past_client", "relationship", "transaction_status"], eligible: ["past_client"],
          meanings: [meaning("past_client", "Confirmed past-client relationship"), meaning("not_evidence", "Not evidence of past-client status"), meaning("unknown", "Past-client status remains UNKNOWN")],
        }),
        mapping({
          id: "sphere_mapping", title: "Sphere and referral relationship mapping",
          guidance: "Map only explicit sphere/referral values; do not infer sphere status from generic source labels, buyer status, or inactivity.",
          entities: ["people", "events"], acceptedFieldSemantics: ["sphere", "lead_source", "tag"], eligible: ["sphere_relationship"],
          meanings: [meaning("sphere_relationship", "Confirmed sphere/referral relationship"), meaning("not_evidence", "Not sphere evidence"), meaning("unknown", "Sphere status remains UNKNOWN")],
        }),
      ],
    },
    {
      id: "rules",
      title: "Proposed audience and numeric rules",
      guidance: "These values are a proposal only. Confirm configured thresholds without inventing alternatives.",
      items: [
        policyItem(
          "unknown_overlap_policy", "UNKNOWN, REVIEW, and overlap hold policy",
          `A missing field or incomplete history remains UNKNOWN, never inactive. Multiple audience matches go to REVIEW. ${overlapText(proposal)} This item acknowledges safe hold policy only; it cannot stand in for any missing CRM field/value mapping.`,
          "Safe hold/UNKNOWN/REVIEW policy acknowledged",
        ),
        policyItem("configured_numeric_policy", "Configured numeric rules and cross-campaign caps", numericProposal, "Configured numeric values reviewed as proposed"),
        ...audienceItems,
      ],
    },
    {
      id: "consent",
      title: "Consent, suppression, and communication controls",
      guidance: "Deliverability is not consent. Setup review does not establish individual recipient consent or authorize sending.",
      items: [
        mapping({
          id: "email_deliverability", title: "Email deliverability",
          guidance: "Map address-health/delivery status separately from permission. A deliverable address is not consent.",
          entities: ["people"], acceptedFieldSemantics: ["deliverability"], eligible: ["deliverability_status_mapped"],
          meanings: [meaning("deliverability_status_mapped", "Confirmed deliverability-status mapping"), meaning("unknown", "Deliverability remains UNKNOWN")],
        }),
        mapping({
          id: "email_consent_permission", title: "Email consent and permission",
          guidance: "Map exact explicit email permission values separately from address health; unknown permission stays blocked.",
          entities: ["people"], acceptedFieldSemantics: ["email_consent"], eligible: ["explicit_email_permission"],
          meanings: [meaning("explicit_email_permission", "Confirmed explicit email permission value"), meaning("not_permission", "Not evidence of permission"), meaning("unknown", "Permission remains UNKNOWN")],
        }),
        mapping({
          id: "email_opt_out_precedence_sync", title: "DNC, unsubscribe precedence, and synchronization",
          guidance: "Map exact DNC/unsubscribe/suppression values and confirm synchronization. DNC and unsubscribe take precedence over positive permission.",
          entities: ["people"], acceptedFieldSemantics: ["suppression"], eligible: ["suppression_precedence_mapped"],
          meanings: [meaning("suppression_precedence_mapped", "Suppression values and precedence confirmed"), meaning("not_suppressed", "Explicit not-suppressed state"), meaning("unknown", "Suppression status remains UNKNOWN")],
        }),
        mapping({
          id: "sender_reply_human_approval", title: "Sender, reply handling, and human release",
          guidance: "Confirm a named individual sender, reply ownership/handling, and a human approval requirement. Team-sender exception remains unapproved and unimplemented.",
          entities: ["people", "users"], acceptedFieldSemantics: ["sender_identity", "agent_assignment"], eligible: ["named_human_required"],
          fieldRequired: false, confirmedValuesRequired: false,
          meanings: [meaning("named_human_required", "Named human sender/reviewer required"), meaning("team_sender_exception", "Team-sender exception remains unapproved"), meaning("unresolved", "Sender/reply handling is unresolved")],
        }),
        policyItem("sms_disabled", "SMS remains disabled", "SMS remains disabled until separate implementation, channel-specific consent review, sender controls, and explicit approval.", "SMS disabled policy acknowledged"),
      ],
    },
  ];
}

export function fieldSemanticsFor(entity: string, name: string): string[] {
  const path = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const result = new Set<string>();
  if (entity === "stages" || /stage/.test(path)) result.add("stage");
  if (/tag/.test(path)) result.add("tag");
  if (/(^|_)status($|_)|state/.test(path)) result.add("status");
  if (/assigned|assignee|owner|agent|user/.test(path)) result.add("agent_assignment");
  if (/excl|hold|dnc|unsubscribe|opt_out|suppress|archive|inactive/.test(path)) {
    result.add("exclusion");
    result.add("suppression");
  }
  if (/transaction|deal|contract|closed|won|purchase/.test(path) || (entity === "deals" && /status|stage/.test(path))) result.add("transaction_status");
  if (/source|origin|campaign/.test(path)) result.add("lead_source");
  if (/market/.test(path)) result.add("market");
  if (/city|state|zip|postal|address|property|location/.test(path)) result.add("property_location");
  if (/price|amount|budget|value/.test(path)) result.add("price");
  if (/date|time|created|updated|activity|timestamp/.test(path)) result.add("activity_timestamp");
  if (/event|activity|event_type/.test(path) || (entity === "events" && /(^|_)type($|_)/.test(path))) result.add("event_type");
  if (/buyer|search|view|tour/.test(path)) result.add("buyer_interest");
  if (/past.?client|relationship|client/.test(path)) {
    result.add("past_client");
    result.add("relationship");
  }
  if (/sphere|referral/.test(path)) result.add("sphere");
  if (/email|bounce|deliver|valid/.test(path)) result.add("deliverability");
  if (/consent|permission|marketing.?allowed/.test(path)) result.add("email_consent");
  if (/sender/.test(path)) result.add("sender_identity");
  return [...result].sort();
}

export function emptyReviewState(sourceVersion: string, ruleVersion: string, inventoryGeneratedAt: string | null): ReviewState {
  return { revision: 0, sourceVersion, ruleVersion, inventoryGeneratedAt, answers: {}, sectionApprovals: {}, finalSignoff: null };
}

function sectionIndex(sections: ReviewSection[], sectionId: string) {
  const index = sections.findIndex((section) => section.id === sectionId);
  if (index < 0) throw new ApprovalValidationError("Unknown approval section.");
  return index;
}

export function assertApprover(actor: Approver) {
  if (!actor.canApprove || !actor.userId || !["Cassandra", "Caitlin"].includes(actor.reviewerLabel)) {
    throw new ApprovalAuthorityError("Reviewer approval authority is required to save, approve, reset, or finalize this review.");
  }
}

export function assertExpectedRevision(actual: number, expected: number) {
  if (actual !== expected) throw new StaleApprovalError("This review changed in another request. Reload the latest revision before saving.");
}

export function assertMutationSource(storedSourceVersion: string, currentSourceVersion: string, action: ApprovalAction["action"]) {
  if (storedSourceVersion !== currentSourceVersion && action !== "reset") {
    throw new StaleApprovalError("This review is stale because inventory, rules, or approval definitions changed. Explicitly reset it before continuing.");
  }
}

const ISO_DATE_OR_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const containsContactData = (value: string) => {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return true;
  const withoutIsoDates = value.replace(ISO_DATE_OR_TIMESTAMP, (candidate) => {
    const date = candidate.slice(0, 10);
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date) ? " " : candidate;
  });
  return /\+?\d[\d\s().-]{8,}\d/.test(withoutIsoDates);
};

export function validateReviewAnswer(item: ReviewItem, answer: ReviewAnswer, fields: FieldOption[]) {
  if (!["pending", "approved", "needs_changes"].includes(answer.decision)) {
    throw new ApprovalValidationError(`Invalid review decision for ${item.title}.`);
  }
  if (!Array.isArray(answer.confirmedValues) || answer.confirmedValues.length > 40
    || answer.confirmedValues.some((value) => typeof value !== "string" || value.length > 120 || containsContactData(value))) {
    throw new ApprovalValidationError("Confirmed mapping values must be a bounded list of non-contact value labels.");
  }
  if ([answer.evidence, answer.notes].some((text) => typeof text !== "string")
    || containsContactData(answer.evidence) || containsContactData(answer.notes)) {
    throw new ApprovalValidationError("Do not store contact details in approval evidence or notes; use a non-contact source reference.");
  }
  if (answer.fieldId !== null) {
    const field = fields.find((option) => option.id === answer.fieldId);
    if (!field || !item.entities.includes(field.entity)
      || !field.semantics.some((semantic) => item.acceptedFieldSemantics.includes(semantic))) {
      throw new ApprovalValidationError(`Select a current observed field with relevant semantics for ${item.title}.`);
    }
  } else if (answer.decision === "approved" && item.fieldRequired) {
    throw new ApprovalValidationError(`A relevant current observed field is required for ${item.title}.`);
  }
  if (answer.meaning !== null && !item.meanings.some((option) => option.value === answer.meaning)) {
    throw new ApprovalValidationError(`Select an explicit meaning value for ${item.title}.`);
  }
  if (answer.decision !== "pending") {
    if (!answer.evidence.trim()) throw new ApprovalValidationError(`Add a review evidence reference for ${item.title}.`);
    if (!answer.meaning) throw new ApprovalValidationError(`Confirm the explicit meaning for ${item.title}.`);
  }
  if (answer.evidence.length > 500 || answer.notes.length > 1000) {
    throw new ApprovalValidationError("Evidence references and notes exceed the allowed text limit.");
  }
}

export function answerEligibilityBlockers(item: ReviewItem, answer: ReviewAnswer | undefined, fields: FieldOption[]): string[] {
  if (!answer) return [`${item.title}: no saved answer.`];
  const blockers: string[] = [];
  try {
    validateReviewAnswer(item, answer, fields);
  } catch (error) {
    blockers.push(error instanceof Error ? `${item.title}: ${error.message}` : `${item.title}: answer is invalid.`);
  }
  if (answer.decision !== "approved") blockers.push(`${item.title}: item decision is ${answer.decision}.`);
  if (!answer.meaning || !item.approvalEligibleMeanings.includes(answer.meaning)) {
    blockers.push(`${item.title}: selected meaning is not approval-eligible; unknown, unresolved, and negative meanings cannot approve a required mapping.`);
  }
  if (item.fieldRequired) {
    const field = fields.find((option) => option.id === answer.fieldId);
    if (!field || !item.entities.includes(field.entity)
      || !field.semantics.some((semantic) => item.acceptedFieldSemantics.includes(semantic))) {
      blockers.push(`${item.title}: a relevant current observed field is required.`);
    }
  }
  const confirmedEmptyAssignment = item.id === "agent_assignment" && answer.meaning === "unassigned_agent";
  if (item.confirmedValuesRequired && !confirmedEmptyAssignment
    && (!Array.isArray(answer.confirmedValues) || !answer.confirmedValues.some((value) => typeof value === "string" && value.trim()))) {
    blockers.push(`${item.title}: enter exact confirmed CRM value labels; references and notes are not values.`);
  }
  if (typeof answer.evidence !== "string" || !answer.evidence.trim()) blockers.push(`${item.title}: a review evidence reference is required.`);
  return blockers;
}

export function assertReviewAnswerEligible(item: ReviewItem, answer: ReviewAnswer, fields: FieldOption[]) {
  validateReviewAnswer(item, answer, fields);
  const blockers = answerEligibilityBlockers(item, answer, fields);
  if (blockers.length) throw new ApprovalValidationError(blockers[0]);
}

export function createReviewStateSnapshot(state: ReviewState, sections: ReviewSection[], fields: FieldOption[]): ReviewState {
  const items = new Map(sections.flatMap((section) => section.items.map((item) => [item.id, item] as const)));
  const answers = Object.fromEntries(Object.entries(state.answers).map(([itemId, answer]) => {
    const item = items.get(itemId);
    if (!item) throw new ApprovalValidationError("Stored review state references an unknown approval item; reset the review before continuing.");
    validateReviewAnswer(item, answer, fields);
    if (answer.decision === "needs_changes" && !answer.notes.trim()) {
      throw new ApprovalValidationError(`Add a bounded note explaining why ${item.title} needs changes.`);
    }
    return [itemId, {
      fieldId: answer.fieldId,
      meaning: answer.meaning,
      confirmedValues: [...answer.confirmedValues],
      evidence: answer.evidence,
      decision: answer.decision,
      notes: answer.notes,
    }];
  }));
  const sectionApprovals = Object.fromEntries(Object.entries(state.sectionApprovals).map(([sectionId, approval]) => [
    sectionId,
    {
      userId: approval.userId,
      reviewerLabel: approval.reviewerLabel,
      approvedAt: approval.approvedAt,
      revision: approval.revision,
    },
  ]));
  const finalSignoff = state.finalSignoff ? {
    userId: state.finalSignoff.userId,
    reviewerLabel: state.finalSignoff.reviewerLabel,
    signedAt: state.finalSignoff.signedAt,
    revision: state.finalSignoff.revision,
    proposalOnly: true as const,
  } : null;
  return {
    revision: state.revision,
    sourceVersion: state.sourceVersion,
    ruleVersion: state.ruleVersion,
    inventoryGeneratedAt: state.inventoryGeneratedAt,
    answers,
    sectionApprovals,
    finalSignoff,
  };
}

const answerContent = (answer: ReviewAnswer) => JSON.stringify({
  fieldId: answer.fieldId, meaning: answer.meaning, confirmedValues: answer.confirmedValues, evidence: answer.evidence, notes: answer.notes,
});

export function applyAnswerChanges(state: ReviewState, incoming: Record<string, ReviewAnswer>, sections: ReviewSection[], fields: FieldOption[]): ReviewState {
  const itemSections = new Map<string, { item: ReviewItem; index: number }>();
  sections.forEach((section, index) => section.items.forEach((item) => itemSections.set(item.id, { item, index })));
  const nextAnswers = { ...state.answers };
  const changedSections = new Set<number>();
  for (const [itemId, answer] of Object.entries(incoming)) {
    const location = itemSections.get(itemId);
    if (!location) throw new ApprovalValidationError("An answer references an unknown review item.");
    validateReviewAnswer(location.item, answer, fields);
    const previous = nextAnswers[itemId];
    if (!previous || answerContent(previous) !== answerContent(answer) || previous.decision !== "pending") changedSections.add(location.index);
    // Save is draft-only. Approval requires the explicit review_item action.
    nextAnswers[itemId] = { ...answer, confirmedValues: [...answer.confirmedValues], decision: "pending" };
  }
  if (changedSections.size) {
    const earliest = Math.min(...changedSections);
    for (const [itemId, answer] of Object.entries(nextAnswers)) {
      const index = itemSections.get(itemId)!.index;
      if (index > earliest) nextAnswers[itemId] = { ...answer, decision: "pending" };
    }
    const approvals = { ...state.sectionApprovals };
    sections.forEach((section, index) => { if (index >= earliest) delete approvals[section.id]; });
    return { ...state, answers: nextAnswers, sectionApprovals: approvals, finalSignoff: null };
  }
  return { ...state, answers: nextAnswers };
}

export function reviewItem(
  state: ReviewState, itemId: string, answer: ReviewAnswer, actor: Approver,
  sections: ReviewSection[], fields: FieldOption[], now: string,
): ReviewState {
  assertApprover(actor);
  if (state.finalSignoff) throw new ApprovalValidationError("The setup is already finally approved; reset the review before making changes.");
  const section = sections.find((candidate) => candidate.items.some((item) => item.id === itemId));
  if (!section) throw new ApprovalValidationError("Unknown approval item.");
  const sectionPosition = sectionIndex(sections, section.id);
  if (sectionPosition > 0 && !state.sectionApprovals[sections[sectionPosition - 1].id]) {
    throw new ApprovalValidationError("Approve the previous section before approving or marking this item needs changes.");
  }
  const item = section.items.find((candidate) => candidate.id === itemId)!;
  if (answer.decision === "approved") assertReviewAnswerEligible(item, answer, fields);
  else if (answer.decision !== "needs_changes") throw new ApprovalValidationError("Use Save draft for pending item edits.");
  else {
    validateReviewAnswer(item, answer, fields);
    if (!answer.notes.trim()) throw new ApprovalValidationError("Add a bounded note explaining why this item needs changes.");
  }
  const nextAnswers = { ...state.answers, [itemId]: { ...answer, confirmedValues: [...answer.confirmedValues] } };
  const approvals = { ...state.sectionApprovals };
  sections.forEach((candidate, index) => { if (index >= sectionPosition) delete approvals[candidate.id]; });
  for (const candidate of sections.slice(sectionPosition + 1)) {
    for (const downstream of candidate.items) {
      if (nextAnswers[downstream.id]) nextAnswers[downstream.id] = { ...nextAnswers[downstream.id], decision: "pending" };
    }
  }
  return {
    ...state, answers: nextAnswers, sectionApprovals: approvals, finalSignoff: null,
    // The audit record itself is written transactionally by the service.
    revision: state.revision,
  };
}

export function approveSection(state: ReviewState, sectionId: string, actor: Approver, sections: ReviewSection[], fields: FieldOption[], now: string): ReviewState {
  assertApprover(actor);
  const index = sectionIndex(sections, sectionId);
  if (state.finalSignoff) throw new ApprovalValidationError("The setup is already finally approved; reset the review before making changes.");
  if (index > 0 && !state.sectionApprovals[sections[index - 1].id]) {
    throw new ApprovalValidationError("Approve the previous section before approving this section.");
  }
  for (const item of sections[index].items) {
    const answer = state.answers[item.id];
    if (!answer || answer.decision !== "approved") {
      throw new ApprovalValidationError(`Every required item in ${sections[index].title} must be explicitly approved first.`);
    }
    assertReviewAnswerEligible(item, answer, fields);
  }
  return {
    ...state,
    sectionApprovals: {
      ...state.sectionApprovals,
      [sectionId]: { userId: actor.userId, reviewerLabel: actor.reviewerLabel, approvedAt: now, revision: state.revision + 1 },
    },
    finalSignoff: null,
  };
}

export function currentFinalApprovalBlockers(
  state: ReviewState, sections: ReviewSection[], fields: FieldOption[], inventoryComplete: boolean,
): string[] {
  const blockers: string[] = [];
  if (!inventoryComplete) blockers.push("A complete current masked inventory is required before final setup signoff.");
  for (const [index, section] of sections.entries()) {
    if (!state.sectionApprovals[section.id]) blockers.push(`Section ${section.title} is not approved.`);
    else if (index > 0 && !state.sectionApprovals[sections[index - 1].id]) blockers.push(`Section ${section.title} does not follow an approved prior section.`);
    for (const item of section.items) blockers.push(...answerEligibilityBlockers(item, state.answers[item.id], fields));
  }
  return blockers;
}

export function finalizeReview(
  state: ReviewState, actor: Approver, sections: ReviewSection[], fields: FieldOption[],
  inventoryComplete: boolean, confirmProposalOnly: boolean, now: string,
): ReviewState {
  assertApprover(actor);
  if (state.finalSignoff) throw new ApprovalValidationError("The setup already has a final signoff; Cassandra or Caitlin may sign off, but not both.");
  if (!confirmProposalOnly) throw new ApprovalValidationError("Explicitly confirm that this approves only the proposed setup.");
  const blockers = currentFinalApprovalBlockers(state, sections, fields, inventoryComplete);
  if (blockers.length) throw new ApprovalValidationError(blockers[0]);
  return {
    ...state,
    finalSignoff: {
      userId: actor.userId, reviewerLabel: actor.reviewerLabel, signedAt: now,
      revision: state.revision + 1, proposalOnly: true,
    },
  };
}