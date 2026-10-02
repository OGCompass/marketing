import { useEffect, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="rise border-b border-foreground pb-5 mb-8">
      <div className="eyebrow mb-2">{eyebrow}</div>
      <h1 className="text-3xl md:text-4xl">{title}</h1>
      {children && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{children}</p>}
    </header>
  );
}

export function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border pb-2 mb-4 mt-10">
      <h2 className="text-xl">{children}</h2>
      {note && <span className="eyebrow">{note}</span>}
    </div>
  );
}

export function Tag({ children, solid, locked }: { children: ReactNode; solid?: boolean; locked?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${solid ? "bg-foreground text-background border-foreground" : "border-foreground/60"}`}>
      {locked && <Lock className="h-2.5 w-2.5" />}
      {children}
    </span>
  );
}

export function Stat({ label, value, id }: { label: string; value: ReactNode; id: string }) {
  return (
    <div className="border-l border-border pl-4 first:border-l-0 first:pl-0">
      <div className="eyebrow">{label}</div>
      <div data-testid={`stat-${id}`} className="font-serif text-3xl mt-1 tabular-nums">{value}</div>
    </div>
  );
}

export function Skel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="state-loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse bg-muted" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

export function RetryButton({ onRetry, id, busy = false, retryAt = 0, label = "Retry", busyLabel = "Retrying…", className = "" }: {
  onRetry: () => unknown | Promise<unknown>; id: string; busy?: boolean;
  retryAt?: number; label?: string; busyLabel?: string; className?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const [running, setRunning] = useState(false);
  const locked = useRef(false);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    setNow(Date.now());
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  const retry = async () => {
    // The ref closes the gap before React renders a disabled button.
    if (locked.current || busy || Date.now() < retryAt) return;
    locked.current = true;
    setRunning(true);
    try {
      await onRetry();
    } finally {
      locked.current = false;
      setRunning(false);
    }
  };
  return (
    <button data-testid={id} disabled={busy || running || seconds > 0}
      onClick={() => { void retry(); }}
      className={`border border-foreground px-3 py-1.5 text-xs uppercase tracking-widest hover:bg-foreground hover:text-background disabled:opacity-50 disabled:cursor-not-allowed ${className}`}>
      {seconds > 0 ? `Retry in ${seconds}s` : busy || running ? busyLabel : label}
    </button>
  );
}

export function ErrorBlock({ message, onRetry, id, title = "Request failed", busy = false, retryAt = 0, busyLabel }: {
  message: string; onRetry: () => unknown | Promise<unknown>; id: string;
  title?: string; busy?: boolean; retryAt?: number; busyLabel?: string;
}) {
  return (
    <div className="border border-foreground p-5" data-testid={`error-${id}`} role="alert">
      <div className="eyebrow mb-1">{title}</div>
      <p className="text-sm mb-3">{message}</p>
      <RetryButton id={`button-retry-${id}`} onRetry={onRetry} busy={busy} retryAt={retryAt} busyLabel={busyLabel} />
    </div>
  );
}

export function Empty({ title, children, id }: { title: string; children?: ReactNode; id: string }) {
  return (
    <div className="border border-dashed border-foreground/50 p-10 text-center" data-testid={`empty-${id}`}>
      <h3 className="text-lg mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">{children}</p>
    </div>
  );
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function LockedPhase({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="flex gap-4 border-b border-border py-4 opacity-70" data-testid={`locked-phase-${n}`}>
      <div className="font-serif text-2xl w-8 text-muted-foreground">{n}</div>
      <div className="flex-1">
        <div className="flex items-center gap-2"><span className="font-serif text-lg">{title}</span><Tag locked>Locked</Tag></div>
        <p className="text-sm text-muted-foreground mt-1">{text}</p>
      </div>
    </div>
  );
}
