import { readSample, resources, FubReadError, type FubRecord, type FubResource } from "./client";
import { loadProgram } from "../program";

type Field = { name: string; type: string; populatedPercent: number; safeExample: string; redacted: boolean };
type Section = { entity: string; status: "read" | "failed"; sampleCount: number; fields: Field[] };
type Finding = { severity: "info" | "warning" | "blocker"; title: string; detail: string };
export type InventoryReport = {
  generatedAt: string;
  status: "complete" | "partial" | "failed";
  readOnly: boolean;
  contactsPersisted: number;
  sections: Section[];
  findings: Finding[];
  customFieldChecks: { expectedName: string; apiName: string | null; present: boolean }[];
  markdown: string;
};

const isPopulated = (value: unknown) => value != null && value !== "" && (!Array.isArray(value) || value.length > 0);
const valueType = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function safeSample(entity: FubResource, path: string, value: unknown): { text: string; redacted: boolean } {
  if (value == null) return { text: "null", redacted: false };
  if (Array.isArray(value)) return { text: "array — inspect nested field shapes", redacted: true };
  if (typeof value === "object") return { text: "object — inspect nested field shapes", redacted: true };
  if (typeof value === "boolean") return { text: String(value), redacted: false };
  // Never retain identifiers, prices, phone numbers, timestamps or free text from a person.
  if (typeof value === "number") return { text: "<number redacted>", redacted: true };
  const text = String(value);
  if (/email/i.test(path) || /@/.test(text)) return { text: "<email redacted>", redacted: true };
  if (/phone|mobile|fax/i.test(path)) return { text: "<phone redacted>", redacted: true };
  if (/street|address[12]|address$|name|message|note|description|url|link|token|key|password|id$/i.test(path)) {
    // Names are safe only for field/stage definitions, never for staff or people.
    if ((entity === "stages" || entity === "customFields") && /^(name|label|displayName|apiName)$/.test(path) && /^[a-zA-Z0-9 _-]{1,100}$/.test(text)) {
      return { text, redacted: false };
    }
    return { text: "<text redacted>", redacted: true };
  }
  if (/(^|\.)(city|state|country|type|status|stage)$/.test(path) && /^[a-zA-Z0-9 ._-]{1,60}$/.test(text)) {
    return { text, redacted: false };
  }
  if (/(zip|postalCode)$/i.test(path) && /^\d{5}(-\d{4})?$/.test(text)) return { text: text.slice(0, 5), redacted: false };
  return { text: "<text redacted>", redacted: true };
}

export function fieldInventory(entity: FubResource, rows: FubRecord[]): Field[] {
  const aggregate = new Map<string, { types: Set<string>; present: number; example: string; redacted: boolean }>();
  for (const row of rows) {
    const populated = new Set<string>();
    function visit(obj: Record<string, unknown>, prefix = "", depth = 0) {
      if (depth > 6) return;
      for (const [rawKey, value] of Object.entries(obj)) {
        // Values are never used as field names. Unexpected key syntax is replaced.
        const key = /^[a-zA-Z_][a-zA-Z0-9 _-]{0,100}$/.test(rawKey) ? rawKey : "<nonstandard-key>";
        const path = `${prefix}${key}`;
        const sample = safeSample(entity, path, value);
        const field = aggregate.get(path) ?? { types: new Set<string>(), present: 0, example: sample.text, redacted: sample.redacted };
        field.types.add(valueType(value));
        if (isPopulated(value)) {
          populated.add(path);
          if (field.example === "null") { field.example = sample.text; field.redacted = sample.redacted; }
        }
        aggregate.set(path, field);
        if (value && typeof value === "object" && !Array.isArray(value)) visit(value as FubRecord, `${path}.`, depth + 1);
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) visit(entry as FubRecord, `${path}[].`, depth + 1);
          }
        }
      }
    }
    visit(row);
    for (const path of populated) aggregate.get(path)!.present++;
  }
  return [...aggregate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, field]) => ({
    name, type: [...field.types].sort().join(" | "),
    populatedPercent: rows.length ? Math.round(field.present / rows.length * 1000) / 10 : 0,
    safeExample: field.example, redacted: field.redacted,
  }));
}

const markdownCell = (text: string) => text.replace(/[|\r\n]/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function inventoryMarkdown(report: Omit<InventoryReport, "markdown">) {
  const lines = [
    "# FUB field inventory — read-only discovery",
    `Generated: ${report.generatedAt}`, "",
    `Discovery status: **${report.status.toUpperCase()}**. A failed resource is not evidence of an empty CRM or missing fields.`, "",
    "**No contacts were stored.** Values shown below are non-identifying categorical examples or redaction labels.",
    "Population percentages describe this bounded sample only, not the full CRM. Missing signals are unconfirmed, not evidence of inactivity.", "",
    "## Findings",
    ...report.findings.map((finding) => `- **${finding.severity.toUpperCase()}: ${finding.title}** — ${finding.detail}`),
    "", "## Required custom fields", "| Field | Explicit API name | Found |", "|---|---|---|",
    ...report.customFieldChecks.map((field) => `| ${field.expectedName} | ${field.apiName ?? "Not confirmed — do not guess"} | ${field.present ? "Yes" : "No"} |`),
  ];
  for (const section of report.sections) {
    lines.push("", `## ${section.entity} (${section.status}; ${section.sampleCount} sampled)`, "| Field path | Type | % populated | Masked example |", "|---|---|---:|---|");
    for (const field of section.fields) lines.push(`| ${markdownCell(field.name)} | ${field.type} | ${field.populatedPercent}% | ${markdownCell(field.safeExample)} |`);
  }
  lines.push("", "## Approval boundary", "Review this inventory and confirm written Compass hosting permission before contact sync. Segmentation, write-back and sending remain disabled.");
  return lines.join("\n");
}

export async function discoverInventory(): Promise<InventoryReport> {
  const { config } = loadProgram();
  const limits: Record<FubResource, number> = {
    people: config.discovery.people_sample, events: config.discovery.events_sample, deals: config.discovery.deals_sample,
    stages: config.discovery.definitions_limit, users: config.discovery.definitions_limit, customFields: config.discovery.definitions_limit,
  };
  const findings: Finding[] = [];
  const results = await Promise.all(resources.map(async (resource) => {
    try {
      const result = await readSample(resource, limits[resource]);
      if (result.truncated && !["people", "events", "deals"].includes(resource)) {
        findings.push({ severity: "warning", title: `${resource}: definitions capped`, detail: `The ${limits[resource]}-record safety limit was reached. Review completeness before using mappings.` });
      }
      return { resource, rows: result.rows, readable: true, truncated: result.truncated };
    } catch (error) {
      const detail = error instanceof FubReadError ? error.message : "Discovery could not safely parse this resource. No response values were retained.";
      findings.push({ severity: "blocker", title: `${resource}: discovery failed`, detail });
      return { resource, rows: [] as FubRecord[], readable: false, truncated: false };
    }
  }));
  const sections: Section[] = results.map(({ resource, rows, readable }) => ({ entity: resource, status: readable ? "read" : "failed", sampleCount: rows.length, fields: fieldInventory(resource, rows) }));
  const definitionResult = results.find((result) => result.resource === "customFields")!;
  const definitions = definitionResult.rows;
  const canVerifyDefinitions = definitionResult.readable && !definitionResult.truncated;
  if (!canVerifyDefinitions) findings.push({ severity: "blocker", title: "Custom field verification unavailable", detail: "FUB definitions could not be completely read. The five OG fields are UNCONFIRMED, not missing. Do not create duplicates based on this failed discovery." });
  const customFieldChecks = (canVerifyDefinitions ? config.discovery.expected_custom_fields : []).map((expectedName) => {
    const record = definitions.find((definition) => [definition.label, definition.displayName, definition.name].some((label) =>
      typeof label === "string" && label.toLowerCase().trim() === expectedName.toLowerCase()));
    const explicitKey = record && [record.apiName, record.name, record.key].find((key) =>
      typeof key === "string" && /^custom[A-Za-z0-9_]+$/.test(key));
    return { expectedName, present: !!record, apiName: typeof explicitKey === "string" ? explicitKey : null };
  });
  for (const check of customFieldChecks) {
    if (!check.present) findings.push({ severity: "blocker", title: `${check.expectedName}: not found`, detail: "Confirm or create this field in FUB admin. No field name is inferred and nothing is written." });
    else if (!check.apiName) findings.push({ severity: "blocker", title: `${check.expectedName}: API name unconfirmed`, detail: "The definition exists but did not explicitly expose a custom-prefixed API key. Inspect the definition with FUB support before mapping it." });
  }
  const peoplePaths = sections.find((section) => section.entity === "people")!.fields.map((field) => field.name);
  const eventPaths = sections.find((section) => section.entity === "events")!.fields.map((field) => field.name);
  const dealPaths = sections.find((section) => section.entity === "deals")!.fields.map((field) => field.name);
  const signalFinding = (title: string, paths: string[], pattern: RegExp) => {
    const observed = paths.filter((path) => pattern.test(path));
    findings.push({
      severity: "warning", title,
      detail: observed.length ? `Observed field paths: ${observed.join(", ")}. Operations must confirm semantics and values; field presence does not prove permission or deliverability.`
        : "No matching field path was observed in this bounded sample. Availability is unconfirmed; do not infer a missing value or classify inactivity from this absence.",
    });
  };
  signalFinding("Email delivery and suppression mapping needs review", peoplePaths, /email|unsubscrib|bounce|spam|deliver/i);
  signalFinding("Property event city, ZIP and price mapping needs review", eventPaths, /city|zip|postal|price|address|type/i);
  signalFinding("Deal price, status and property address mapping needs review", dealPaths, /price|amount|status|address|city|zip/i);
  signalFinding("Open, click and reply API availability is unconfirmed", [...peoplePaths, ...eventPaths], /open|click|reply/i);
  findings.push({ severity: "info", title: "Read-only boundary enforced", detail: "Only GET requests were made. Any returned raw records are processed only in memory and discarded; no names, contact identifiers, emails, phones, street addresses or free-text content are retained." });
  findings.push({ severity: "blocker", title: "Sync awaits written hosting approval and inventory review", detail: "This report does not unlock contact storage, segmentation, write-back, or sending." });
  const readableCount = results.filter((result) => result.readable).length;
  const status: InventoryReport["status"] = readableCount === resources.length ? "complete" : readableCount ? "partial" : "failed";
  const report = { generatedAt: new Date().toISOString(), status, readOnly: true, contactsPersisted: 0, sections, findings, customFieldChecks };
  return { ...report, markdown: inventoryMarkdown(report) };
}