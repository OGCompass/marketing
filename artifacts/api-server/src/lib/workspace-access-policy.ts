export interface WorkspaceIdentity {
  id: string;
  banned: boolean;
  locked: boolean;
  primaryEmailAddressId: string | null;
  emailAddresses?: readonly {
    id: string;
    emailAddress: string;
    verification?: { status: string } | null;
  }[];
}

export type WorkspaceAccessDecision =
  | { authorized: true; unavailable: false }
  | { authorized: false; unavailable: false }
  | { authorized: false; unavailable: true };

export interface WorkspaceAccessPolicyOptions {
  userId: string | null;
  authorizedUserIds?: string;
  authorizedEmails?: string;
  onVerifiedPrimaryEmail?: (email: string | null) => void;
  lookupIdentity: (userId: string) => Promise<WorkspaceIdentity>;
}

const EMAIL_PATTERN =
  /^[A-Z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'+/=?^_`{|}~-]+)*@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function parseAuthorizedEmails(raw: string | undefined): string[] | null {
  if (raw == null || raw.trim() === "") return [];

  const emails = raw.split(",").map(normalizeEmail);
  if (emails.some((email) => email === null)) return null;
  return emails as string[];
}

function parseAuthorizedUserIds(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter(Boolean);
}

export async function evaluateWorkspaceAccess({
  userId,
  authorizedUserIds,
  authorizedEmails,
  onVerifiedPrimaryEmail,
  lookupIdentity,
}: WorkspaceAccessPolicyOptions): Promise<WorkspaceAccessDecision> {
  if (!userId) return { authorized: false, unavailable: false };

  const emailApprovals = parseAuthorizedEmails(authorizedEmails);
  if (emailApprovals === null) return { authorized: false, unavailable: true };

  const idApproved = parseAuthorizedUserIds(authorizedUserIds).includes(userId);
  if (!idApproved && emailApprovals.length === 0) {
    return { authorized: false, unavailable: false };
  }

  let identity: WorkspaceIdentity;
  try {
    identity = await lookupIdentity(userId);
  } catch {
    return { authorized: false, unavailable: true };
  }

  if (identity == null || typeof identity !== "object") {
    return { authorized: false, unavailable: true };
  }

  if (
    identity.id !== userId ||
    identity.banned !== false ||
    identity.locked !== false
  ) {
    return { authorized: false, unavailable: false };
  }

  const primaryEmail = identity.primaryEmailAddressId &&
    Array.isArray(identity.emailAddresses)
    ? identity.emailAddresses.find(
        (email) => email != null && email.id === identity.primaryEmailAddressId,
      )
    : undefined;
  const verifiedPrimaryEmail =
    primaryEmail?.verification?.status === "verified" &&
    typeof primaryEmail.emailAddress === "string"
      ? normalizeEmail(primaryEmail.emailAddress)
      : null;
  onVerifiedPrimaryEmail?.(verifiedPrimaryEmail);

  if (idApproved) {
    return { authorized: true, unavailable: false };
  }

  return {
    authorized: verifiedPrimaryEmail !== null && emailApprovals.includes(verifiedPrimaryEmail),
    unavailable: false,
  };
}