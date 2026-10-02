import { test } from "node:test";
import assert from "node:assert/strict";
import { GetProgramBlueprintResponse } from "@workspace/api-zod";
import { programBlueprint, loadProgram } from "./program";

test("blueprint matches its API contract and resolves configured classification windows", () => {
  const blueprint = GetProgramBlueprintResponse.parse(programBlueprint());
  const { config } = loadProgram();
  assert.deepEqual(blueprint.audiences.map((audience) => audience.code), ["BUY", "OWN", "SPH", "NUR", "DOR"]);
  assert.match(blueprint.audiences[0].identificationRules.join(" "), new RegExp(`${config.windows.buyer_days}-day`));
  assert.match(blueprint.audiences[3].identificationRules.join(" "), new RegExp(`${config.windows.nurture_min_days}–${config.windows.nurture_max_days}`));
  assert.match(blueprint.classificationSteps.join(" "), new RegExp(`${config.limits.program_emails_per_30_days} program emails`));
  assert.match(blueprint.classificationSteps.join(" "), /BUR, LGA/);
  assert.equal(JSON.stringify(blueprint).includes("{{"), false);
});

test("unassigned is an ownership overlay with a proposed exception, not an activated audience", () => {
  const blueprint = programBlueprint();
  assert.deepEqual(blueprint.assignmentStrategies.map((strategy) => strategy.code), ["ASSIGNED", "UNASSIGNED", "REVIEW"]);
  const unassigned = blueprint.assignmentStrategies.find((strategy) => strategy.code === "UNASSIGNED")!;
  assert.match(unassigned.releaseRequirements.join(" "), /Explicitly approve and implement/);
  assert.match(blueprint.hardGates.join(" "), /currently required to send/);
  assert.match(blueprint.assignmentStrategies[2].communicationDirection, /Hold outreach/);
  assert.match(blueprint.unresolvedRules.join(" "), /overlap requires human review/);
});
