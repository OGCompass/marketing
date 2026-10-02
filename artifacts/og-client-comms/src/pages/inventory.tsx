import { Link } from "wouter";
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Download, Search } from "lucide-react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFieldInventory, getGetFieldInventoryQueryKey, useDiscoverFubFields, getGetWorkspaceStatusQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { PageHeader, SectionTitle, Tag, Skel, ErrorBlock, Empty, RetryButton, errMsg } from "@/components/kit";
import { accessRetryAt } from "@/lib/access-retry";
import { getReportCooldown, reportQueryOptions, reportDiscoveryOptions } from "@/lib/report-retry";

export default function Inventory() {
  const qc = useQueryClient();
  const { userId } = useAuth();
  const { toast } = useToast();
  const cooldown = getReportCooldown(qc, userId ?? "");
  const inv = useQuery(reportQueryOptions(cooldown, getGetFieldInventoryQueryKey(),
    (signal) => getFieldInventory({ signal }), !!userId));
  const failure = inv.failureReason ?? inv.error;
  const discover = useDiscoverFubFields({ mutation: reportDiscoveryOptions(cooldown) });
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState("all");
  const report = inv.data?.report ?? null;

  const run = async () => {
    if (!confirm || !userId || discover.isPending) return;
    try {
      await discover.mutateAsync({ data: { confirmReadOnly: true } }, {
        onSuccess: (r) => {
          qc.setQueryData(getGetFieldInventoryQueryKey(), { report: r });
          setConfirm(false);
          toast(r.status === "complete"
            ? { title: "Discovery complete", description: "Masked field shapes updated. No contacts were stored." }
            : { title: `Discovery ${r.status}`, description: "See the diagnostic on this page.", variant: "destructive" });
        },
        onError: (e) => toast({ title: "Discovery failed", description: errMsg(e) + " Review the error and latest saved report; this request may have failed before discovery ran.", variant: "destructive" }),
        onSettled: () => {
          qc.invalidateQueries({ queryKey: getGetFieldInventoryQueryKey() });
          qc.invalidateQueries({ queryKey: getGetWorkspaceStatusQueryKey() });
        },
      });
    } catch {
      // onError displays the failure; never replay discovery automatically.
    }
  };

  const sections = useMemo(() => {
    if (!report) return [];
    const t = search.trim().toLowerCase();
    return report.sections
      .filter((s) => entity === "all" || s.entity === entity)
      .map((s) => ({ ...s, fields: s.fields.filter((f) => !t || f.name.toLowerCase().includes(t) || f.type.toLowerCase().includes(t)) }));
  }, [report, search, entity]);

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `fub-field-inventory-${report.generatedAt.slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader eyebrow="Stage 1 · Discovery" title="Field inventory">
        A masked report of field shapes, types and fill rates. Examples are redacted by the server; the masked report is saved, but contacts are never stored.
      </PageHeader>
      <Link href="/approvals" data-testid="link-approvals" className="inline-block mb-6 border border-foreground px-4 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">Open guided approvals</Link>

      <section className="border border-foreground p-5 mb-8" data-testid="panel-discovery">
        <div className="eyebrow mb-2">Read-only discovery</div>
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input type="checkbox" data-testid="checkbox-confirm-readonly" className="mt-1 h-4 w-4 accent-black" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I confirm this action only reads from FUB. It does not store contacts, write to FUB, or send anything.</span>
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <RetryButton id="button-run-discovery" busy={!confirm || !userId || discover.isPending} onRetry={run}
            retryAt={Math.max(accessRetryAt(failure), accessRetryAt(discover.error))}
            label="Run read-only discovery" busyLabel={discover.isPending ? "Reading field shapes..." : "Run read-only discovery"}
            className="bg-foreground text-background px-4 py-2 disabled:opacity-40" />
          {discover.isPending && <span className="text-xs text-muted-foreground">This can take a moment.</span>}
        </div>
        {discover.isError && <p className="mt-3 text-sm border-l-2 border-foreground pl-3" data-testid="error-discovery">{errMsg(discover.error)}</p>}
      </section>

      {inv.isLoading && !failure && <Skel rows={6} />}
      {!!failure && <ErrorBlock id="inventory" message={errMsg(failure)} busy={inv.isFetching}
        retryAt={accessRetryAt(failure)} onRetry={() => inv.refetch({ cancelRefetch: false })} />}
      {inv.data && !report && <Empty id="inventory" title="No inventory yet">Run read-only discovery above to produce the first masked field report.</Empty>}

      {report && (
        <>
          {report.status !== "complete" && (
            <div className="border-2 border-foreground p-5 mb-6" role="alert" data-testid="banner-report-status">
              <div className="eyebrow">Discovery {report.status}</div>
              <h2 className="text-2xl mt-1">{report.status === "failed" ? "Every FUB read failed. No CRM data was retrieved." : "Only part of the CRM could be read."}</h2>
              <p className="text-sm mt-2">
                {report.status === "failed" ? "A failed entity is not an empty CRM; its contents are unknown. Review the findings below, then fix credentials or permissions and retry." : "Entities marked failed below are unknown, not empty. Field lists and fill rates cover only entities that were read."}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
            <div className="text-sm text-muted-foreground" data-testid="text-report-meta">
              Attempted {format(new Date(report.generatedAt), "PPpp")} · read-only {report.readOnly ? "yes" : "no"} · contacts persisted: <b className="text-foreground">{report.contactsPersisted}</b>
            </div>
            <button data-testid="button-download-markdown" onClick={download} className="inline-flex items-center gap-2 border border-foreground px-3 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">
              <Download className="h-3.5 w-3.5" /> Download Markdown
            </button>
          </div>

          {report.findings.length > 0 && (
            <>
              <SectionTitle note={`${report.findings.length}`}>Findings</SectionTitle>
              <ul className="divide-y divide-border border-y border-border">
                {report.findings.map((f, i) => (
                  <li key={i} className="py-3 flex gap-4" data-testid={`finding-${i}`}>
                    <Tag solid={f.severity === "blocker"}>{f.severity}</Tag>
                    <div><div className="text-sm font-bold">{f.title}</div><div className="text-sm text-muted-foreground">{f.detail}</div></div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <SectionTitle note="Expected vs. found">Custom field checks</SectionTitle>
          {report.customFieldChecks.length === 0 ? <p className="text-sm border-l-2 border-foreground pl-3" data-testid="text-checks-unconfirmed">Unconfirmed. Custom field definitions could not be read, so no field is reported present or missing.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="eyebrow text-left border-b border-foreground"><th className="py-2 font-normal">Expected name</th><th className="font-normal">API name</th><th className="font-normal text-right">Status</th></tr></thead>
              <tbody>
                {report.customFieldChecks.map((c) => (
                  <tr key={c.expectedName} className="border-b border-border" data-testid={`check-${c.expectedName}`}>
                    <td className="py-2">{c.expectedName}</td>
                    <td className="font-mono text-xs">{c.apiName ?? "—"}</td>
                    <td className="text-right"><Tag solid={c.present}>{c.present ? "Present" : "Missing"}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <SectionTitle note="Masked">Fields by entity</SectionTitle>
          <div className="flex flex-wrap gap-3 mb-5">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input data-testid="input-search-fields" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search field name or type"
                className="w-full border border-input bg-card pl-9 pr-3 py-2 text-sm outline-none focus:border-foreground" />
            </div>
            <div className="flex flex-wrap gap-1">
              {["all", ...report.sections.map((s) => s.entity)].map((e) => (
                <button key={e} data-testid={`filter-entity-${e}`} onClick={() => setEntity(e)}
                  className={`px-3 py-2 text-xs uppercase tracking-widest border ${entity === e ? "bg-foreground text-background border-foreground" : "border-border hover:border-foreground"}`}>{e}</button>
              ))}
            </div>
          </div>
          {sections.map((s) => (
            <section key={s.entity} className="mb-8" data-testid={`section-${s.entity}`}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-lg capitalize">{s.entity}</h3>
                <span className="eyebrow">{s.status === "failed" ? "read failed" : `${s.sampleCount} sampled · ${s.fields.length} shown`}</span>
              </div>
              {s.status === "failed" ? <p className="text-sm border border-foreground p-4" data-testid={`failed-section-${s.entity}`}>Read failed. Contents of {s.entity} are unknown, not empty.</p> : s.fields.length === 0 ? <p className="text-sm text-muted-foreground border border-dashed border-border p-4" data-testid={`empty-fields-${s.entity}`}>No fields match this search.</p> : (
                <div className="overflow-x-auto border-y border-foreground">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead><tr className="eyebrow text-left border-b border-border"><th className="py-2 pl-1 font-normal">Field</th><th className="font-normal">Type</th><th className="font-normal w-40">Populated</th><th className="font-normal">Safe example</th></tr></thead>
                    <tbody>
                      {s.fields.map((f) => (
                        <tr key={f.name} className="border-b border-border last:border-0" data-testid={`row-field-${s.entity}-${f.name}`}>
                          <td className="py-2 pl-1 font-mono text-xs">{f.name}</td>
                          <td className="text-muted-foreground">{f.type}</td>
                          <td>
                            <div className="flex items-center gap-2"><div className="h-1.5 flex-1 bg-muted"><div className="h-full bg-foreground" style={{ width: `${Math.min(100, f.populatedPercent)}%` }} /></div><span className="tabular-nums text-xs w-12 text-right">{f.populatedPercent.toFixed(1)}%</span></div>
                          </td>
                          <td className="font-mono text-xs">{f.redacted ? <Tag>Redacted</Tag> : f.safeExample}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
          {sections.length === 0 && <Empty id="sections" title="No entity selected">Choose a different entity filter.</Empty>}
        </>
      )}
    </div>
  );
}
