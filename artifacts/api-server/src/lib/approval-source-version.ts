import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function approvalSourceVersions(
  maskedInventory: unknown,
  ruleVersion: string,
  approvalDefinitions: unknown,
  validationPolicyVersion: string,
) {
  const approvalDefinitionVersion = createHash("sha256").update(canonicalJson({
    validationPolicyVersion,
    approvalDefinitions,
  })).digest("hex");
  const sourceVersion = createHash("sha256").update(canonicalJson({
    maskedInventory,
    ruleVersion,
    approvalDefinitionVersion,
  })).digest("hex");
  return { approvalDefinitionVersion, sourceVersion };
}