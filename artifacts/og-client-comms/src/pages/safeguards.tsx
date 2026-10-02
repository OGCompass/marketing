import { Link } from "wouter";
import { useGetWorkspaceStatus, getGetWorkspaceStatusQueryKey } from "@workspace/api-client-react";
import { PageHeader, SectionTitle, Tag, Skel, ErrorBlock, errMsg } from "@/components/kit";

export default function Safeguards() {
  const q = useGetWorkspaceStatus({ query: { enabled: true, queryKey: getGetWorkspaceStatusQueryKey() } });
  const s = q.data;
  const gates = s
    ? [
        ["hosting", "Hosting permission", s.storageApproved ? "Compass and Oldham Group hosting approval is recorded. Oldham Group owns the app and its data. Contact storage is not yet implemented." : "Compass must approve hosting client data in this environment before any contact data may be stored.", s.storageApproved],
        ["field-review", "Field review", "Reviewers record field mapping, category rule and consent check decisions on the Approvals page. This is a proposal sign-off and does not confirm recipient consent or enable sync.", false],
        ["accuracy", "Accuracy review", "Segment rules are checked against observed data quality before any audience is built.", false],
        ["writes", "FUB writes", "Writing to FUB stays off until explicitly approved.", s.writesEnabled],
        ["sending", "Sending", "No outreach is sent until every earlier gate is complete and each batch is approved.", s.sendingEnabled],
        ["consent", "Channel consent", "Email and SMS use requires verified consent per channel.", false],
      ] as const
    : [];
  return (
    <div>
      <PageHeader eyebrow="Controls" title="Safeguards">
        Each gate below must be cleared by a person. Locked gates cannot be opened from this release.
      </PageHeader>
      <Link href="/approvals" data-testid="link-approvals" className="inline-block mb-6 border border-foreground px-4 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">Open guided approvals</Link>
      {q.isLoading && <Skel rows={6} />}
      {q.isError && <ErrorBlock id="safeguards" message={errMsg(q.error)} onRetry={() => q.refetch()} />}
      {s && (
        <>
          <ol className="border-t border-foreground">
            {gates.map(([id, title, text, on], i) => (
              <li key={id} data-testid={`safeguard-${id}`} className="flex gap-4 border-b border-border py-5">
                <div className="font-serif text-3xl w-10">{i + 1}</div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-serif text-xl">{title}</span><Tag solid={on} locked={!on}>{on ? "Cleared" : "Not cleared"}</Tag></div>
                  <p className="text-sm text-muted-foreground mt-1">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <SectionTitle note="From server">Reported gate status</SectionTitle>
          {s.gates.length === 0 ? <p className="text-sm text-muted-foreground">No gates reported.</p> : (
            <ul className="divide-y divide-border border-y border-border">
              {s.gates.map((g) => (
                <li key={g.id} className="py-3 flex gap-4" data-testid={`server-gate-${g.id}`}>
                  <Tag solid={g.status === "complete"} locked={g.status === "locked"}>{g.status}</Tag>
                  <div><div className="text-sm font-bold">{g.title}</div><div className="text-sm text-muted-foreground">{g.detail}</div></div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
