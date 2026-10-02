import { runDiscovery } from "./inventory-store";
import { logger } from "../logger";

try {
  const report = await runDiscovery();
  logger.info({
    sampleCounts: report.sections.map(({ entity, sampleCount }) => ({ entity, sampleCount })),
    fields: report.sections.reduce((sum, section) => sum + section.fields.length, 0),
    blockers: report.findings.filter((finding) => finding.severity === "blocker").map(({ title, detail }) => ({ title, detail })),
    contactsPersisted: report.contactsPersisted,
    status: report.status,
  }, "Masked discovery diagnostic generated. Review required before sync.");
  if (report.status !== "complete") process.exitCode = 1;
} catch {
  logger.error("Discovery failed. No raw records were stored.");
  process.exitCode = 1;
}