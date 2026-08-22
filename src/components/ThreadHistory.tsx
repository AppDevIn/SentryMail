import { useEffect, useRef, useState } from "react";

/** One earlier message in the conversation, from a stored row or parsed from quoted text. */
export interface ThreadItem {
  key: string;
  sender: string;
  address: string | null;
  /** Sortable timestamp (ms), or null when unknown. */
  ts: number | null;
  dateLabel: string | null;
  /** Extractive fallback shown until an AI summary exists. */
  preview: string;
  /** Plain text used for the on-device summary (cache key + model input). */
  summaryText: string;
  source: "stored" | "quoted";
  renderExpanded: () => React.ReactNode;
}

const THREAD_PREVIEW_COUNT = 3;

/** Earlier messages in the thread as collapsible cards. Pass them newest-first. */
export function ThreadHistory({
  items,
  userEmail,
  summarize,
  modelReady = false,
  autoSummarize = true,
}: {
  items: ThreadItem[];
  userEmail: string | null;
  summarize?: (sender: string, text: string, allowGenerate: boolean) => Promise<string | null>;
  modelReady?: boolean;
  autoSummarize?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summarizing, setSummarizing] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const failedRef = useRef(false);

  const visible = showAll ? items : items.slice(0, THREAD_PREVIEW_COUNT);
  const hidden = items.length - visible.length;
  const itemsKey = items.map((i) => i.key).join("|");

  // Cached summaries (no model needed).
  useEffect(() => {
    if (!summarize) return;
    let cancelled = false;
    (async () => {
      const found: Record<string, string> = {};
      for (const it of items) {
        const s = await summarize(it.sender, it.summaryText, false).catch(() => null);
        if (s) found[it.key] = s;
      }
      if (!cancelled && Object.keys(found).length) setSummaries((prev) => ({ ...found, ...prev }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, summarize]);

  const pending = visible.filter((it) => !summaries[it.key]);
  const pendingKey = pending.map((i) => i.key).join("|");

  const runSummaries = async () => {
    if (!summarize || runningRef.current) return;
    runningRef.current = true;
    setSummaryError(null);
    try {
      for (const it of pending) {
        setSummarizing(it.key);
        try {
          const s = await summarize(it.sender, it.summaryText, true);
          if (s) setSummaries((prev) => ({ ...prev, [it.key]: s }));
        } catch (e) {
          setSummaryError(String(e));
          failedRef.current = true;
          break;
        }
      }
    } finally {
      setSummarizing(null);
      runningRef.current = false;
    }
  };

  useEffect(() => {
    if (!autoSummarize || !modelReady || !summarize || failedRef.current) return;
    if (!pendingKey || runningRef.current) return;
    const t = window.setTimeout(() => void runSummaries(), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSummarize, modelReady, pendingKey]);

  if (items.length === 0) return null;

  return (
    <div className="thread">
      <div className="thread-head">
        <span className="thread-title">
          Earlier in this thread · {items.length} of {items.length + 1} messages
        </span>
        {hidden > 0 && (
          <button type="button" className="toolbar-btn" onClick={() => setShowAll(true)}>
            Show all {items.length}
          </button>
        )}
        {showAll && items.length > THREAD_PREVIEW_COUNT && (
          <button type="button" className="toolbar-btn" onClick={() => setShowAll(false)}>
            Show latest {THREAD_PREVIEW_COUNT}
          </button>
        )}
        {summarize && pending.length > 0 && summarizing === null && (!autoSummarize || summaryError || !modelReady) && (
          <button
            type="button"
            className="toolbar-btn is-accent"
            disabled={!modelReady}
            title={modelReady ? "One-line on-device summary of each visible message" : "Load the triage model to get AI summaries"}
            onClick={() => {
              failedRef.current = false;
              void runSummaries();
            }}
          >
            {summaryError ? "Retry summaries" : "Summarize"}
          </button>
        )}
        {summarizing !== null && <span className="toolbar-btn sm-pulse">Summarizing…</span>}
        {summaryError && <span className="inline-error">{summaryError}</span>}
      </div>
      <ul className="thread-list">
        {visible.map((it) => {
          const isYou = !!it.address && !!userEmail && it.address.toLowerCase() === userEmail.toLowerCase();
          const expanded = open.has(it.key);
          return (
            <li key={it.key} className={`thread-card ${isYou ? "thread-card-you" : ""}`}>
              <button
                type="button"
                className="thread-card-head"
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(it.key)) next.delete(it.key);
                    else next.add(it.key);
                    return next;
                  })
                }
              >
                <span className="thread-sender">{isYou ? "You" : it.sender}</span>
                {it.dateLabel && <span className="thread-date">{it.dateLabel}</span>}
                {it.source === "quoted" && (
                  <span className="thread-source" title="Reconstructed from the quoted text (not synced as its own message)">
                    From quote
                  </span>
                )}
                <span className="thread-plus" aria-hidden="true">
                  {expanded ? "−" : "+"}
                </span>
              </button>
              {expanded ? (
                <div className="thread-body sm-fade">{it.renderExpanded()}</div>
              ) : summaries[it.key] ? (
                <p className="thread-preview thread-preview-ai">{summaries[it.key]}</p>
              ) : summarizing === it.key ? (
                <p className="thread-preview thread-preview-muted sm-pulse">Summarizing…</p>
              ) : (
                <p className="thread-preview">{it.preview || "(no text)"}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
