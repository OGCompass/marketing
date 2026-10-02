import { Link } from "wouter";
import { PageHeader, SectionTitle, Tag } from "@/components/kit";

const STEPS: { n: number; title: string; to: string; label: string; body: string[] }[] = [
  { n: 1, title: "Check the connection", to: "/dashboard", label: "Open Dashboard", body: [
    "Open Dashboard and check the FUB connection status and the last attempt time.",
    "A saved report does not prove that fields have been reviewed." ] },
  { n: 2, title: "Run or review field discovery", to: "/inventory", label: "Open Field inventory", body: [
    "Open Field inventory and review the latest existing report first. Refresh only when needed.",
    "To refresh: check \u201cI confirm this action only reads from FUB. It does not store contacts, write to FUB, or send anything.\u201d, click \u201cRun read-only discovery\u201d, then wait for the result." ] },
  { n: 3, title: "Read the results carefully", to: "/inventory", label: "Open Field inventory", body: [
    "Review Findings and Custom field checks. Use search and the entity filter to narrow fields.",
    "Redacted examples are not missing values. Fill rates cover only sampled records.",
    "Failed or partial resources are unknown, not empty.",
    "Missing required fields need owner review and setup outside this app. The app never creates them.",
    "Email or status fields do not prove consent. Unavailable engagement is not dormancy." ] },
  { n: 4, title: "Download and share the report", to: "/inventory", label: "Open Field inventory", body: [
    "Click \u201cDownload Markdown\u201d to save the masked report. Share it with the owner for field mapping review.",
    "You can also share it with the owner for context. Approvals are recorded in the app on the Approvals page." ] },
  { n: 5, title: "Approve mappings, rules and consent checks", to: "/approvals", label: "Open Approvals", body: [
    "Open Approvals. Cassandra or Caitlin can work through the steps the page lists in order: ownership and field mappings, category rules, then consent checks. Either can save and either can finalize. Anyone else sees a read-only view.",
    "For each item, check what the value means in Follow Up Boss under Admin, Settings (stages, tags, statuses, custom fields). Pick the observed field, choose the meaning, cite the policy or FUB location, and add notes. Do not use client examples as evidence and do not guess from a masked shape.",
    "If you are unsure, choose Needs changes and explain. Approve or Needs changes on an item saves that decision immediately. Editing an item afterward clears its decision so you re-confirm it. Use Save draft for work in progress, then Approve this step once every item is approved. For stages, tags, statuses, events and sources, type the exact configured values, one per line. Later steps unlock in order.",
    "If another reviewer saved first, you will see a conflict message. Your input stays on screen; reload the latest review, then rebase or discard each of your edits before saving. If a request fails with an uncertain outcome, reload before trying again. If the inventory or rules change, earlier approvals stop applying and a reviewer must restart, which clears answers and approvals and begins a blank review (history is kept).",
    "Final sign-off covers the proposal only. It does not confirm any recipient\u2019s consent, approve automation or the unassigned-client team sending exception, or enable sync. SMS stays locked." ] },
  { n: 6, title: "Review the blueprint", to: "/blueprint", label: "Open Blueprint", body: [
    "Open Blueprint to review proposed markets, audiences, cadences, price bands and unresolved rules.",
    "Review the identification evidence and the proposed team routing for unassigned clients. Click \u201cDownload strategy CSV\u201d to save the strategy and rules; it has no client records.",
    "It does not assign any client to a segment." ] },
  { n: 7, title: "Check safeguards, then stop", to: "/safeguards", label: "Open Safeguards", body: [
    "Open Safeguards and stop there. Compass and Oldham Group hosting approval is recorded; completed approvals on the Approvals page do not by themselves enable contact sync.",
    "Segmentation, human accuracy lock, write-back, drafting and sending are not implemented in this release and remain locked." ] },
];

export default function Guide() {
  return (
    <div data-testid="page-guide">
      <PageHeader eyebrow="Start here" title="How to use this workspace">
        This release reads masked field shapes from Follow Up Boss so the team can review them. It does not store contacts, segment, draft, send, or write to FUB. Follow the steps in order.
      </PageHeader>

      <ol>
        {STEPS.map((s) => (
          <li key={s.n} data-testid={`guide-step-${s.n}`} className="flex gap-4 border-b border-border py-6">
            <div className="font-serif text-4xl w-10 shrink-0">{s.n}</div>
            <div className="flex-1">
              <h2 className="text-xl mb-2">{s.title}</h2>
              <ul className="space-y-1.5 text-sm leading-relaxed list-disc pl-5">
                {s.body.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
              <Link href={s.to} data-testid={`link-guide-step-${s.n}`} className="inline-block mt-3 text-xs uppercase tracking-widest underline underline-offset-4">{s.label}</Link>
            </div>
          </li>
        ))}
      </ol>

      <SectionTitle note="Not available">Locked in this release</SectionTitle>
      <div className="flex flex-wrap gap-2" data-testid="list-guide-locked">
        {["Segmentation", "Accuracy lock", "Write-back to FUB", "Drafting", "Sending"].map((t) => <Tag key={t} locked>{t}</Tag>)}
      </div>

      <SectionTitle>Troubleshooting</SectionTitle>
      <dl className="divide-y divide-border border-y border-border text-sm" data-testid="list-guide-troubleshooting">
        <div className="py-3"><dt className="font-bold">Access pending</dt><dd className="text-muted-foreground">Send the project owner your verified primary sign-in email or the user ID shown on that screen for explicit approval, then click Check again. Signing up alone does not grant access. There is no CRM access until you are authorized.</dd></div>
        <div className="py-3"><dt className="font-bold">Discovery failed or partial</dt><dd className="text-muted-foreground">The failed parts are unknown, not empty. Read the diagnostic on Field inventory, ask the owner to check FUB credentials and permissions, then run discovery again.</dd></div>
        <div className="py-3"><dt className="font-bold">A field looks missing</dt><dd className="text-muted-foreground">Confirm the field checks were actually readable (otherwise they show Unconfirmed). If a required field is truly missing, the owner sets it up in FUB. This app never creates fields.</dd></div>
      </dl>
    </div>
  );
}
