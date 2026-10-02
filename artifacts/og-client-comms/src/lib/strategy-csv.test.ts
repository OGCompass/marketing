import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProgramBlueprint } from "@workspace/api-client-react";
import { serializeStrategyCsv } from "./strategy-csv";

function fixture(): ProgramBlueprint {
  return {
    ruleVersion: "fixture-rule-version",
    status: "awaiting_inventory_review",
    audiences: ["BUY", "OWN", "SPH", "NUR", "DOR"].map((code) => ({
      code, name: code, purpose: "Reviewed evidence",
      cadenceDays: 30, contentDirection: "Proposed resources",
      identificationRules: ["Confirmed mapping"],
      reviewNotes: ["Do not infer missing evidence"],
      unassignedDirection: "Team review and handoff",
    })),
    assignmentStrategies: ["ASSIGNED", "UNASSIGNED", "REVIEW"].map((code) => ({
      code, name: code, identification: "Reviewed relationship",
      communicationDirection: "Human-managed routing",
      responsibleParty: "Named reviewer",
      releaseRequirements: ["Approve an assigned-agent exception before team sends"],
    })),
    classificationSteps: ["Evidence first, human review before sending"],
    priceBands: [{ code: "GENERAL", label: "Unknown price" }],
    markets: ["BUR — Burlingame"],
    hardGates: ["Consent, suppression, named approval"],
    unresolvedRules: ["Resolve conflicting evidence"],
    smsRequirements: ["Channel-specific consent"],
  };
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const source = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(value); value = "";
    } else if (!quoted && char === "\r" && source[i + 1] === "\n") {
      row.push(value); rows.push(row); row = []; value = ""; i++;
    } else value += char;
  }
  assert.equal(quoted, false);
  assert.equal(value, "");
  return rows;
}

test("CSV includes every category, unknown review, routing, gates and version, with no recipient records", () => {
  const blueprint = fixture();
  const csv = serializeStrategyCsv(blueprint);
  assert.ok(csv.startsWith("\uFEFF"));
  const [headers, ...rows] = parseCsv(csv);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.length === headers.length));
  assert.deepEqual(rows.map((row) => row[headers.indexOf("category_code")]), ["BUY", "OWN", "SPH", "NUR", "DOR", "UNKNOWN_REVIEW"]);
  assert.ok(rows.every((row) => row[0] === blueprint.ruleVersion));
  assert.ok(rows.every((row) => row[headers.indexOf("ready_to_send")].startsWith("NO")));
  assert.ok(rows.every((row) => row[headers.indexOf("unassigned_release_requirements")].includes("assigned-agent")));
  assert.ok(!headers.some((header) => ["email", "phone", "client_name", "client_id"].includes(header)));
});

test("CSV preserves commas, quotes and newlines, and neutralizes spreadsheet formulas", () => {
  const blueprint = fixture();
  blueprint.audiences[0].name = 'A, "quoted"\ncategory';
  blueprint.audiences[1].name = '=HYPERLINK("https://example.test")';
  blueprint.audiences[2].name = "  +1+1";
  blueprint.audiences[3].name = "\t@SUM(1,2)";
  blueprint.audiences[4].name = "-1+1";
  const [headers, ...rows] = parseCsv(serializeStrategyCsv(blueprint));
  const column = headers.indexOf("category_name");
  assert.equal(rows[0][column], blueprint.audiences[0].name);
  for (let i = 1; i < 5; i++) assert.equal(rows[i][column], "'" + blueprint.audiences[i].name);
});

test("CSV export refuses incomplete assignment strategy metadata", () => {
  const blueprint = fixture();
  blueprint.assignmentStrategies = [];
  assert.throws(() => serializeStrategyCsv(blueprint), /Required assignment strategy/);
});