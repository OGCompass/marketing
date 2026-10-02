import type { Request, Response, NextFunction } from "express";
import { GetWorkspaceAccessResponse } from "@workspace/api-zod";
import type { WorkspaceIdentity } from "../lib/workspace-access-policy";
import { WorkspaceAccessLimiter } from "../lib/workspace-access-limits";

const DENIED_REASON =
  "Your account is signed in, but not authorized for FUB access. The project owner must explicitly approve this Clerk user ID or verified primary email.";
const UNAVAILABLE_REASON = "Access verification is temporarily unavailable. Please retry.";
const THROTTLED_REASON = "Too many access checks. Please retry after the indicated delay.";

export function createWorkspaceAccessHandlers(dependencies: {
  userId: (req: Request) => string | null;
  approvals: () => {
    authorizedUserIds?: string;
    authorizedEmails?: string;
    approvalCassandraEmail?: string;
    approvalCaitlinEmail?: string;
  };
  lookupIdentity: (id: string) => Promise<WorkspaceIdentity>;
  limiter: WorkspaceAccessLimiter;
}) {
  function reviewerForPrimaryEmail(
    email: string | null,
    approvals: ReturnType<typeof dependencies.approvals>,
  ): "Cassandra" | "Caitlin" | null {
    if (!email) return null;
    const cassandraEmail = approvals.approvalCassandraEmail?.trim().toLowerCase();
    if (cassandraEmail && email === cassandraEmail) return "Cassandra";
    const caitlinEmail = approvals.approvalCaitlinEmail?.trim().toLowerCase();
    if (caitlinEmail && email === caitlinEmail) return "Caitlin";
    return null;
  }

  async function evaluateWorkspaceAccess(req: Request) {
    const userId = dependencies.userId(req);
    const approvals = dependencies.approvals();
    let verifiedPrimaryEmail: string | null = null;
    const decision = await dependencies.limiter.evaluate({
      userId,
      authorizedUserIds: approvals.authorizedUserIds,
      authorizedEmails: approvals.authorizedEmails,
      onVerifiedPrimaryEmail: (email) => { verifiedPrimaryEmail = email; },
      lookupIdentity: dependencies.lookupIdentity,
    });
    return {
      access: {
        ...decision,
        userId: userId ?? "",
        reason: !userId
          ? "Sign in to request internal console access."
          : decision.authorized
            ? "Authorized for the internal read-only console."
            : decision.retryStatus
              ? THROTTLED_REASON
              : decision.unavailable ? UNAVAILABLE_REASON : DENIED_REASON,
      },
      reviewerLabel: reviewerForPrimaryEmail(verifiedPrimaryEmail, approvals),
    };
  }

  async function workspaceAccess(req: Request) {
    const { access } = await evaluateWorkspaceAccess(req);
    return access;
  }

  function requireWorkspaceSignIn(req: Request, res: Response, next: NextFunction): void {
    res.setHeader("Cache-Control", "no-store");
    if (!dependencies.userId(req)) {
      res.status(401).json({ error: "Sign-in required." });
      return;
    }
    next();
  }

  async function respondWorkspaceAccess(req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const access = await workspaceAccess(req);
    const response = GetWorkspaceAccessResponse.parse(access);
    if (access.unavailable) {
      res.setHeader("Retry-After", String(access.retryAfterSeconds ?? 1));
      res.status(access.retryStatus ?? 503).json(response);
      return;
    }
    res.json(response);
  }

  async function requireWorkspaceAccess(
    req: Request, res: Response, next: NextFunction,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const { access, reviewerLabel } = await evaluateWorkspaceAccess(req);
    if (access.unavailable) {
      res.setHeader("Retry-After", String(access.retryAfterSeconds ?? 1));
      res.status(access.retryStatus ?? 503).json({ error: access.reason });
      return;
    }
    if (!access.authorized) {
      res.status(403).json({ error: "Internal FUB access has not been granted to this account." });
      return;
    }
    res.locals.workspaceActor = {
      userId: access.userId,
      reviewerLabel,
      canApprove: reviewerLabel !== null,
    };
    next();
  }

  return { workspaceAccess, requireWorkspaceSignIn, requireWorkspaceAccess, respondWorkspaceAccess };
}