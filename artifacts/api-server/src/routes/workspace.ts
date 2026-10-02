import { Router, type IRouter, type Response } from "express";
import {
  GetWorkspaceStatusResponse, GetFieldInventoryResponse,
  DiscoverFubFieldsBody, GetProgramBlueprintResponse,
  GetApprovalReviewResponse, UpdateApprovalReviewBody, UpdateApprovalReviewResponse,
} from "@workspace/api-zod";
import { requireWorkspaceSignIn, requireWorkspaceAccess, respondWorkspaceAccess } from "../middlewares/workspace-access";
import { latestInventory, runDiscovery } from "../lib/fub/inventory-store";
import { fubCredentialsConfigured } from "../lib/fub/client";
import { loadProgram, programBlueprint } from "../lib/program";
import { loadDataApproval } from "../lib/data-approval";
import {
  ApprovalAuthorityError, ApprovalValidationError, StaleApprovalError,
  getApprovalReview, getCurrentFinalApprovalStatus, updateApprovalReview,
} from "../lib/program-approvals";
import type { Approver } from "../lib/program-approval-engine";

const router: IRouter = Router();
router.use(["/workspace", "/inventory", "/program"], requireWorkspaceSignIn);
router.get("/workspace/access", respondWorkspaceAccess);
router.use(["/workspace/status", "/inventory", "/program"], requireWorkspaceAccess);

router.get("/workspace/status", async (_req, res): Promise<void> => {
  const { config } = loadProgram();
  const approval = loadDataApproval();
  let inventoryApproval: Awaited<ReturnType<typeof getCurrentFinalApprovalStatus>>;
  try {
    inventoryApproval = await getCurrentFinalApprovalStatus();
  } catch {
    inventoryApproval = {
      approved: false,
      unavailable: true,
      detail: "Durable setup approval storage is unavailable. Inventory readiness remains pending; no synthetic approval was recorded.",
      inventory: null,
    };
  }
  const report = inventoryApproval.inventory;
  res.json(GetWorkspaceStatusResponse.parse({
    readOnly: true, writesEnabled: false, sendingEnabled: false, storageApproved: approval.hostingApproved,
    credentialsConfigured: fubCredentialsConfigured(),
    connectionStatus: !report ? "not_checked" : report.status === "complete" ? "verified" : report.status,
    lastInventoryAt: report?.generatedAt ?? null,
    totalSampled: report?.sections.reduce((sum, section) => sum + section.sampleCount, 0) ?? 0,
    fieldsObserved: report?.sections.reduce((sum, section) => sum + section.fields.length, 0) ?? 0,
    missingCustomFields: report?.customFieldChecks.length === config.discovery.expected_custom_fields.length
      ? report.customFieldChecks.filter((field) => !field.present || !field.apiName).length : null,
    pilotMarkets: config.pilot_markets,
    steps: [
      { number: 1, title: "Discover actual FUB fields", status: report?.status === "complete" ? "awaiting_review" : "current", description: "Bounded, read-only samples; masked aggregate report. No contacts stored." },
      { number: 2, title: "Sync & deterministic segmentation", status: "locked", description: approval.hostingApproved ? "Hosting approval is recorded. Inventory approval and confirmed mappings are still required; sync is not implemented." : "Requires hosting permission, inventory approval, and confirmed mappings; sync is not implemented." },
      { number: 3, title: "Human review & accuracy lock", status: "locked", description: "Golden set and reviewed contacts must meet the configured accuracy criteria." },
      { number: 4, title: "Guarded FUB write-back", status: "locked", description: "Dry-run, named approval, pilot fence, tag preservation, and rollback verification." },
      { number: 5, title: "Verified content & approved outreach", status: "locked", description: "Verified facts, validation, copy/send approval and separate email/SMS permission gates." },
    ],
    gates: [
      { id: "hosting", title: "Compass / Oldham Group data-hosting approval", status: approval.hostingApproved ? "complete" : "pending", detail: approval.hostingApproved ? `Owner confirmed hosting approval on ${approval.confirmedOn}. ${approval.dataOwner} owns the data; ${approval.appOwner} owns the app. Contact storage is not yet implemented.` : "Client-data hosting approval has not been confirmed." },
      { id: "inventory", title: "Current inventory and setup review approved", status: inventoryApproval.approved ? "complete" : "pending", detail: inventoryApproval.detail },
      { id: "accuracy", title: "Segmentation accuracy proven", status: "locked", detail: `At least ${config.limits.reviewed_contacts_required} reviewed contacts and the configured market/audience agreement are required in the later phase.` },
      { id: "automation", title: "FUB automation audit", status: "locked", detail: "OGM tags and custom fields must not trigger unintended automations or action plans." },
      { id: "content", title: "Verified facts & content approval", status: "locked", detail: "No AI drafting from unverified facts; no model auto-approval." },
      { id: "channel", title: "Email / SMS sending permission", status: "locked", detail: "Define consent, opt-outs, sender identity, timezone rules, reply handling and frequency caps before any send." },
    ],
  }));
});

router.get("/inventory", async (_req, res): Promise<void> => {
  try {
    res.json(GetFieldInventoryResponse.parse({ report: await latestInventory() }));
  } catch {
    res.status(503).json({ error: "Durable masked inventory storage is unavailable." });
  }
});
router.post("/inventory/discover", async (req, res): Promise<void> => {
  const parsed = DiscoverFubFieldsBody.safeParse(req.body);
  if (!parsed.success || parsed.data.confirmReadOnly !== true) {
    res.status(400).json({ error: "Confirm the read-only discovery boundary before continuing." });
    return;
  }
  try {
    const report = await runDiscovery();
    if (report.status === "failed") {
      res.status(502).json({ error: "FUB reads failed. Review the saved discovery diagnostics; fields and CRM counts remain unconfirmed." });
      return;
    }
    res.json(report);
  } catch (error) {
    if (error instanceof Error && error.message === "DISCOVERY_RUNNING") {
      res.status(409).json({ error: "A discovery is already running. Wait before starting another." });
      return;
    }
    req.log.error("Masked FUB discovery failed; no raw record values logged.");
    res.status(502).json({ error: "Discovery could not complete safely. Contact storage and all writes remain locked." });
  }
});
router.get("/program/blueprint", (_req, res): void => {
  res.json(GetProgramBlueprintResponse.parse(programBlueprint()));
});

const actorFor = (res: Response): Approver =>
  res.locals.workspaceActor as Approver;

router.get("/program/approvals", async (_req, res): Promise<void> => {
  try {
    res.json(GetApprovalReviewResponse.parse(await getApprovalReview(actorFor(res))));
  } catch {
    res.status(503).json({ error: "Durable approval review or current masked inventory is unavailable. Inventory readiness remains pending." });
  }
});

router.post("/program/approvals", async (req, res): Promise<void> => {
  const parsed = UpdateApprovalReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide a valid review action with the current revision and source version." });
    return;
  }
  const { expectedRevision, sourceVersion, action, answers, itemId, answer, sectionId, confirmProposalOnly } = parsed.data;
  let operation;
  if (action === "save" && answers) operation = { action, answers };
  else if (action === "review_item" && itemId && answer) operation = { action, itemId, answer };
  else if (action === "approve" && sectionId) operation = { action, sectionId };
  else if (action === "finalize" && confirmProposalOnly === true) operation = { action, confirmProposalOnly: true as const };
  else if (action === "reset") operation = { action };
  else {
    res.status(400).json({ error: "The selected action is missing its required answer, section, or explicit proposal-only confirmation." });
    return;
  }
  try {
    const result = await updateApprovalReview({ expectedRevision, sourceVersion, operation }, actorFor(res));
    res.json(UpdateApprovalReviewResponse.parse(result));
  } catch (error) {
    if (error instanceof ApprovalAuthorityError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof ApprovalValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof StaleApprovalError) {
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(503).json({ error: "Durable approval review storage or the current masked inventory is unavailable. Reload the review before retrying; no operational capability is unlocked." });
  }
});
export default router;