import type { ProgramBlueprint } from "@workspace/api-client-react";

/** Protect spreadsheet formulas as well as RFC 4180 commas, quotes and newlines. */
function cell(value: string | number): string {
  const text = String(value);
  const protectedText = /^[=+\-@]/.test(text.trimStart()) || /^[\t\r\n]/.test(text)
    ? `'${text}`
    : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

export function serializeStrategyCsv(blueprint: ProgramBlueprint): string {
  const assigned = blueprint.assignmentStrategies.find((strategy) => strategy.code === "ASSIGNED");
  const unassigned = blueprint.assignmentStrategies.find((strategy) => strategy.code === "UNASSIGNED");
  const review = blueprint.assignmentStrategies.find((strategy) => strategy.code === "REVIEW");
  if (!assigned || !unassigned || !review) {
    throw new Error("Required assignment strategy is missing; CSV export cannot continue.");
  }
  const headers = [
    "rule_version", "strategy_status", "category_code", "category_name",
    "category_purpose", "identifying_evidence", "category_review_notes",
    "proposed_cadence_days", "content_direction", "assigned_client_handling",
    "unassigned_identification", "unassigned_category_strategy",
    "unassigned_shared_strategy", "unassigned_responsible_party",
    "unassigned_release_requirements", "unknown_assignment_handling",
    "classification_process", "market_definitions", "price_variants",
    "send_gates", "unresolved_rules", "sms_requirements", "ready_to_send",
  ];
  const audiences = [
    ...blueprint.audiences,
    {
      code: "UNKNOWN_REVIEW",
      name: "Unknown / needs review — not a sending audience",
      purpose: "Insufficient or conflicting evidence prevents classification.",
      identificationRules: ["Missing, unreadable or contradictory evidence; multiple categories without an approved precedence rule; overlapping activity windows."],
      reviewNotes: ["Human review is required. Do not default to dormant, unassigned, or a guessed market."],
      cadenceDays: 0,
      contentDirection: "No outreach until evidence and permission are resolved.",
      unassignedDirection: "Reconcile audience and assignment evidence before considering the proposed team-managed queue.",
    },
  ];
  const rows = audiences.map((audience) => [
    blueprint.ruleVersion,
    `Proposal only — ${blueprint.status}; not active`,
    audience.code,
    audience.name,
    audience.purpose,
    audience.identificationRules.join("\n"),
    audience.reviewNotes.join("\n"),
    audience.cadenceDays > 0 ? audience.cadenceDays : "No send",
    audience.contentDirection,
    `${assigned.identification}\n${assigned.communicationDirection}\nResponsible: ${assigned.responsibleParty}\n${assigned.releaseRequirements.join("\n")}`,
    unassigned.identification,
    audience.unassignedDirection,
    unassigned.communicationDirection,
    unassigned.responsibleParty,
    unassigned.releaseRequirements.join("\n"),
    `${review.identification}\n${review.communicationDirection}\nResponsible: ${review.responsibleParty}\n${review.releaseRequirements.join("\n")}`,
    blueprint.classificationSteps.join("\n"),
    blueprint.markets.join("\n"),
    blueprint.priceBands.map((band) => `${band.code}: ${band.label}`).join("\n"),
    blueprint.hardGates.join("\n"),
    blueprint.unresolvedRules.join("\n"),
    blueprint.smsRequirements.join("\n"),
    "NO — strategy and rules only; no client records or send-ready recipients",
  ]);
  return "\uFEFF" + [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}