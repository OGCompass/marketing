import { Link } from "wouter";
import { useRef, useEffect, useState } from "react";
import { useGetProgramBlueprint, getGetProgramBlueprintQueryKey } from "@workspace/api-client-react";
import { serializeStrategyCsv } from "@/lib/strategy-csv";
import { PageHeader, SectionTitle, Tag, Skel, ErrorBlock, errMsg, LockedPhase } from "@/components/kit";

function List({ items, id }: { items: string[]; id: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">None listed.</p>;
  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((t, i) => <li key={i} data-testid={`${id}-${i}`} className="py-2.5 text-sm flex gap-3"><span className="font-serif text-muted-foreground w-6">{i + 1}</span><span>{t}</span></li>)}
    </ul>
  );
}

export default function Blueprint() {
  const q = useGetProgramBlueprint({ query: { enabled: true, queryKey: getGetProgramBlueprintQueryKey() } });
  const b = q.data;
  const stale = q.isError || q.isFetching;
  const urlRef = useRef<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const download = () => {
    if (!b || stale) return;
    setDownloadError(null);
    try {
      const blob = new Blob([serializeStrategyCsv(b)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const a = document.createElement("a");
      a.href = url; a.download = "og-client-communication-strategy.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); if (urlRef.current === url) urlRef.current = null; }, 1000);
    } catch {
      setDownloadError("The strategy CSV could not be generated. Refresh the Blueprint and check that the assignment strategy is complete before retrying.");
    }
  };
  return (
    <div>
      <PageHeader eyebrow="Proposal only" title="Program blueprint">
        Proposed audiences and rules for review. Nothing here is active, segmented or scheduled.
      </PageHeader>
      <Link href="/approvals" data-testid="link-approvals" className="inline-block mb-6 border border-foreground px-4 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">Open guided approvals</Link>
      {q.isLoading && <Skel rows={6} />}
      {q.isFetching && !q.isLoading && <Skel rows={4} />}
      {q.isError && <ErrorBlock id="blueprint" message={errMsg(q.error)} onRetry={() => q.refetch()} />}
      {b && !stale && (
        <>
          <div className="flex gap-3 items-center mb-2 text-sm" data-testid="text-rule-version">
            <Tag>Rules {b.ruleVersion}</Tag><Tag>{b.status}</Tag>
          </div>

          <SectionTitle note="Proposal, not computed">How clients would be identified</SectionTitle>
          <p className="text-sm text-muted-foreground mb-3">Identification is evidence-based and reviewed by people. Actual client membership is not computed. UNKNOWN or REVIEW means the evidence is missing or unclear; it is not the same as dormant.</p>
          <List items={b.classificationSteps} id="class-step" />

          <SectionTitle note={`${b.audiences.length} directions`}>Audiences and content</SectionTitle>
          <div className="grid md:grid-cols-2 gap-px bg-border border border-border">
            {b.audiences.map((a) => (
              <article key={a.code} className="bg-card p-5" data-testid={`audience-${a.code}`}>
                <div className="flex justify-between items-start"><span className="eyebrow">{a.code}</span><span className="text-xs tabular-nums">every {a.cadenceDays} days</span></div>
                <h3 className="text-xl mt-1 mb-2">{a.name}</h3>
                <p className="text-sm mb-3">{a.purpose}</p>
                <div className="eyebrow">Content direction</div>
                <p className="text-sm text-muted-foreground">{a.contentDirection}</p>
                <div className="eyebrow mt-3">Identification evidence</div>
                <ul className="list-disc pl-5 text-sm" data-testid={`rules-${a.code}`}>{a.identificationRules.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <div className="eyebrow mt-3">Review notes</div>
                <ul className="list-disc pl-5 text-sm" data-testid={`notes-${a.code}`}>{a.reviewNotes.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <div className="eyebrow mt-3">If unassigned</div>
                <p className="text-sm text-muted-foreground">{a.unassignedDirection}</p>
              </article>
            ))}
          </div>

          <SectionTitle note="Proposed, team-managed">Unassigned client strategy</SectionTitle>
          <p className="text-sm mb-3">Unassigned is an ownership overlay, not an audience. The current assigned-agent sending gate stays enforced until an explicit team-sender exception is approved. No sending, storage or contact export is enabled.</p>
          <div className="grid md:grid-cols-2 gap-px bg-border border border-border">
            {b.assignmentStrategies.map((a) => (
              <article key={a.code} className="bg-card p-5" data-testid={`strategy-${a.code}`}>
                <span className="eyebrow">{a.code}</span>
                <h3 className="text-xl mt-1 mb-2">{a.name}</h3>
                <div className="eyebrow">Identification</div><p className="text-sm mb-2">{a.identification}</p>
                <div className="eyebrow">Communication direction</div><p className="text-sm mb-2">{a.communicationDirection}</p>
                <div className="eyebrow">Responsible party</div><p className="text-sm mb-2">{a.responsibleParty}</p>
                <div className="eyebrow">Release requirements</div>
                <ul className="list-disc pl-5 text-sm">{a.releaseRequirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </article>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={download} disabled={stale} data-testid="button-download-strategy-csv" className="border border-foreground px-3 py-2 text-xs uppercase tracking-widest disabled:opacity-50">Download strategy CSV</button>
            <span className="text-xs text-muted-foreground">The CSV contains strategy and rules only. It has no client records and no send-ready audience.</span>
          </div>
          {downloadError && <ErrorBlock id="strategy-csv" message={downloadError} onRetry={download} />}

          <div className="grid md:grid-cols-2 gap-10">
            <div>
              <SectionTitle>Markets</SectionTitle>
              <div className="flex flex-wrap gap-2" data-testid="list-markets">{b.markets.map((m) => <Tag key={m}>{m}</Tag>)}</div>
            </div>
            <div>
              <SectionTitle>Price bands</SectionTitle>
              <ul className="divide-y divide-border border-y border-border">
                {b.priceBands.map((p) => <li key={p.code} className="py-2 text-sm flex justify-between" data-testid={`band-${p.code}`}><span className="font-mono text-xs">{p.code}</span><span>{p.label}</span></li>)}
              </ul>
            </div>
          </div>

          <SectionTitle note="Must hold before any send">Hard gates</SectionTitle>
          <List items={b.hardGates} id="hard-gate" />
          <SectionTitle note="Needs a decision">Unresolved issues</SectionTitle>
          <List items={b.unresolvedRules} id="unresolved" />
          <SectionTitle note="Not active">SMS requirements</SectionTitle>
          <List items={b.smsRequirements} id="sms" />

          <SectionTitle note="Not implemented">Later phases</SectionTitle>
          <LockedPhase n={2} title="Segmentation" text="Audience membership is not computed. No contacts are stored." />
          <LockedPhase n={3} title="Drafting" text="No messages are drafted in this release." />
          <LockedPhase n={4} title="Approval and sending" text="Sending is disabled and unreachable from this interface." />
        </>
      )}
    </div>
  );
}
