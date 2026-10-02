import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getApprovalReview, updateApprovalReview,
  type ApprovalReview, type ReviewAnswer, type ReviewItem, type ReviewSection, type ReviewDecision,
  type UpdateApprovalReviewInput,
} from "@workspace/api-client-react";
import { PageHeader, SectionTitle, Tag, Skel, ErrorBlock, errMsg } from "@/components/kit";
import { getReportCooldown, reportQueryOptions } from "@/lib/report-retry";
import { parseValues, badValues } from "@/lib/approval-values";
import { accessRetryAt } from "@/lib/access-retry";

const KEY = "approval-review";
const BLANK: ReviewAnswer = { fieldId: null, meaning: null, confirmedValues: [], evidence: "", decision: "pending", notes: "" };
const STATUS_LABEL: Record<string, string> = {
  pending: "Not started", in_progress: "In progress", stale: "Needs restart",
  ready_for_signoff: "Ready for final sign-off", final_approved: "Final sign-off recorded",
};

function fmt(s: string | null | undefined) {
  if (!s) return "unknown time";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}
function sameAnswer(a: ReviewAnswer, b: ReviewAnswer) {
  return a.fieldId === b.fieldId && a.meaning === b.meaning && a.confirmedValues.length === b.confirmedValues.length && a.confirmedValues.every((v, i) => v === b.confirmedValues[i]) && a.evidence === b.evidence && a.decision === b.decision && a.notes === b.notes;
}
function apiStatus(e: unknown): number { return e && typeof e === "object" && "status" in e ? Number((e as { status: number }).status) : 0; }
function apiMessage(e: unknown): string {
  const d = e && typeof e === "object" && "data" in e ? (e as { data: unknown }).data : null;
  if (d && typeof d === "object" && "error" in d && typeof (d as { error: unknown }).error === "string") return (d as { error: string }).error;
  return errMsg(e);
}

export default function Approvals() {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const cooldown = getReportCooldown(qc, userId ?? "");
  const queryKey = [KEY, userId ?? ""];
  const q = useQuery(reportQueryOptions(cooldown, queryKey, (signal) => getApprovalReview({ signal, cache: "no-store" }), !!userId));
  const failure = q.failureReason ?? q.error;
  const review = q.data;

  const [drafts, setDrafts] = useState<Record<string, ReviewAnswer>>({});
  const [bases, setBases] = useState<Record<string, { answer: ReviewAnswer; source: string }>>({});
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [reloadRequired, setReloadRequired] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [step, setStep] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "conflict" | "ok"; text: string } | null>(null);

  const mut = useMutation({
    retry: false,
    mutationFn: (data: UpdateApprovalReviewInput) => cooldown.run(() => updateApprovalReview(data)),
  });

  const fresh = !!review && !failure && !q.isError && !q.isFetching;
  const canEdit = fresh && !reloadRequired && review.canApprove && !mut.isPending;

  const answerOf = (it: ReviewItem): ReviewAnswer =>
    drafts[it.id] ?? review?.savedAnswers[it.id] ?? it.savedAnswer ?? BLANK;
  const savedOf = (it: ReviewItem): ReviewAnswer => review?.savedAnswers[it.id] ?? it.savedAnswer ?? BLANK;
  const dirtyIds = useMemo(
    () => Object.keys(drafts).filter((id) => {
      const it = review?.sections.flatMap((s) => s.items).find((i) => i.id === id);
      return !it || !sameAnswer(drafts[id], review?.savedAnswers[id] ?? it.savedAnswer ?? BLANK);
    }),
    [drafts, review],
  );

  // A draft is stale when the server copy it was based on has since changed, or the inventory/rule version moved.
  const staleIds = useMemo(
    () => dirtyIds.filter((id) => {
      const b = bases[id];
      if (!b || !review) return false;
      const it = review.sections.flatMap((x) => x.items).find((i) => i.id === id);
      const now = review.savedAnswers[id] ?? it?.savedAnswer ?? BLANK;
      return b.source !== review.sourceVersion || !sameAnswer(b.answer, now);
    }),
    [dirtyIds, bases, review],
  );
  const sourceMoved = (id: string) => !!review && !!bases[id] && bases[id].source !== review.sourceVersion;
  const dropDrafts = (ids: string[] | "all") => {
    const strip = <T,>(m: Record<string, T>) => { if (ids === "all") return {}; const n = { ...m }; ids.forEach((i) => delete n[i]); return n; };
    setDrafts(strip); setBases(strip); setRaw(strip);
  };
  const rebase = (it: ReviewItem) => {
    if (!review) return;
    setBases((b) => ({ ...b, [it.id]: { answer: savedOf(it), source: review.sourceVersion } }));
    setMsg({ kind: "ok", text: `Your edits to ${it.title} now sit on top of the latest saved version. Check them, then save.` });
  };

  function edit(it: ReviewItem, patch: Partial<ReviewAnswer>) {
    if (review) setBases((b) => b[it.id] ? b : { ...b, [it.id]: { answer: savedOf(it), source: review.sourceVersion } });
    setMsg(null);
    setDrafts((d) => ({ ...d, [it.id]: { ...(d[it.id] ?? savedOf(it)), ...(patch.decision ? {} : { decision: "pending" as ReviewDecision }), ...patch } }));
  }

  async function run(input: Omit<UpdateApprovalReviewInput, "expectedRevision" | "sourceVersion">, okText: string, savedIds: string[] = []) {
    if (!review || !canEdit) return;
    setMsg(null);
    try {
      const next = await mut.mutateAsync({ ...input, expectedRevision: review.revision, sourceVersion: review.sourceVersion });
      qc.setQueryData<ApprovalReview>(queryKey, next);
      dropDrafts(input.action === "reset" ? "all" : savedIds);
      if (input.action === "finalize") setConfirm(false);
      setMsg({ kind: "ok", text: okText });
    } catch (e) {
      const st = apiStatus(e);
      if (st !== 400) { setReloadRequired(true); setReloadAt(accessRetryAt(e)); }
      if (st === 409) {
        setMsg({ kind: "conflict", text: `${apiMessage(e)} Your unsaved input is still on this page and was not applied. Reload the latest review, then rebase or discard each edit before saving.` });
      } else if (st === 403) {
        setMsg({ kind: "error", text: "The server does not allow this account to change the review. Reload to see your current access; you can read only until then." });
      } else if (st === 503) {
        setMsg({ kind: "error", text: "The approval store was unavailable. The outcome is uncertain: the change may or may not have been saved. Reload the shared review before deciding whether to try again. Nothing is retried automatically." });
      } else if (st === 429) {
        setMsg({ kind: "error", text: "The server asked for a wait before more changes. Reload after the wait; nothing is retried automatically." });
      } else if (st === 400) {
        setMsg({ kind: "error", text: `${apiMessage(e)} Fix the input and try again; your edits are kept.` });
      } else {
        setMsg({ kind: "error", text: `${st ? apiMessage(e) : "The connection failed, so the outcome is uncertain."} Reload the shared review before deciding whether to try again. Nothing is retried automatically.` });
      }
    }
  }

  async function reload() {
    setMsg(null);
    const r = await q.refetch({ cancelRefetch: false });
    if (r.status === "success" && !r.error) setReloadRequired(false);
  }

  const reviewItem = (it: ReviewItem, decision: ReviewDecision) => {
    if (staleIds.includes(it.id)) return;
    const base = drafts[it.id] ?? savedOf(it);
    return run({ action: "review_item", itemId: it.id, answer: { ...base, decision } },
      decision === "approved" ? `${it.title} approved.` : `${it.title} marked Needs changes.`, [it.id]);
  };

  const saveAll = (ids: string[]) => {
    if (ids.some((i) => staleIds.includes(i) || (drafts[i] && badValues(drafts[i])))) return;
    const answers: Record<string, ReviewAnswer> = {};
    ids.forEach((id) => { answers[id] = drafts[id]; });
    return run({ action: "save", answers }, "Draft saved.", ids);
  };

  if (q.isLoading && !failure) return <div><PageHeader eyebrow="Review" title="Approvals" /><Skel rows={8} /></div>;
  if (!review) {
    return (
      <div><PageHeader eyebrow="Review" title="Approvals" />
        <ErrorBlock id="approvals" message={failure ? errMsg(failure) : "The approval review could not be loaded."} busy={q.isFetching}
          retryAt={accessRetryAt(failure)} onRetry={() => q.refetch({ cancelRefetch: false })} />
      </div>
    );
  }

  const secs = review.sections;
  const stale = review.status === "stale";
  const final = review.status === "final_approved";
  const lastIdx = secs.length;
  const cur = Math.min(step, lastIdx);
  const sectionOpen = (i: number) => i === 0 || secs[i - 1].approved;

  return (
    <div data-testid="page-approvals">
      <PageHeader eyebrow="Review" title="Approvals">
        Confirm ownership and field mappings, category rules and consent checks together, step by step. Cassandra or Caitlin can do any step and either can finalize. Your saved work is shared and visible to the other reviewer.
      </PageHeader>

      <div className="border border-foreground p-4 mb-6 text-sm leading-relaxed" data-testid="approvals-scope">
        <div className="eyebrow mb-1">What this review does and does not do</div>
        This records whether the proposed field mappings, category rules and consent checks are understood. It does not confirm any recipient&rsquo;s consent, approve automation, approve the unassigned-client team sending exception, or turn on contact sync. SMS stays separately locked. Nothing here writes to FUB.
      </div>

      {(failure || q.isError) && (
        <div className="mb-6"><ErrorBlock id="approvals-refresh" title="Latest review could not be refreshed"
          message={`${errMsg(failure)} Saving and approving are paused until the page reloads successfully. Your unsaved input is kept.`}
          busy={q.isFetching} retryAt={accessRetryAt(failure)} onRetry={() => q.refetch({ cancelRefetch: false })} /></div>
      )}

      <div className="grid md:grid-cols-4 gap-4 border-b border-border pb-6 mb-6" data-testid="approvals-summary">
        <div><div className="eyebrow">Status</div><div className="font-serif text-xl" data-testid="text-approval-status">{STATUS_LABEL[review.status] ?? review.status}</div></div>
        <div><div className="eyebrow">Items approved</div><div className="font-serif text-xl">{review.progress.approvedItems} of {review.progress.totalItems}</div></div>
        <div><div className="eyebrow">Steps approved</div><div className="font-serif text-xl">{review.progress.approvedSections} of {secs.length}</div></div>
        <div><div className="eyebrow">Inventory</div><div className="text-sm">{review.inventoryStatus.replace("_", " ")}, {review.inventoryDate ? fmt(review.inventoryDate) : "not yet saved"}</div></div>
      </div>

      <div className="mb-6 text-sm" data-testid="approvals-role">
        {review.canApprove
          ? <p><Tag solid>Reviewer</Tag> <span className="ml-2">The server recognizes you as an eligible reviewer{review.currentReviewer ? ` (${review.currentReviewer})` : ""}. You can save, approve steps and finalize.</span></p>
          : <p><Tag locked>Read only</Tag> <span className="ml-2 text-muted-foreground">Only the designated reviewers can edit or approve. You can read the work and history here. Ask Cassandra or Caitlin to make changes.</span></p>}
      </div>

      {stale && (
        <div className="border-2 border-foreground p-4 mb-6" data-testid="approvals-stale">
          <div className="font-serif text-lg mb-1">The inventory or rules changed. Earlier approvals no longer apply.</div>
          <p className="text-sm mb-3">Nothing was reset automatically. Restart the review to start approving again against the current version.</p>
          <p className="text-sm mb-3 font-bold" data-testid="text-reset-warning">Restarting clears every saved answer and approval and begins a blank review. Earlier history is kept.{dirtyIds.length > 0 ? ` Your ${dirtyIds.length} unsaved ${dirtyIds.length === 1 ? "edit" : "edits"} will be discarded.` : ""} Earlier answers are not carried over.</p>
          {!confirmReset ? (
            <button data-testid="button-restart-review" disabled={!canEdit} onClick={() => setConfirmReset(true)}
              className="bg-foreground text-background px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">Restart review</button>
          ) : (
            <span className="inline-flex gap-3">
              <button data-testid="button-confirm-restart" disabled={!canEdit} onClick={() => { setConfirmReset(false); run({ action: "reset" }, "Review restarted as a blank review against the current version."); }}
                className="bg-foreground text-background px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">Yes, clear answers and restart</button>
              <button data-testid="button-cancel-restart" onClick={() => setConfirmReset(false)} className="px-4 py-2 text-xs uppercase tracking-widest underline underline-offset-4">Keep current</button>
            </span>
          )}
          {!review.canApprove && <span className="ml-3 text-sm text-muted-foreground">Only a reviewer can restart.</span>}
        </div>
      )}

      {reloadRequired && (
        <div className="mb-6 border-2 border-foreground p-4 text-sm" data-testid="approvals-reload-required">
          <div className="font-serif text-lg mb-1">Reload the shared review before continuing</div>
          <p className="mb-3">The last request did not complete cleanly, so what you see may not be current. Editing, saving and approving are paused. Your unsaved input and its baselines are kept.</p>
          <button data-testid="button-reload-required" disabled={q.isFetching} onClick={reload} className="bg-foreground text-background px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">{q.isFetching ? "Reloading..." : "Reload review"}</button>
          {reloadAt > Date.now() && <span className="ml-3 text-xs text-muted-foreground">The server asked for a short wait; the reload will queue until then.</span>}
        </div>
      )}

      {msg && (
        <div role="status" data-testid={`approvals-msg-${msg.kind}`} className={`mb-6 border p-3 text-sm ${msg.kind === "ok" ? "border-border" : "border-foreground border-2"}`}>
          <p>{msg.text}</p>
          {msg.kind === "conflict" && (
            <div className="mt-2 flex flex-wrap gap-3">
              <button data-testid="button-reload-review" onClick={reload}
                className="border border-foreground px-3 py-1.5 text-xs uppercase tracking-widest">Reload latest review</button>
              {dirtyIds.length > 0 && <button data-testid="button-discard-drafts" onClick={() => dropDrafts("all")}
                className="px-3 py-1.5 text-xs uppercase tracking-widest underline underline-offset-4">Discard my unsaved edits</button>}
            </div>
          )}
        </div>
      )}

      {dirtyIds.length > 0 && (
        <div className="mb-6 border border-dashed border-foreground p-3 text-sm flex flex-wrap items-center justify-between gap-3" data-testid="approvals-unsaved">
          <span>{dirtyIds.length} unsaved {dirtyIds.length === 1 ? "item" : "items"}. These exist only in this browser until saved.</span>
          <button data-testid="button-save-all" disabled={!canEdit || stale || staleIds.length > 0 || dirtyIds.some((i) => drafts[i] && badValues(drafts[i]))} onClick={() => saveAll(dirtyIds)}
            className="border border-foreground px-3 py-1.5 text-xs uppercase tracking-widest disabled:opacity-40">Save draft</button>
          {staleIds.length > 0 && <span className="w-full text-xs" data-testid="text-stale-drafts">{staleIds.length} of these were edited against an older version. Nothing can be saved until you rebase or discard each one below.</span>}
        </div>
      )}

      <nav aria-label="Review steps" className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border mb-8">
        {[...secs.map((s) => s.title), "Review and finalize"].map((t, i) => {
          const done = i < secs.length ? secs[i].approved : final;
          return (
            <button key={t} data-testid={`step-tab-${i}`} onClick={() => setStep(i)} aria-current={cur === i}
              className={`py-2.5 text-sm border-b-2 text-left ${cur === i ? "border-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <span className="font-serif mr-2">{i + 1}</span>{t}{done && <span className="ml-2 text-[10px] uppercase tracking-widest">done</span>}
            </button>
          );
        })}
      </nav>

      {cur < secs.length ? (
        <SectionView
          key={secs[cur].id} section={secs[cur]} open={sectionOpen(cur)} prevTitle={cur > 0 ? secs[cur - 1].title : ""}
          answerOf={answerOf} dirtyIds={dirtyIds} canEdit={canEdit && !stale} finalized={final} rawValues={raw} onRaw={(id, v) => setRaw((r) => ({ ...r, [id]: v }))} staleIds={staleIds} sourceMoved={sourceMoved} latestOf={savedOf} onRebase={rebase} onDiscard={(it) => dropDrafts([it.id])} readOnly={!review.canApprove || stale}
          onEdit={edit} onReview={reviewItem}
          onSave={(ids) => saveAll(ids)}
          onApprove={(sec) => run({ action: "approve", sectionId: sec.id }, `${sec.title} approved.`)}
          onNext={() => setStep(cur + 1)}
        />
      ) : (
        <FinalView review={review} canEdit={canEdit && !stale} confirm={confirm} setConfirm={setConfirm} dirty={dirtyIds.length}
          onFinalize={() => run({ action: "finalize", confirmProposalOnly: true }, "Final sign-off recorded for the proposal only.")} />
      )}

      <SectionTitle note="Shared by both reviewers">History</SectionTitle>
      {review.history.length === 0 ? <p className="text-sm text-muted-foreground">No review activity has been saved yet.</p> : (
        <ul className="divide-y divide-border border-y border-border" data-testid="list-approval-history">
          {review.history.map((h, i) => (
            <li key={`${h.revision}-${i}`} className="py-3 text-sm">
              <div><span className="font-bold">{h.reviewerLabel}</span> <span className="text-muted-foreground">{fmt(h.occurredAt)}, revision {h.revision}</span></div>
              <div className="text-muted-foreground">{h.summary}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground mt-6">Rule version <span className="break-all">{review.ruleVersion}</span>. Inventory fingerprint <span className="break-all">{review.sourceVersion.slice(0, 12)}</span>. <Link href="/safeguards" className="underline underline-offset-4">See safeguards</Link></p>
    </div>
  );
}

function SectionView({ section, open, prevTitle, answerOf, dirtyIds, staleIds, sourceMoved, latestOf, onRebase, onDiscard, canEdit, readOnly, finalized, rawValues, onRaw, onEdit, onReview, onSave, onApprove, onNext }: {
  section: ReviewSection; open: boolean; prevTitle: string;
  answerOf: (i: ReviewItem) => ReviewAnswer; dirtyIds: string[];
  canEdit: boolean; readOnly: boolean; finalized: boolean; rawValues: Record<string, string>; onRaw: (id: string, v: string) => void;
  onEdit: (i: ReviewItem, p: Partial<ReviewAnswer>) => void;
  onReview: (i: ReviewItem, d: ReviewDecision) => void;
  staleIds: string[]; sourceMoved: (id: string) => boolean; latestOf: (i: ReviewItem) => ReviewAnswer;
  onRebase: (i: ReviewItem) => void; onDiscard: (i: ReviewItem) => void;
  onSave: (ids: string[]) => void; onApprove: (s: ReviewSection) => void; onNext: () => void;
}) {
  const ids = section.items.map((i) => i.id);
  const secDirty = ids.filter((id) => dirtyIds.includes(id));
  const answers = section.items.map(answerOf);
  const allApproved = section.items.every((it, i) => !it.required || answers[i].decision === "approved");
  const anyNeeds = answers.some((a) => a.decision === "needs_changes");
  const blockedBy = !open ? `Finish and approve ${prevTitle} first.`
    : secDirty.length ? "Save your draft first so this approval records what you see."
    : anyNeeds ? "At least one item is marked Needs changes."
    : !allApproved ? "Every required item must be marked Approved and saved."
    : "";
  return (
    <section data-testid={`section-${section.id}`}>
      <div className="flex flex-wrap items-center gap-2 mb-1"><h2 className="text-2xl">{section.title}</h2>
        <Tag solid={section.approved} locked={!open}>{section.approved ? "Step approved" : open ? "Open" : "Waiting"}</Tag></div>
      <p className="text-sm leading-relaxed max-w-2xl mb-2">{section.guidance}</p>
      {section.approval && <p className="text-xs text-muted-foreground mb-4" data-testid={`approval-meta-${section.id}`}>Approved by {section.approval.reviewerLabel} on {fmt(section.approval.approvedAt)}.</p>}
      <p className="text-xs text-muted-foreground mb-4 max-w-2xl">Verify meanings in Follow Up Boss under Admin, Settings (stages, tags, statuses and custom fields). Cite the policy or the place in FUB, not a client example. Do not infer meaning from a masked shape alone. If unsure, or if an assignment or value is unknown or unreadable, choose Needs changes and say why. Unknown is not the same as confirmed empty.</p>
      <ol className="border-t border-foreground">
        {section.items.map((it, n) => {
          const a = answers[n];
          const dirty = dirtyIds.includes(it.id);
          const isStale = staleIds.includes(it.id);
          const dis = !canEdit || !open || isStale;
          const eligibleMeaning = it.meanings.length === 0 || (!!a.meaning && it.approvalEligibleMeanings.includes(a.meaning));
          const exempt = it.id === "agent_assignment" && a.meaning === "unassigned_agent";
          const lacks: string[] = [];
          if (it.fieldRequired && !a.fieldId) lacks.push("choose the observed field");
          if (it.meanings.length > 0 && !a.meaning) lacks.push("choose a meaning");
          else if (!eligibleMeaning) lacks.push("this meaning cannot be approved; use Needs changes until resolved");
          if (it.confirmedValuesRequired && !exempt && a.confirmedValues.length === 0) lacks.push("list the exact configured values");
          if (!a.evidence.trim()) lacks.push("add an evidence reference");
          const needsReason = !a.notes.trim();
          const valuesErr = badValues(a);
          const approveOff = dis || lacks.length > 0 || !!valuesErr || finalized;
          return (
            <li key={it.id} data-testid={`item-${it.id}`} className={`py-5 border-b border-border ${open ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-serif text-xl">{it.title}</span>
                {!it.required && <Tag>Optional</Tag>}
                <Tag solid={a.decision === "approved"} locked={a.decision === "pending"}>{a.decision === "approved" ? "Approved" : a.decision === "needs_changes" ? "Needs changes" : "Pending"}</Tag>
                {dirty && <Tag>Unsaved</Tag>}
              </div>
              <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{it.guidance}</p>
              <div className="grid md:grid-cols-2 gap-4 mt-3">
                {it.fieldRequired && (
                  <label className="text-sm block"><span className="eyebrow block mb-1">Observed field</span>
                    {it.acceptedFieldSemantics.length > 0 && <span className="text-xs text-muted-foreground block mb-1">Accepted kinds: {it.acceptedFieldSemantics.join(", ")}</span>}
                    <select data-testid={`select-field-${it.id}`} disabled={dis} value={a.fieldId ?? ""} onChange={(e) => onEdit(it, { fieldId: e.target.value || null })}
                      className="w-full border border-foreground bg-background px-2 py-2 disabled:opacity-50">
                      <option value="">No field chosen</option>
                      {it.fieldOptions.map((f) => <option key={f.id} value={f.id}>{f.entity}: {f.name} ({f.type}{f.semantics.length ? `; ${f.semantics.join(", ")}` : ""})</option>)}
                    </select></label>
                )}
                {it.meanings.length > 0 && (
                  <label className="text-sm block"><span className="eyebrow block mb-1">What the value means</span>
                    <select data-testid={`select-meaning-${it.id}`} disabled={dis} value={a.meaning ?? ""} onChange={(e) => onEdit(it, { meaning: e.target.value || null })}
                      className="w-full border border-foreground bg-background px-2 py-2 disabled:opacity-50">
                      <option value="">Not chosen</option>
                      {it.meanings.map((m) => <option key={m.value} value={m.value}>{m.label}{it.approvalEligibleMeanings.includes(m.value) ? "" : " (Needs changes only)"}</option>)}
                    </select></label>
                )}
                {it.confirmedValuesRequired && (
                  <label className="text-sm block md:col-span-2"><span className="eyebrow block mb-1">Exact configured values, one per line</span>
                    <textarea data-testid={`input-values-${it.id}`} disabled={dis} rows={4} value={rawValues[it.id] ?? a.confirmedValues.join("\n")}
                      onChange={(e) => { onRaw(it.id, e.target.value); onEdit(it, { confirmedValues: parseValues(e.target.value) }); }}
                      className="w-full border border-foreground bg-background px-2 py-2 font-mono disabled:opacity-50" />
                    <span className="text-xs text-muted-foreground">Copy the stage, tag, status, event or source names exactly as configured in FUB Settings. Do not use client examples.{exempt && " Zero values is allowed here because you are confirming the assignment is empty (UNASSIGNED)."}</span>
                    {valuesErr && <span className="block text-xs font-bold mt-1" data-testid={`text-values-error-${it.id}`}>{valuesErr}</span>}
                    <span className="block text-xs text-muted-foreground">{a.confirmedValues.length} of 40 values.</span></label>
                )}
                <label className="text-sm block"><span className="eyebrow block mb-1">Evidence reference (policy or FUB location)</span>
                  <input data-testid={`input-evidence-${it.id}`} disabled={dis} maxLength={500} value={a.evidence} onChange={(e) => onEdit(it, { evidence: e.target.value })}
                    className="w-full border border-foreground bg-background px-2 py-2 disabled:opacity-50" /></label>
                <label className="text-sm block"><span className="eyebrow block mb-1">Notes</span>
                  <textarea data-testid={`input-notes-${it.id}`} disabled={dis} maxLength={1000} rows={2} value={a.notes} onChange={(e) => onEdit(it, { notes: e.target.value })}
                    className="w-full border border-foreground bg-background px-2 py-2 disabled:opacity-50" /></label>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {(["approved", "needs_changes"] as ReviewDecision[]).map((d) => (
                  <button key={d} data-testid={`button-${d}-${it.id}`} disabled={d === "approved" ? approveOff : dis || needsReason || !!valuesErr || finalized} aria-pressed={a.decision === d} onClick={() => onReview(it, d)}
                    className={`px-3 py-1.5 text-xs uppercase tracking-widest border border-foreground disabled:opacity-40 ${a.decision === d ? "bg-foreground text-background" : ""}`}>
                    {d === "approved" ? "Approve" : "Needs changes"}
                  </button>
                ))}
                {dirty && <button data-testid={`button-save-${it.id}`} disabled={dis || !!valuesErr} onClick={() => onSave([it.id])}
                  className="px-3 py-1.5 text-xs uppercase tracking-widest underline underline-offset-4 disabled:opacity-40">Save draft</button>}
              </div>
              {isStale && (
                <div className="mt-3 border-2 border-foreground p-3 text-sm" data-testid={`stale-draft-${it.id}`}>
                  <div className="font-bold mb-1">{sourceMoved(it.id) ? "The inventory or rules changed after you started editing." : "Someone saved a different version of this item after you started editing."}</div>
                  <div className="text-xs text-muted-foreground mb-2">Latest saved: {latestOf(it).decision.replace("_", " ")}; meaning {latestOf(it).meaning ?? "none"}; evidence &ldquo;{latestOf(it).evidence || "none"}&rdquo;; notes &ldquo;{latestOf(it).notes || "none"}&rdquo;; values {latestOf(it).confirmedValues.join(", ") || "none"}. Your edits are shown above and are not saved.</div>
                  <div className="flex gap-3">
                    {!sourceMoved(it.id) && <button data-testid={`button-rebase-${it.id}`} onClick={() => onRebase(it)} className="border border-foreground px-3 py-1.5 text-xs uppercase tracking-widest">Keep my edits on latest</button>}
                    <button data-testid={`button-discard-${it.id}`} onClick={() => onDiscard(it)} className="px-3 py-1.5 text-xs uppercase tracking-widest underline underline-offset-4">Discard my edits</button>
                  </div>
                  {sourceMoved(it.id) && <p className="text-xs mt-2">Because the source version changed, review the item again from the latest version rather than merging.</p>}
                </div>
              )}
              {finalized && <p className="text-xs mt-2" data-testid={`text-final-edit-${it.id}`}>The setup is finally approved, so Approve and Needs changes are paused. Edit this item and click Save draft first. Saving reopens the review, revokes the final sign-off, and clears approvals from the changed step onward. Then approve again.</p>}
              {!dis && needsReason && <p className="text-xs text-muted-foreground mt-2" data-testid={`text-reason-${it.id}`}>Needs changes requires a reason. Add it in Notes.</p>}
              {!dis && lacks.length > 0 && <p className="text-xs text-muted-foreground mt-2" data-testid={`text-lacks-${it.id}`}>To approve: {lacks.join("; ")}.</p>}
              {it.blockers.length > 0 && <ul className="text-xs mt-2 list-disc pl-5">{it.blockers.map((b, k) => <li key={k}>{b}</li>)}</ul>}
            </li>
          );
        })}
      </ol>
      {readOnly && <p className="text-sm text-muted-foreground mt-4" data-testid="text-readonly-why">Editing is off. Either you are not a designated reviewer, or the review needs a restart.</p>}
      <div className="flex flex-wrap items-center gap-3 mt-6">
        <button data-testid="button-save-draft" disabled={!canEdit || !open || secDirty.length === 0 || secDirty.some((id) => staleIds.includes(id) || badValues(answers[ids.indexOf(id)]))} onClick={() => onSave(secDirty)}
          className="border border-foreground px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">Save draft</button>
        <button data-testid={`button-approve-step-${section.id}`} disabled={!canEdit || !!blockedBy || section.approved} onClick={() => onApprove(section)}
          className="bg-foreground text-background px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">Approve this step</button>
        <button data-testid="button-next-step" onClick={onNext} className="px-4 py-2 text-xs uppercase tracking-widest underline underline-offset-4">Next step</button>
      </div>
      {blockedBy && !section.approved && <p className="text-xs text-muted-foreground mt-2" data-testid="text-approve-blocked">{blockedBy}</p>}
    </section>
  );
}

function FinalView({ review, canEdit, confirm, setConfirm, dirty, onFinalize }: {
  review: ApprovalReview; canEdit: boolean; confirm: boolean; setConfirm: (v: boolean) => void; dirty: number; onFinalize: () => void;
}) {
  const ready = review.status === "ready_for_signoff";
  const fa = review.finalApproval;
  return (
    <section data-testid="section-final">
      <h2 className="text-2xl mb-2">Review and finalize</h2>
      {fa ? (
        <div className="border border-foreground p-4 mb-4" data-testid="final-approval">
          <Tag solid>Final sign-off recorded</Tag>
          <p className="text-sm mt-2">Signed by {fa.reviewerLabel} on {fmt(fa.signedAt)}. This is proposal-only: it does not confirm recipient consent, approve automation or the unassigned-client team sending exception, or enable sync.</p>
        </div>
      ) : (
        <p className="text-sm max-w-2xl mb-4">Either Cassandra or Caitlin can finalize once every step is approved. One reviewer is enough.</p>
      )}
      <ul className="border-t border-foreground mb-4">
        {review.sections.map((s) => (
          <li key={s.id} className="py-3 border-b border-border flex flex-wrap items-center gap-2 text-sm">
            <Tag solid={s.approved} locked={!s.approved}>{s.approved ? "Approved" : "Not approved"}</Tag>
            <span className="font-bold">{s.title}</span>
            {s.approval && <span className="text-muted-foreground">{s.approval.reviewerLabel}, {fmt(s.approval.approvedAt)}</span>}
          </li>
        ))}
      </ul>
      {review.blockers.length > 0 && (
        <div className="border border-foreground p-4 mb-4" data-testid="list-approval-blockers">
          <div className="eyebrow mb-1">Blocking final sign-off</div>
          <ul className="list-disc pl-5 text-sm space-y-1">{review.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {!review.inventoryComplete && <p className="text-sm mt-2 text-muted-foreground">The saved inventory is {review.inventoryStatus.replace("_", " ")}. Failed or partial parts are unknown, not empty. Ask the owner to check FUB access, then refresh on Field inventory. This page never runs discovery.</p>}
        </div>
      )}
      {!fa && (
        <>
          <label className="flex gap-3 text-sm max-w-2xl mb-4 items-start">
            <input type="checkbox" data-testid="checkbox-confirm-proposal" className="mt-1" checked={confirm} disabled={!canEdit || !ready} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I understand this signs off the proposal only. It does not approve recipient consent, automation, the unassigned-client team sending exception, or contact sync, and SMS remains locked.</span>
          </label>
          <button data-testid="button-finalize" disabled={!canEdit || !ready || !confirm || dirty > 0} onClick={onFinalize}
            className="bg-foreground text-background px-4 py-2 text-xs uppercase tracking-widest disabled:opacity-40">Finalize proposal</button>
          {dirty > 0 && <p className="text-xs text-muted-foreground mt-2">Save or discard unsaved items first.</p>}
        </>
      )}
      <SectionTitle note="Proposal only">What is being signed off</SectionTitle>
      <p className="text-sm text-muted-foreground max-w-2xl">{review.proposal.audiences.length} audiences, {review.proposal.markets.length} markets and {review.proposal.unresolvedRules.length} unresolved rules. See the <Link href="/blueprint" className="underline underline-offset-4">Blueprint</Link> for the full proposal.</p>
    </section>
  );
}
