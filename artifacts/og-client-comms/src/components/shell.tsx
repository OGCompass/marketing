import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetWorkspaceAccess, getWorkspaceAccess, getGetWorkspaceAccessQueryKey, useHealthCheck } from "@workspace/api-client-react";
import { Skel, ErrorBlock, errMsg, Tag, RetryButton } from "@/components/kit";
import { accessRetryAt, accessRetryDelay, getAccessCooldown, isTemporaryAccessError, shouldRetryAccess } from "@/lib/access-retry";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function Brand({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className="inline-flex items-center gap-3">
      <img src={`${basePath}/logo.svg`} alt="" className={size === "lg" ? "h-12 w-12" : "h-8 w-8"} />
      <span className="leading-tight">
        <span className="block font-serif text-base">OG Client Communications</span>
        <span className="eyebrow block">The Oldham Group at Compass</span>
      </span>
    </span>
  );
}

const NAV = [
  ["/guide", "How to use"],
  ["/dashboard", "Dashboard"],
  ["/inventory", "Field inventory"],
  ["/blueprint", "Blueprint"],
  ["/approvals", "Approvals"],
  ["/safeguards", "Safeguards"],
] as const;

function Health() {
  const h = useHealthCheck();
  const ok = h.data?.status;
  return (
    <span data-testid="status-health" className="eyebrow">
      API {h.isLoading ? "checking" : h.isError ? "unreachable" : ok}
    </span>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { signOut } = useClerk();
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <div className="border-b border-foreground bg-foreground text-background text-[11px] tracking-widest uppercase px-4 py-1.5 text-center" data-testid="banner-readonly">
        Read-only CRM access. Saved masked reports and approval metadata only; no contact records, no FUB writes, no drafts or sends.
      </div>
      <div className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-4 flex flex-wrap items-center justify-between gap-4">
          <Link href="/guide" data-testid="link-brand"><Brand /></Link>
          <button data-testid="button-sign-out" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="text-xs uppercase tracking-widest underline underline-offset-4">Sign out</button>
        </div>
        <nav className="mx-auto max-w-6xl px-4 flex gap-6 overflow-x-auto">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} data-testid={`link-nav-${label.toLowerCase().replace(/\s/g, "-")}`}
              className={`py-2.5 text-sm whitespace-nowrap border-b-2 ${loc === href ? "border-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <main className="mx-auto max-w-6xl w-full px-4 py-10 flex-1">{children}</main>
      <footer className="border-t border-border px-4 py-4 text-center"><Health /></footer>
    </div>
  );
}

export function AccessPending({ userId, reason, onRetry, busy = false }: {
  userId: string; reason: string; onRetry: () => Promise<unknown>; busy?: boolean;
}) {
  const { signOut } = useClerk();
  const { user } = useUser();
  // Display only. Workspace authorization is checked by the server.
  const primaryEmail = user?.primaryEmailAddress;
  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4">
      <div className="max-w-xl w-full border border-foreground p-8 bg-card rise" data-testid="screen-access-pending">
        <Brand />
        <div className="eyebrow mt-8">Access pending</div>
        <h1 className="text-3xl mt-1 mb-4">You are signed in, but not yet authorized.</h1>
        <p className="text-sm text-muted-foreground mb-4">{reason}</p>
        <div className="border border-border p-3 mb-4">
          <div className="eyebrow">Your primary sign-in email</div>
          <code data-testid="text-primary-email" className="text-sm break-all select-all">
            {primaryEmail?.emailAddress ?? "Not available — send your user ID below."}
          </code>
          {primaryEmail && <div className="mt-2"><Tag>{primaryEmail.verification?.status === "verified" ? "Verified email" : "Email verification required"}</Tag></div>}
        </div>
        <div className="border border-border p-3 mb-4">
          <div className="eyebrow">Your user ID</div>
          <code data-testid="text-user-id" className="text-sm break-all select-all">{userId}</code>
        </div>
        <ol className="list-decimal pl-5 space-y-1.5 text-sm leading-relaxed mb-4" data-testid="list-access-steps">
          <li>Copy your primary sign-in email or user ID shown above.</li>
          <li>Send it to the project owner and ask for explicit authorization. Email approval requires your primary address to be verified.</li>
          <li>Once the owner confirms, click Check again.</li>
        </ol>
        <p className="text-sm leading-relaxed mb-6">
          The owner must explicitly approve your verified primary email or this user ID. Signing up alone does not grant access. You have no CRM access until approved, and no FUB endpoint is called on your behalf.
        </p>
        <div className="flex gap-3">
          <RetryButton id="button-recheck-access" onRetry={onRetry} busy={busy} label="Check again" busyLabel="Checking access…" className="bg-foreground text-background px-4 py-2" />
          <button data-testid="button-pending-sign-out" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="border border-foreground px-4 py-2 text-xs uppercase tracking-widest">Sign out</button>
        </div>
      </div>
    </div>
  );
}

export function Protected({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const cooldown = getAccessCooldown(qc, userId ?? "");
  const access = useGetWorkspaceAccess({
    query: {
      enabled: !!userId,
      queryKey: [...getGetWorkspaceAccessQueryKey(), userId],
      queryFn: ({ signal }) => cooldown.run(() => getWorkspaceAccess({ signal, cache: "no-store" }), signal),
      retry: shouldRetryAccess,
      retryDelay: accessRetryDelay,
      retryOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
    },
  });
  const failure = access.failureReason ?? access.error;
  const retry = () => access.refetch({ cancelRefetch: false });
  if (!userId)
    return <div className="mx-auto max-w-2xl p-10"><Skel rows={3} /></div>;
  if (failure || access.isError) {
    const temporary = isTemporaryAccessError(failure);
    return <div className="mx-auto max-w-2xl p-10"><ErrorBlock id="access"
      title={temporary ? "Access check temporarily unavailable" : "Access check failed"}
      message={temporary
        ? `The server is busy or temporarily unavailable. Workspace access remains blocked until a new check succeeds. ${access.isFetching ? "We’ll retry automatically after the wait." : "Please wait before trying again."}`
        : errMsg(failure)}
      busy={access.isFetching} busyLabel="Checking access…" retryAt={accessRetryAt(failure)} onRetry={retry} /></div>;
  }
  if (access.isLoading || !access.data)
    return <div className="mx-auto max-w-2xl p-10"><Skel rows={3} /></div>;
  if (!access.data.authorized)
    return <AccessPending userId={access.data.userId} reason={access.data.reason} onRetry={retry} busy={access.isFetching} />;
  // A prior grant must not render protected content while a fresh check is running.
  if (access.isFetching)
    return <div className="mx-auto max-w-2xl p-10"><Skel rows={3} /></div>;
  return <Shell>{children}</Shell>;
}

export { Tag };
