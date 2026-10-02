import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadProgram, programBlueprint, validateProgramConfig } from "./program";
import { workspaceRoot } from "./workspace-root";

function sourceConfig() {
  return JSON.parse(JSON.stringify(parse(readFileSync(join(workspaceRoot(), "config/segmentation.yaml"), "utf8"))));
}

test("blueprint preserves actual configured numeric rules and actual numeric price boundaries", () => {
  const { config, ruleVersion } = loadProgram();
  const blueprint = programBlueprint();
  assert.match(ruleVersion, /^[a-f0-9]{64}$/);
  assert.equal(blueprint.numericRules.windows.buyer_days, config.windows.buyer_days);
  assert.equal(blueprint.numericRules.limits.program_emails_per_30_days, config.limits.program_emails_per_30_days);
  assert.deepEqual(blueprint.priceBands.map(({ min, maxExclusive }) => [min, maxExclusive]), [
    [0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 8_000_000], [8_000_000, undefined], [undefined, undefined],
  ]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.windows), true);
});

test("invalid or incoherent numeric rules and price-band overlap are rejected", () => {
  const wrongWindow = sourceConfig();
  wrongWindow.windows.buyer_days = 0;
  assert.throws(() => validateProgramConfig(wrongWindow), /positive integer segmentation window: buyer_days/);

  const insufficientHistory = sourceConfig();
  insufficientHistory.windows.sync_event_history_days = 90;
  assert.throws(() => validateProgramConfig(insufficientHistory), /must cover all segmentation evidence windows/);

  const unorderedBands = sourceConfig();
  unorderedBands.price_bands[1].min = 1_999_999;
  assert.throws(() => validateProgramConfig(unorderedBands), /ordered and non-overlapping/);

  const numericBandAfterOpenEnded = sourceConfig();
  numericBandAfterOpenEnded.price_bands.splice(4, 0, {
    code: "P5", label: "Invalid later band", min: 9_000_000, max_exclusive: 10_000_000,
  });
  assert.throws(() => validateProgramConfig(numericBandAfterOpenEnded), /No numeric price band may follow an unbounded/);
});

test("the reviewed audience set and configured minimum sample guarantees are required", () => {
  const fewerAudiences = sourceConfig();
  fewerAudiences.audiences = fewerAudiences.audiences.filter((audience: { code: string }) => audience.code !== "DOR");
  assert.throws(() => validateProgramConfig(fewerAudiences), /must define BUY, OWN, SPH, NUR, and DOR/);

  const invalidAccuracy = sourceConfig();
  invalidAccuracy.limits.accuracy_percent = 101;
  assert.throws(() => validateProgramConfig(invalidAccuracy), /accuracy and reviewed-contact limits/);
});