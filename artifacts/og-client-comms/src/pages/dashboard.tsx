import { Link } from "wouter";
import { format } from "date-fns";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceStatus, getGetWorkspaceStatusQueryKey } from "@workspace/api-client-react";
import { PageHeader, SectionTitle, Stat, Tag, Skel, ErrorBlock, errMsg } from "@/components/kit";
import { accessRetryAt } from "@/lib/access-retry";
import { getReportCooldown, reportQueryOptions } from "@/lib/report-retry";

export default function Dashboard() {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const cooldown = getReportCooldown(qc, userId ?? "");
  const q = useQuery(reportQueryOptions(cooldown, getGetWorkspaceStatusQueryKey(),
    (signal) => getWorkspaceStatus({ signal }), !!userId));
  const failure = q.failureReason ?? q.error;
  const s = q.data;
  return (
    <div>
      <PageHeader eyebrow="Readiness" title="Dashboard">
        What is known, what is locked, and what must be approved before any outreach exists.
      </PageHeader>
      <Link href="/guide" data-testid="link-guide" className="inline-block mb-6 border border-foreground px-4 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">How to use this workspace</Link>
      {q.isLoading && !failure && <Skel rows={6} />}
      {!!failure && <ErrorBlock id="status" message={errMsg(failure)} busy={q.isFetching}
        retryAt={accessRetryAt(failure)} onRetry={() => q.refetch({ cancelRefetch: false })} />}
      {s && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-4 border-b border-border pb-8">
            <Stat id="sampled" label="Records sampled" value={s.totalSampled} />
            <Stat id="fields" label="Fields observed" value={s.fieldsObserved} />
            <Stat id="missing" label="Missing custom fields" value={s.missingCustomFields === null ? "Unconfirmed" : s.missingCustomFields} />
            <Stat id="markets" label="Pilot markets" value={s.pilotMarkets.length} />
          </div>
          <p className="mt-3 text-sm text-muted-foreground" data-testid="text-last-inventory">
            {s.lastInventoryAt ? `Last attempted ${format(new Date(s.lastInventoryAt), "PPpp")} (an attempt, not a successful review).` : "No discovery has been attempted yet."}{" "}
            Markets: {s.pilotMarkets.length ? s.pilotMarkets.join(", ") : "none defined"}.
          </p>

          {s.connectionStatus !== "verified" && (
            <div className="mt-6 border-2 border-foreground p-4" data-testid="banner-connection" role="alert">
              <div className="eyebrow">FUB connection: {s.connectionStatus.replace("_", " ")}</div>
              <p className="text-sm mt-1">
                {s.connectionStatus === "failed" ? "FUB rejected every read. No CRM data was retrieved, so counts above reflect nothing about the CRM." :
                 s.connectionStatus === "partial" ? "Some FUB reads failed. Counts are incomplete." :
                 "The FUB connection has not been checked yet."}
              </p>
            </div>
          )}

          <SectionTitle note="Server reported">Operating posture</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 border border-border divide-y sm:divide-y-0 sm:divide-x divide-border">
            {[
              ["read-only", "Read-only", s.readOnly, "On"],
              ["sending", "Sending", s.sendingEnabled, "Enabled"],
              ["writes", "FUB writes", s.writesEnabled, "Enabled"],
              ["storage", "Storage approved", s.storageApproved, "Yes"],
              ["credentials", "FUB credentials present", s.credentialsConfigured, "Present"],
              ["connection", "FUB connection", s.connectionStatus === "verified", "Verified"],
            ].map(([id, label, v, yes]) => (
              <div key={id as string} className="p-4" data-testid={`posture-${id}`}>
                <div className="eyebrow">{label as string}</div>
                <div className="mt-2"><Tag solid={!!v}>{v ? (yes as string) : id === "read-only" ? "Off" : id === "connection" ? s.connectionStatus.replace("_", " ") : id === "credentials" || id === "storage" ? "Not yet" : "Locked off"}</Tag></div>
              </div>
            ))}
          </div>
          {!s.credentialsConfigured && (
            <p className="mt-3 text-sm border-l-2 border-foreground pl-3" data-testid="note-credentials">FUB credentials are not configured on the server. Credentials being present would still not prove the connection works.</p>
          )}

          <SectionTitle note="Five stages">Workflow</SectionTitle>
          {s.steps.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="empty-steps">The server returned no workflow stages.</p>
          ) : (
            <ol>
              {s.steps.map((st) => (
                <li key={st.number} data-testid={`step-${st.number}`} className={`flex gap-4 border-b border-border py-4 ${st.status === "locked" ? "opacity-60" : ""}`}>
                  <div className="font-serif text-3xl w-10">{st.number}</div>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-serif text-lg">{st.title}</span>
                      <Tag solid={st.status === "current"} locked={st.status === "locked"}>{st.status.replace("_", " ")}</Tag>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{st.description}</p>
                  </div>
                  {st.status === "current" && <Link href="/inventory" data-testid={`link-step-${st.number}`} className="self-center text-xs uppercase tracking-widest underline underline-offset-4">Open</Link>}
                </li>
              ))}
            </ol>
          )}

          <SectionTitle note={`${s.gates.length} gates`}>Policy gates</SectionTitle>
          <ul className="divide-y divide-border border-y border-border">
            {s.gates.map((g) => (
              <li key={g.id} className="py-3 flex gap-4" data-testid={`gate-${g.id}`}>
                <Tag solid={g.status === "complete"} locked={g.status === "locked"}>{g.status}</Tag>
                <div><div className="text-sm font-bold">{g.title}</div><div className="text-sm text-muted-foreground">{g.detail}</div></div>
              </li>
            ))}
          </ul>
          <Link href="/safeguards" data-testid="link-safeguards" className="inline-block mt-4 text-xs uppercase tracking-widest underline underline-offset-4">All safeguards</Link>
        </>
      )}
    </div>
  );
}
