import type { ReactNode } from "react";

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = "default" }: { label: string; value: ReactNode; tone?: "default" | "ok" | "fail" | "warn" }) {
  const toneClass =
    tone === "ok" ? "text-ok" : tone === "fail" ? "text-destructive" : tone === "warn" ? "text-warn" : "text-foreground";
  return (
    <div className="border border-border bg-card px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg ${toneClass}`}>{value}</div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const base =
    "px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const styles =
    variant === "primary"
      ? "bg-primary text-primary-foreground hover:opacity-90"
      : variant === "ghost"
        ? "text-muted-foreground hover:text-foreground"
        : "border border-border bg-card text-foreground hover:bg-secondary";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "fail" | "warn" | "muted"; children: ReactNode }) {
  const map = {
    ok: "border-ok/50 text-ok",
    fail: "border-destructive/50 text-destructive",
    warn: "border-warn/50 text-warn",
    muted: "border-border text-muted-foreground",
  } as const;
  return (
    <span className={`inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${map[tone]}`}>
      {children}
    </span>
  );
}

export function PageShell({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <h1 className="font-mono text-2xl tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{lead}</p>
      <div className="mt-6 space-y-4">{children}</div>
    </main>
  );
}
