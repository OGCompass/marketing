import { Link } from "wouter";
import { Brand } from "@/components/shell";
import { LockedPhase } from "@/components/kit";

export default function Home() {
  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <Brand />
          <Link href="/sign-in" data-testid="link-sign-in" className="border border-foreground px-4 py-2 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background">Sign in</Link>
        </div>
      </header>
      <section className="mx-auto max-w-6xl px-4 pt-20 pb-16 rise">
        <div className="eyebrow mb-4">Internal workspace · Review first</div>
        <h1 className="text-5xl md:text-7xl leading-[1.02] max-w-4xl">See exactly what is known before anyone is contacted.</h1>
        <p className="mt-6 max-w-xl text-base text-muted-foreground leading-relaxed">
          A console for The Oldham Group at Compass to prepare a Follow Up Boss communication program. Review masked field discovery and save setup approvals. Contact sync and sending remain off.
        </p>
        <Link href="/sign-in" data-testid="link-cta-sign-in" className="inline-block mt-8 bg-foreground text-background px-6 py-3 text-xs uppercase tracking-widest">Sign in to the workspace</Link>
      </section>
      <section className="border-y border-foreground">
        <div className="mx-auto max-w-6xl px-4 grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
          {[["No contacts stored", "Only masked field reports and setup review decisions are saved—not client records, classifications or outreach drafts."], ["Never writes", "FUB is read from, never written to."], ["Never sends", "Sending is disabled and unreachable."]].map(([t, d]) => (
            <div key={t} className="py-8 md:px-6 first:md:pl-0"><h2 className="text-2xl mb-2">{t}</h2><p className="text-sm text-muted-foreground">{d}</p></div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-16 grid md:grid-cols-[1fr_2fr] gap-10">
        <div><div className="eyebrow mb-2">Roadmap</div><h2 className="text-3xl">One stage is open. The rest are locked.</h2></div>
        <div>
          <div className="flex gap-4 border-b border-border py-4" data-testid="phase-1"><div className="font-serif text-2xl w-8">1</div><div><div className="font-serif text-lg">Field discovery</div><p className="text-sm text-muted-foreground">Available. Masked, read-only field inventory.</p></div></div>
          <LockedPhase n={2} title="Segmentation" text="Not implemented." />
          <LockedPhase n={3} title="Drafting" text="Not implemented." />
          <LockedPhase n={4} title="Approval" text="Not implemented." />
          <LockedPhase n={5} title="Sending" text="Not implemented. Requires consent and approval gates." />
        </div>
      </section>
      <footer className="border-t border-border py-6 text-center eyebrow">The Oldham Group at Compass · Internal use only</footer>
    </div>
  );
}
