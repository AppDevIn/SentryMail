import type { Priority, Risk, TriageType } from "../types";
import { PRIORITY_LABELS, RISK_LABELS, TYPE_LABELS } from "../format";

/** Mono, uppercase pill: machine-produced metadata per the design rule (mono = model output). */
export function RiskPill({ risk, size = "sm" }: { risk: Risk; size?: "sm" | "md" }) {
  return (
    <span className={`pill pill-risk-${risk} pill-${size}`}>
      <span className="pill-glyph" aria-hidden="true">
        {risk === "safe" ? "✓" : "!"}
      </span>
      {RISK_LABELS[risk].toUpperCase()}
    </span>
  );
}

export function PriorityDot({ priority, className = "" }: { priority: Priority | null; className?: string }) {
  return (
    <span
      className={`priority-dot priority-${priority ?? "none"} ${className}`}
      title={priority ? `${PRIORITY_LABELS[priority]} priority` : "Not analyzed"}
      aria-label={priority ? `${PRIORITY_LABELS[priority]} priority` : "not analyzed"}
    />
  );
}

export function MetaTag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "danger" | "caution" | "urgent" }) {
  return <span className={`meta-tag meta-tag-${tone}`}>{children}</span>;
}

export function typeLabel(type: TriageType): string {
  return TYPE_LABELS[type];
}

export function priorityLabel(priority: Priority): string {
  return PRIORITY_LABELS[priority];
}
