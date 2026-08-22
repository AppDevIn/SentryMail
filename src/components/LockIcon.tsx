/** The one SVG the design allows: a 12x12 lock (rect + arc). */
export function LockIcon({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      className={`lock-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" stroke="none" />
      <path d="M3.8 5.5V3.8a2.2 2.2 0 0 1 4.4 0v1.7" />
    </svg>
  );
}
