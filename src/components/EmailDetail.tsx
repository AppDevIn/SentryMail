import { useEffect, useMemo, useRef, useState } from "react";
import type { EmailDto, LabelDto, LabelSuggestion, Risk, TriageResult } from "../types";
import { api } from "../api";
import { MetaTag, typeLabel } from "./Badge";
import { ChevronDownIcon, PlusIcon, ShieldAlertIcon, SparklesIcon } from "./icons";
import { MessageBody, renderPlainLines } from "./MessageBody";
import { ThreadHistory, type ThreadItem } from "./ThreadHistory";
import { UnsubscribeControl } from "./UnsubscribeControl";
import {
  SIGNAL_INFO,
  addressingFor,
  formatFullTime,
  parseAddressList,
  parseSender,
  parseSignals,
  parseThread,
  previewLine,
  signalLabel,
  splitQuotedHistory,
} from "../format";

interface EmailDetailProps {
  email: EmailDto;
  /** The account address this email belongs to (to tell "addressed to you" from "CC'd"). */
  userEmail: string | null;
  triage: TriageResult | null;
  analyzing: boolean;
  analysisError: string | null;
  modelReady: boolean;
  narrow: boolean;
  archived: boolean;
  onOpenSettings: () => void;
  onAnalyze: (emailId: number) => void;
  onClose: () => void;
  onToggleRead: (emailId: number, isRead: boolean) => void;
  onArchive: (emailId: number, archived: boolean) => Promise<void>;
  onSetUserRisk: (emailId: number, risk: Risk | null) => Promise<void>;
  onSetDone: (emailId: number, done: boolean) => Promise<void>;
  labels: LabelDto[];
  onApplyLabels: (emailId: number, add: string[], remove: string[]) => Promise<void>;
  onSuggestLabels: (emailId: number) => Promise<LabelSuggestion[]>;
  onSendReply: (emailId: number, body: string, replyAll: boolean) => Promise<void>;
  onDraftWithAi: (emailId: number, instructions?: string, previousDraft?: string) => Promise<string>;
}

/** UI word for a risk value: "clean" for safe (ADR 0012). */
function verdictWord(risk: Risk): string {
  return risk === "safe" ? "clean" : risk;
}

interface DraftPanelProps {
  emailId: number;
  title: string;
  toneNote: string;
  initialText: string;
  verifyNote: string | null;
  modelReady: boolean;
  /** Reply all preselected (footer "Reply all"). */
  replyAllDefault: boolean;
  /** Other recipients on the original (excluding you and the sender); enables Reply all. */
  otherRecipients: string[];
  onSend: (emailId: number, body: string, replyAll: boolean) => Promise<void>;
  onDraftWithAi: ((emailId: number, instructions?: string, previousDraft?: string) => Promise<string>) | null;
  onClose: () => void;
}

function DraftPanel({
  emailId,
  title,
  toneNote,
  initialText,
  verifyNote,
  modelReady,
  replyAllDefault,
  otherRecipients,
  onSend,
  onDraftWithAi,
  onClose,
}: DraftPanelProps) {
  const [text, setText] = useState(initialText);
  const [replyAll, setReplyAll] = useState(replyAllDefault && otherRecipients.length > 0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [guidance, setGuidance] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(initialText);
    setSent(false);
    setError(null);
  }, [emailId, initialText]);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await onSend(emailId, text, replyAll);
      setSent(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const draftWithAi = async () => {
    if (!onDraftWithAi) return;
    setDrafting(true);
    setError(null);
    try {
      // Redrafting sends the current text so "shorter" / "more formal" revise it, not restart.
      setText(await onDraftWithAi(emailId, guidance, text.trim() ? text : undefined));
      setSent(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDrafting(false);
    }
  };

  if (sent) {
    return (
      <section className="draft sm-fade">
        <div className="draft-head">
          <span className="draft-title">Sent</span>
          <span className="draft-tone">{replyAll ? `Reply all · ${otherRecipients.length + 1} recipients` : "Reply to sender"}</span>
        </div>
        <div className="draft-actions">
          <button type="button" className="link-action" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="draft sm-fade">
      <div className="draft-head">
        <span className="draft-title">{title}</span>
        {otherRecipients.length > 0 && (
          <label className="reply-all">
            <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.currentTarget.checked)} />
            Reply all · +{otherRecipients.length} {otherRecipients.length === 1 ? "recipient" : "recipients"}
          </label>
        )}
        <span className="draft-tone">{toneNote}</span>
      </div>
      {drafting ? (
        <div className="ai-card-running">
          <p className="processing sm-pulse">Drafting locally…</p>
          <div className="skeleton">
            <span className="skeleton-bar sm-sweep" style={{ width: "38%" }} />
            <span className="skeleton-bar sm-sweep" style={{ width: "88%" }} />
            <span className="skeleton-bar sm-sweep" style={{ width: "64%" }} />
          </div>
        </div>
      ) : (
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          rows={8}
          placeholder="Write your reply, or let the on-device model draft one."
          aria-label="Reply"
        />
      )}
      {verifyNote && (
        <p className="verify-note">
          <span className="verify-label">Verify first</span> {verifyNote}
        </p>
      )}
      {onDraftWithAi && (
        <form
          className="guidance"
          onSubmit={(e) => {
            e.preventDefault();
            if (!drafting && modelReady) void draftWithAi();
          }}
        >
          <span className="guidance-label">Instructions</span>
          <input
            type="text"
            value={guidance}
            disabled={drafting}
            onChange={(e) => setGuidance(e.currentTarget.value)}
            placeholder="e.g. decline politely · keep it to two lines · say I'm free Thursday · more formal"
            aria-label="Instructions for the AI draft"
          />
          <span className="guidance-hint">Enter to {text.trim() ? "redraft" : "draft"}</span>
        </form>
      )}
      {error && <p className="inline-error">{error}</p>}
      <div className="draft-actions">
        <button type="button" className="btn btn-accent" disabled={sending || drafting || !text.trim()} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </button>
        {onDraftWithAi && (
          <button
            type="button"
            className="btn"
            disabled={drafting || sending || !modelReady}
            title={modelReady ? "Ask the on-device model for a draft" : "Load the triage model first"}
            onClick={draftWithAi}
          >
            {text.trim() ? "Redraft" : "Write a draft"}
          </button>
        )}
        {initialText && (
          <button type="button" className="link-action" disabled={sending || drafting || text === initialText} onClick={() => setText(initialText)}>
            Discard edits
          </button>
        )}
        <button type="button" className="link-action" disabled={sending || drafting} onClick={onClose}>
          Close
        </button>
        <span className="draft-status">Sends through Gmail · not sent yet</span>
      </div>
    </section>
  );
}

export function EmailDetail({
  email,
  userEmail,
  triage,
  analyzing,
  analysisError,
  modelReady,
  narrow,
  archived,
  onOpenSettings,
  onAnalyze,
  onClose,
  onToggleRead,
  onArchive,
  onSetUserRisk,
  onSetDone,
  labels,
  onApplyLabels,
  onSuggestLabels,
  onSendReply,
  onDraftWithAi,
}: EmailDetailProps) {
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<LabelSuggestion[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    setSuggestions(null);
    setLabelError(null);
    setPickerOpen(false);
  }, [email.id]);
  const labelsById = Object.fromEntries(labels.map((l) => [l.gmail_label_id, l])) as Record<string, LabelDto>;
  const applied = email.label_ids.map((id) => labelsById[id]).filter((l): l is LabelDto => !!l);
  const runLabels = async (fn: () => Promise<void>) => {
    setLabelBusy(true);
    setLabelError(null);
    try {
      await fn();
    } catch (e) {
      setLabelError(String(e));
    } finally {
      setLabelBusy(false);
    }
  };
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = async (fn: () => Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setActionBusy(false);
    }
  };
  const [verdictOpen, setVerdictOpen] = useState(false);
  const verdictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!verdictOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (verdictRef.current && !verdictRef.current.contains(e.target as Node)) setVerdictOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [verdictOpen]);

  const [reply, setReply] = useState<null | { all: boolean; suggested: boolean }>(null);
  useEffect(() => {
    setReply(null);
    setVerdictOpen(false);
    setActionError(null);
  }, [email.id]);

  // Escape closes the reading pane (unless focus is in a field, where Esc just blurs it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
        return;
      }
      if (verdictOpen) {
        setVerdictOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, verdictOpen]);

  const sender = parseSender(email.sender);

  // Earlier messages: real stored messages of this conversation (rendered with the same
  // sandboxed HTML), plus any quoted-only messages the sync doesn't have (e.g. your own
  // sent replies), newest first.
  const [storedThread, setStoredThread] = useState<EmailDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listThreadMessages(email.id)
      .then((list) => {
        if (!cancelled) setStoredThread(list.filter((m) => m.id !== email.id));
      })
      .catch(() => {
        if (!cancelled) setStoredThread([]);
      });
    return () => {
      cancelled = true;
    };
  }, [email.id]);

  const threadItems = useMemo<ThreadItem[]>(() => {
    const { quoted } = splitQuotedHistory(email.body_text || "");
    const quotedMsgs = quoted ? parseThread(quoted).reverse() : [];
    const stored: ThreadItem[] = storedThread.map((m) => {
      const s = parseSender(m.sender);
      const newest = splitQuotedHistory(m.body_text || "").newest;
      return {
        key: `s${m.id}`,
        sender: s.name,
        address: s.address,
        ts: new Date(m.received_at).getTime(),
        dateLabel: formatFullTime(m.received_at),
        preview: previewLine(newest),
        summaryText: newest,
        source: "stored",
        renderExpanded: () => <MessageBody email={m} risk={null} compact onOpenLink={(url) => api.openExternal(url)} />,
      };
    });
    const gaps: ThreadItem[] = quotedMsgs
      .filter((q) => {
        const qts = q.date ? Date.parse(q.date) : NaN;
        const head = q.text.replace(/\s+/g, " ").slice(0, 40).toLowerCase();
        return !storedThread.some((m) => {
          const addr = parseSender(m.sender).address?.toLowerCase();
          const sameAddr = !!q.address && addr === q.address.toLowerCase();
          const mts = new Date(m.received_at).getTime();
          const closeInTime = !Number.isNaN(qts) && Math.abs(mts - qts) < 3 * 60 * 1000;
          const sameText =
            head.length > 12 && splitQuotedHistory(m.body_text || "").newest.replace(/\s+/g, " ").toLowerCase().startsWith(head);
          return (sameAddr && closeInTime) || sameText;
        });
      })
      .map((q, i) => {
        const qts = q.date ? Date.parse(q.date) : NaN;
        return {
          key: `q${i}-${q.address ?? q.sender}-${q.date ?? ""}`,
          sender: q.sender,
          address: q.address,
          ts: Number.isNaN(qts) ? null : qts,
          dateLabel: q.date,
          preview: previewLine(q.text),
          summaryText: q.text,
          source: "quoted" as const,
          renderExpanded: () => renderPlainLines(q.text, `q${i}`, (url) => void api.openExternal(url), false),
        };
      });
    return [...stored, ...gaps].sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity));
  }, [email.body_text, storedThread]);

  const toList = parseAddressList(email.to_addrs);
  const ccList = parseAddressList(email.cc_addrs);
  const addressing = addressingFor(email, userEmail);
  const otherRecipients = [...toList, ...ccList]
    .map((r) => r.address?.toLowerCase())
    .filter((a): a is string => !!a)
    .filter((a, i, arr) => arr.indexOf(a) === i && a !== userEmail?.toLowerCase() && a !== sender.address?.toLowerCase());
  const ok = triage?.triage_status === "ok";
  // The verdict driving the UI: the user's override when set, otherwise the model's.
  const risk: Risk | null = ok ? (triage!.user_risk ?? triage!.risk) : null;
  const overridden = ok && !!triage!.user_risk;
  const signals = triage ? parseSignals(triage.signals_json) : [];
  const isDanger = risk === "danger";
  const flagged = risk === "caution" || risk === "danger";
  const showAiDraft = ok && (risk === "caution" || (risk === "safe" && triage!.type === "action_needed")) && !!triage!.draft_reply;
  const canReply = !isDanger && !analyzing;
  const youLabel = (r: { name: string; address: string | null }) =>
    r.address && userEmail && r.address.toLowerCase() === userEmail.toLowerCase() ? "you" : r.name;
  const isReadNow = email.is_read && email.thread_unread === 0;

  const verdictText = analyzing
    ? "verdict: pending"
    : ok
      ? `verdict: ${verdictWord(risk!)}${overridden ? " · yours" : ""}`
      : triage
        ? "verdict: unreadable"
        : modelReady
          ? "verdict: pending"
          : "verdict: not analyzed";

  const setVerdict = (r: Risk | null) => {
    setVerdictOpen(false);
    void runAction(() => onSetUserRisk(email.id, r));
  };

  return (
    <article className={`reading sm-fade ${isDanger ? "reading-danger" : ""}`}>
      {isDanger && (
        <div className="danger-banner" role="alert">
          <ShieldAlertIcon className="danger-banner-icon" />
          <span className="danger-banner-title">
            Danger · {triage!.type === "scam_risk" ? "likely scam" : typeLabel(triage!.type).toLowerCase()}
          </span>
          <span className="danger-banner-note">Links and reply are disabled. Do not act on this email.</span>
        </div>
      )}

      <div className="reading-toolbar" role="toolbar" aria-label="Email actions">
        {narrow && (
          <button type="button" className="tb-btn tb-back" onClick={onClose} title="Back to the list (Esc)">
            ‹ Back
          </button>
        )}
        <button type="button" className="tb-btn" onClick={() => onToggleRead(email.id, !email.is_read)}>
          {isReadNow ? "Mark unread" : "Mark read"}
        </button>
        <button type="button" className="tb-btn" disabled={actionBusy} onClick={() => void runAction(() => onArchive(email.id, !archived))}>
          {archived ? "Move to inbox" : "Archive"}
        </button>
        {ok && (
          <button type="button" className="tb-btn" disabled={actionBusy} onClick={() => void runAction(() => onSetDone(email.id, !triage!.done))}>
            {triage!.done ? "Reopen" : "Done"}
          </button>
        )}
        <button
          type="button"
          className="tb-btn"
          disabled={!modelReady || actionBusy || analyzing}
          title={modelReady ? "Run the on-device analysis again" : "Turn on analysis in Settings first"}
          onClick={() => onAnalyze(email.id)}
        >
          {triage ? "Re-analyze" : "Analyze"}
        </button>
        <span className="tb-spacer" />
        <div className={`verdict ${risk ? `verdict-${risk}` : ""}`} ref={verdictRef}>
          <button
            type="button"
            className="mono verdict-btn"
            aria-haspopup="menu"
            aria-expanded={verdictOpen}
            disabled={!ok}
            title={ok ? "Set your own verdict" : "Available once the email has been analyzed"}
            onClick={() => setVerdictOpen((o) => !o)}
          >
            {verdictText}
            {ok && <ChevronDownIcon className="verdict-chev" />}
          </button>
          {verdictOpen && ok && (
            <ul className="verdict-menu sm-fade" role="menu">
              <li>
                <button type="button" role="menuitem" className={`menu-item ${risk === "safe" ? "active" : ""}`} onClick={() => setVerdict("safe")}>
                  Not a threat
                </button>
              </li>
              <li>
                <button type="button" role="menuitem" className={`menu-item ${risk === "caution" ? "active" : ""}`} onClick={() => setVerdict("caution")}>
                  Caution
                </button>
              </li>
              <li>
                <button type="button" role="menuitem" className={`menu-item is-danger ${risk === "danger" ? "active" : ""}`} onClick={() => setVerdict("danger")}>
                  Danger
                </button>
              </li>
              {overridden && (
                <li className="menu-sep">
                  <button type="button" role="menuitem" className="menu-item" onClick={() => setVerdict(null)}>
                    Use model's verdict ({verdictWord(triage!.risk)})
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
        {ok && (
          <button
            type="button"
            className={`tb-btn ${risk === "caution" && overridden ? "is-caution" : ""}`}
            disabled={actionBusy}
            title={risk === "caution" && overridden ? "Clear your flag" : "Flag as suspicious (sets your verdict to caution)"}
            onClick={() => setVerdict(risk === "caution" && overridden ? null : "caution")}
          >
            {risk === "caution" && overridden ? "Unflag" : "Flag"}
          </button>
        )}
      </div>

      <div className="reading-body">
        <header className="reading-header">
          <h2 className="reading-subject">{email.subject || "(no subject)"}</h2>

          <div className="reading-from-line">
            <span className="reading-sender">{sender.name}</span>
            {sender.address && sender.address !== sender.name && (
              <span className={`mono reading-address ${isDanger && signals.includes("sender_mismatch") ? "is-spoofed" : ""}`}>
                {sender.address}
              </span>
            )}
            <time className="mono reading-time" dateTime={email.received_at}>
              {formatFullTime(email.received_at)}
            </time>
          </div>
          <div className="reading-from-line reading-to">
            {toList.length > 0 && (
              <span className="recipients-group">
                <span className="field-label">To</span>
                <span className="recipients-names">{toList.map(youLabel).join(", ")}</span>
              </span>
            )}
            {ccList.length > 0 && (
              <span className="recipients-group">
                <span className="field-label">Cc</span>
                <span className="recipients-names">{ccList.map(youLabel).join(", ")}</span>
              </span>
            )}
            {addressing === "cc" && <span className="field-note">you're cc'd</span>}
            {addressing === "none" && <span className="field-note">not addressed to you</span>}
            {ok && (
              <span className="reading-badges">
                {triage!.type === "action_needed" && !triage!.done && <MetaTag tone="urgent">Needs action</MetaTag>}
                {triage!.priority === "high" && !triage!.done && <MetaTag tone="urgent">High priority</MetaTag>}
                {triage!.done && <MetaTag tone="accent">Done</MetaTag>}
              </span>
            )}
          </div>

          {labels.length > 0 && (
            <div className="labels-row">
              {applied.map((l) => (
                <span key={l.id} className="label-chip label-chip-lg" style={{ background: l.color_bg ?? undefined, color: l.color_fg ?? undefined }}>
                  {l.name}
                  <button
                    type="button"
                    className="label-chip-x"
                    title={`Remove ${l.name}`}
                    disabled={labelBusy}
                    onClick={() => void runLabels(() => onApplyLabels(email.id, [], [l.gmail_label_id]))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {suggestions
                ?.filter((s) => !email.label_ids.includes(s.gmail_label_id))
                .map((s) => (
                  <button
                    key={s.gmail_label_id}
                    type="button"
                    className="label-suggestion"
                    disabled={labelBusy}
                    title="Suggested by the on-device model - click to apply"
                    onClick={() => void runLabels(() => onApplyLabels(email.id, [s.gmail_label_id], []))}
                  >
                    + {s.name}
                  </button>
                ))}
              {suggestions && suggestions.filter((s) => !email.label_ids.includes(s.gmail_label_id)).length === 0 && (
                <span className="label-note">No matching label</span>
              )}
              <span className="label-picker">
                <button type="button" className="link-action" disabled={labelBusy} onClick={() => setPickerOpen((o) => !o)}>
                  <PlusIcon />
                  label
                </button>
                {pickerOpen && (
                  <ul className="label-picker-menu sm-fade">
                    {labels
                      .filter((l) => !email.label_ids.includes(l.gmail_label_id))
                      .map((l) => (
                        <li key={l.id}>
                          <button
                            type="button"
                            className="menu-item"
                            onClick={() => {
                              setPickerOpen(false);
                              void runLabels(() => onApplyLabels(email.id, [l.gmail_label_id], []));
                            }}
                          >
                            <span className="label-dot" style={{ background: l.color_bg ?? "var(--accent)" }} />
                            {l.name}
                          </button>
                        </li>
                      ))}
                    {labels.filter((l) => !email.label_ids.includes(l.gmail_label_id)).length === 0 && (
                      <li className="label-note">All labels applied</li>
                    )}
                  </ul>
                )}
              </span>
              <button
                type="button"
                className="link-action"
                disabled={labelBusy || !modelReady}
                title={modelReady ? "Ask the on-device model which of your described labels fit" : "Turn on analysis first"}
                onClick={() => void runLabels(async () => setSuggestions(await onSuggestLabels(email.id)))}
              >
                <SparklesIcon />
                {labelBusy ? "Thinking…" : suggestions ? "Suggest again" : "Suggest"}
              </button>
              {labelError && <span className="inline-error">{labelError}</span>}
            </div>
          )}
          <UnsubscribeControl emailId={email.id} />
        </header>

        <section className={`gist ${flagged ? `gist-${risk}` : ""}`} aria-live="polite">
          <span className="mono gist-label">gist</span>
          <div className="gist-body">
            {analyzing ? (
              <div className="skeleton">
                <span className="skeleton-bar sm-sweep" style={{ width: "62%" }} />
                <span className="skeleton-bar sm-sweep" style={{ width: "38%" }} />
              </div>
            ) : ok ? (
              <>
                <p className="gist-text">{triage!.summary}</p>
                {flagged && (
                  <div className="risk-detail sm-fade">
                    <p className="risk-why">{triage!.risk_explanation}</p>
                    {signals.length > 0 && (
                      <ul className="signal-list">
                        {signals.map((s) => (
                          <li key={s}>
                            <span className={`signal-tag signal-tag-${risk}`}>{signalLabel(s)}</span>
                            <span className="signal-desc">{SIGNAL_INFO[s]?.description ?? ""}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            ) : triage ? (
              <p className="gist-muted">
                Analysis didn't produce a readable result.{" "}
                <button type="button" className="link-action is-accent" disabled={!modelReady} onClick={() => onAnalyze(email.id)}>
                  Retry
                </button>
              </p>
            ) : modelReady ? (
              <p className="gist-muted">
                Not analyzed yet.{" "}
                <button type="button" className="link-action is-accent" onClick={() => onAnalyze(email.id)}>
                  {analysisError ? "Retry" : "Analyze"}
                </button>
                {analysisError && <span className="inline-error"> {analysisError}</span>}
              </p>
            ) : (
              <p className="gist-muted">
                Analysis is off.{" "}
                <button type="button" className="link-action is-accent" onClick={onOpenSettings}>
                  Open settings
                </button>
              </p>
            )}
            {actionError && <p className="inline-error">{actionError}</p>}
          </div>
        </section>

        {!analyzing && ok && isDanger && (
          <section className="action-panel action-panel-danger">
            <div className="action-title">What to do</div>
            <p className="action-copy">
              {triage!.next_step_warning ?? "Don't click links or reply. Contact the sender through a channel you already trust."}
            </p>
            <div className="action-foot">Reply is disabled for this email.</div>
          </section>
        )}

        <MessageBody email={email} risk={risk} onOpenLink={(url) => api.openExternal(url)} />

        {!analyzing && canReply && !reply && (
          <div className="reply-footer">
            <button type="button" className="reply-link is-accent" onClick={() => setReply({ all: false, suggested: showAiDraft })}>
              Reply
            </button>
            {otherRecipients.length > 0 && (
              <button type="button" className="reply-link" onClick={() => setReply({ all: true, suggested: showAiDraft })}>
                Reply all
              </button>
            )}
            {showAiDraft && (
              <span className="reply-note">
                <SparklesIcon /> A suggested reply is ready
              </span>
            )}
            {addressing === "cc" && !showAiDraft && <span className="reply-note">You were cc'd · no reply expected</span>}
          </div>
        )}

        {!analyzing && canReply && reply && (
          <DraftPanel
            emailId={email.id}
            title={reply.suggested ? "Suggested reply" : "Your reply"}
            toneNote={
              reply.suggested
                ? `Tone: ${risk === "caution" ? "cautious, verify first" : "matched to thread"} · editable`
                : addressing === "cc"
                  ? "You were cc'd · optional"
                  : "Editable"
            }
            initialText={reply.suggested ? (triage!.draft_reply ?? "") : ""}
            verifyNote={risk === "caution" && triage?.next_step_warning ? triage.next_step_warning : null}
            modelReady={modelReady}
            replyAllDefault={reply.all}
            otherRecipients={otherRecipients}
            onSend={onSendReply}
            onDraftWithAi={onDraftWithAi}
            onClose={() => setReply(null)}
          />
        )}

        <ThreadHistory items={threadItems} userEmail={userEmail} summarize={api.summarizeMessage} modelReady={modelReady} autoSummarize={!analyzing} />
      </div>
    </article>
  );
}
