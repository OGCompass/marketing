import { clerkClient, getAuth } from "@clerk/express";
import { accessLimitsFromEnv, WorkspaceAccessLimiter } from "../lib/workspace-access-limits";
import { createWorkspaceAccessHandlers } from "./workspace-access-handlers";

// One shared limiter across status and private routes; keys come only from
// authenticated Clerk principals, never request headers, emails or IPs.
export const {
  workspaceAccess, requireWorkspaceSignIn, requireWorkspaceAccess, respondWorkspaceAccess,
} = createWorkspaceAccessHandlers({
  userId: (req) => getAuth(req).userId,
  approvals: () => ({
    authorizedUserIds: process.env.OG_AUTHORIZED_USER_IDS,
    authorizedEmails: process.env.OG_AUTHORIZED_EMAILS,
    approvalCassandraEmail: process.env.OG_APPROVAL_CASSANDRA_EMAIL,
    approvalCaitlinEmail: process.env.OG_APPROVAL_CAITLIN_EMAIL,
  }),
  lookupIdentity: (id) => clerkClient.users.getUser(id),
  limiter: new WorkspaceAccessLimiter(accessLimitsFromEnv(process.env)),
});