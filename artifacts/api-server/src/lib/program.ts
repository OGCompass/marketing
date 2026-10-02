import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { workspaceRoot } from "./workspace-root";

type ProgramConfig = {
  status: string;
  pilot_markets: string[];
  discovery: {
    people_sample: number;
    events_sample: number;
    deals_sample: number;
    definitions_limit: number;
    expected_custom_fields: string[];
  };
  markets: Record<string, string>;
  audiences: { code: string; name: string; purpose: string; cadenceDays: number; contentDirection: string; identificationRules: string[]; reviewNotes: string[]; unassignedDirection: string }[];
  classification_steps: string[];
  assignment_strategies: { code: string; name: string; identification: string; communicationDirection: string; responsibleParty: string; releaseRequirements: string[] }[];
  price_bands: { code: string; label: string; min?: number; max_exclusive?: number }[];
  hard_gates: string[];
  unresolved_rules: string[];
  sms_requirements: string[];
  windows: Record<string, number>;
  limits: Record<string, number>;
};

let activeProgram: { config: ProgramConfig; ruleVersion: string } | null = null;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && !!value.trim();

export function validateProgramConfig(config: ProgramConfig): ProgramConfig {
  if (!config || typeof config !== "object"
    || !config.discovery || typeof config.discovery !== "object" || !Array.isArray(config.discovery.expected_custom_fields)
    || !Array.isArray(config.audiences) || !config.markets || !config.windows || !config.limits
    || typeof config.markets !== "object" || Array.isArray(config.markets)
    || typeof config.windows !== "object" || Array.isArray(config.windows)
    || typeof config.limits !== "object" || Array.isArray(config.limits)
    || !Array.isArray(config.pilot_markets) || !Array.isArray(config.price_bands)
    || !Array.isArray(config.classification_steps) || !Array.isArray(config.assignment_strategies)
    || !Array.isArray(config.hard_gates) || !Array.isArray(config.unresolved_rules)
    || !Array.isArray(config.sms_requirements)) {
    throw new Error("Invalid segmentation configuration.");
  }
  const requiredWindowKeys = ["buyer_days", "nurture_min_days", "nurture_max_days", "dormant_min_days", "event_market_days", "sync_event_history_days"];
  const requiredLimitKeys = ["reviewed_contacts_required", "golden_contacts_required", "accuracy_percent", "dormant_attempts", "market_events_required", "program_emails_per_30_days"];
  for (const key of requiredWindowKeys) {
    if (!positiveInteger(config.windows[key])) throw new Error(`Invalid positive integer segmentation window: ${key}.`);
  }
  for (const key of requiredLimitKeys) {
    if (!positiveInteger(config.limits[key])) throw new Error(`Invalid positive integer segmentation limit: ${key}.`);
  }
  for (const [key, value] of Object.entries(config.windows)) {
    if (!positiveInteger(value)) throw new Error(`Invalid positive integer segmentation window: ${key}.`);
  }
  for (const [key, value] of Object.entries(config.limits)) {
    if (!positiveInteger(value)) throw new Error(`Invalid positive integer segmentation limit: ${key}.`);
  }
  if (config.windows.nurture_max_days < config.windows.nurture_min_days) throw new Error("The configured nurture window must have a positive ordered range.");
  if (config.windows.sync_event_history_days < Math.max(config.windows.buyer_days, config.windows.nurture_max_days, config.windows.dormant_min_days, config.windows.event_market_days)) {
    throw new Error("The configured synchronized event-history window must cover all segmentation evidence windows.");
  }
  if (config.limits.accuracy_percent > 100 || config.limits.golden_contacts_required > config.limits.reviewed_contacts_required) {
    throw new Error("Configured accuracy and reviewed-contact limits are incoherent.");
  }
  for (const [key, value] of Object.entries(config.discovery)) {
    if (key === "expected_custom_fields") continue;
    if (!positiveInteger(value)) throw new Error(`Invalid positive integer discovery limit: ${key}.`);
  }
  if (!config.pilot_markets.length || config.pilot_markets.some((market) => !nonEmptyString(market) || !config.markets[market])
    || config.discovery.expected_custom_fields.some((field) => !nonEmptyString(field))
    || Object.values(config.markets).some((market) => !nonEmptyString(market))) {
    throw new Error("Every configured pilot market must have a market definition.");
  }
  const audienceCodes = new Set<string>();
  for (const audience of config.audiences) {
    if (!audience || !nonEmptyString(audience.code) || audienceCodes.has(audience.code) || !nonEmptyString(audience.name) || !positiveInteger(audience.cadenceDays)
      || !nonEmptyString(audience.purpose) || !nonEmptyString(audience.contentDirection) || !Array.isArray(audience.identificationRules)
      || !audience.identificationRules.length || !Array.isArray(audience.reviewNotes)
      || !audience.identificationRules.every(nonEmptyString)
      || !audience.reviewNotes.every(nonEmptyString)
      || !nonEmptyString(audience.unassignedDirection)) {
      throw new Error("Every audience needs a unique code, positive cadence, purpose, content direction, and identification rules.");
    }
    audienceCodes.add(audience.code);
  }
  const requiredAudienceCodes = ["BUY", "OWN", "SPH", "NUR", "DOR"];
  if (audienceCodes.size !== requiredAudienceCodes.length
    || requiredAudienceCodes.some((code) => !audienceCodes.has(code))) {
    throw new Error("The segmentation blueprint must define BUY, OWN, SPH, NUR, and DOR audience proposals for guided review.");
  }
  let previousMaximum: number | null = null;
  let openEndedNumericBandSeen = false;
  const priceBandCodes = new Set<string>();
  for (const band of config.price_bands) {
    if (!band || !nonEmptyString(band.code) || priceBandCodes.has(band.code) || !nonEmptyString(band.label)) {
      throw new Error("Price bands require unique codes and labels.");
    }
    priceBandCodes.add(band.code);
    const hasMin = band.min !== undefined;
    const hasMax = band.max_exclusive !== undefined;
    if (!hasMin && !hasMax) continue;
    if (openEndedNumericBandSeen) throw new Error("No numeric price band may follow an unbounded configured price band.");
    if ((hasMin && (!Number.isFinite(band.min) || band.min! < 0))
      || (hasMax && (!Number.isFinite(band.max_exclusive) || band.max_exclusive! <= (hasMin ? band.min! : 0)))
      || (!hasMin && hasMax)) {
      throw new Error(`Invalid configured price range: ${band.code}.`);
    }
    if (previousMaximum !== null && band.min! < previousMaximum) throw new Error("Configured numeric price bands must be ordered and non-overlapping.");
    previousMaximum = band.max_exclusive ?? null;
    if (!hasMax) openEndedNumericBandSeen = true;
  }
  if (config.classification_steps.some((step) => !nonEmptyString(step))
    || config.hard_gates.some((gate) => !nonEmptyString(gate))
    || config.unresolved_rules.some((rule) => !nonEmptyString(rule))
    || config.sms_requirements.some((requirement) => !nonEmptyString(requirement))
    || config.assignment_strategies.some((strategy) => !strategy || !nonEmptyString(strategy.code) || !nonEmptyString(strategy.name)
      || !nonEmptyString(strategy.identification) || !nonEmptyString(strategy.communicationDirection) || !nonEmptyString(strategy.responsibleParty)
      || !Array.isArray(strategy.releaseRequirements) || !strategy.releaseRequirements.length
      || strategy.releaseRequirements.some((requirement) => !nonEmptyString(requirement)))) {
    throw new Error("Classification, assignment, gate, and communication rules must be complete non-empty text.");
  }
  return config;
}

export function loadProgram() {
  if (!activeProgram) {
    // This process uses one immutable configuration snapshot. Updating YAML takes
    // effect only after a process restart, which changes the rule version.
    const source = readFileSync(join(workspaceRoot(), "config/segmentation.yaml"), "utf8");
    const config = deepFreeze(validateProgramConfig(parse(source) as ProgramConfig));
    activeProgram = Object.freeze({ config, ruleVersion: createHash("sha256").update(source).digest("hex") });
  }
  return activeProgram;
}

export function programBlueprint() {
  const { config, ruleVersion } = loadProgram();
  const values: Record<string, string | number> = { ...config.windows, ...config.limits, pilot_markets: config.pilot_markets.join(", ") };
  const explain = (text: string) => text.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (_match, key: string) => {
    if (values[key] == null || (typeof values[key] === "number" && !Number.isFinite(values[key]))) throw new Error("Invalid communication-strategy rule reference.");
    return String(values[key]);
  });
  const unresolvedRules = [...config.unresolved_rules];
  const overlapStart = Math.max(config.windows.nurture_min_days, config.windows.dormant_min_days);
  const overlapEnd = config.windows.nurture_max_days;
  if (overlapStart <= overlapEnd) {
    unresolvedRules.push(`The configured nurture and dormant windows overlap from ${overlapStart} through ${overlapEnd} days. This overlap requires human review; every overlap match requires REVIEW. No additional threshold or automatic category choice is introduced.`);
  }
  return {
    ruleVersion,
    status: config.status,
    audiences: config.audiences.map((audience) => ({
      ...audience,
      identificationRules: audience.identificationRules.map(explain),
      reviewNotes: audience.reviewNotes.map(explain),
    })),
    classificationSteps: config.classification_steps.map(explain),
    assignmentStrategies: config.assignment_strategies,
    priceBands: config.price_bands.map(({ code, label, min, max_exclusive }) => ({ code, label, ...(min === undefined ? {} : { min }), ...(max_exclusive === undefined ? {} : { maxExclusive: max_exclusive }) })),
    numericRules: { windows: { ...config.windows }, limits: { ...config.limits } },
    markets: Object.entries(config.markets).map(([code, city]) => `${code} — ${city}`),
    hardGates: config.hard_gates,
    unresolvedRules,
    smsRequirements: config.sms_requirements,
  };
}