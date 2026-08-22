import { useEffect, useMemo, useState } from "react";
import type { EmailDto, LabelDto, LabelSuggestion, TriageResult } from "../types";
import { api } from "../api";
import { MetaTag, RiskPill, typeLabel } from "./Badge";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  MailIcon,
  MailOpenIcon,
  PlusIcon,
  RefreshIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SparklesIcon,
  UndoIcon,
} from "./icons";
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
  analysisMs: number | null;
  analysisError: string | null;
  modelReady: boolean;
  onOpenSettings: () => void;
  onAnalyze: (emailId: number) => void;
  onBack: () => void;
  onToggleRead: (emailId: number, isRead: boolean) => void;
  onSetUserRisk: (emailId: number, risk: "safe" | "caution" | "danger" | null) => Promise<void>;
  onSetDone: (emailId: number, done: boolean) => Promise<void>;
  labels: LabelDto[];
  onApplyLabels: (emailId: number, add: string[], remove: string[]) => Promise<void>;
  onSuggestLabels: (emailId: number) => Promise<LabelSuggestion[]>;
  onSaveDraft: (emailId: number, body: string, replyAll: boolean) => Promise<void>;
  onDraftWithAi: (emailId: number, instructions?: string, previousDraft?: string) => Promise<string>;
}

const GMAIL_DRAFTS_URL = "https://mail.google.com/mail/u/0/#drafts";

interface DraftPanelProps {
  emailId: number;
  title: string;
  toneNote: string;
  initialText: string;
  verifyNote: string | null;
  modelReady: boolean;
  /** Other recipients on the original (excluding you and the sender); enables Reply all. */
  otherRecipients: string[];
  onSave: (emailId: number, body: string, replyAll: boolean) => Promise<void>;
  onDraftWithAi: ((emailId: number, instructions?: string, previousDraft?: string) => Promise<string>) | null;
  onClose: (() => void) | null;
}

function DraftPanel({ emailId, title, toneNote, initialText, verifyNote, modelReady, otherRecipients, onSave, onDraftWithAi, onClose }: DraftPanelProps) {
  const [text, setText] = useState(initialText);
  const [replyAll, setReplyAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [guidance, setGuidance] = useState("");

  useEffect(() => {
    setText(initialText);
    setSaved(false);
    setError(null);
  }, [emailId, initialText]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(emailId, text, replyAll);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const draftWithAi = async () => {
    if (!onDraftWithAi) return;
    setDrafting(true);
    setError(null);
    try {
      // Redrafting sends the current text so "shorter" / "more formal" revise it, not restart.
      setText(await onDraftWithAi(emailId, guidance, text.trim() ? text : undefined));
      setSaved(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDrafting(false);
    }
  };

  const status = saved ? "Saved to Gmail drafts · not sent" : "Not sent";

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
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setSaved(false);
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
        <button type="button" className="btn btn-accent" disabled={saving || drafting || !text.trim()} onClick={save}>
          {saving ? "Saving…" : saved ? "Saved - save again" : "Save to Gmail drafts"}
        </button>
        {onDraftWithAi && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={drafting || saving || !modelReady}
            title={modelReady ? "Ask the on-device model for a draft" : "Load the triage model first"}
            onClick={draftWithAi}
          >
            {text.trim() ? "Redraft" : "Write a draft"}
          </button>
        )}
        {initialText && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving || drafting || text === initialText}
            onClick={() => {
              setText(initialText);
              setSaved(false);
            }}
          >
            Discard edits
          </button>
        )}
        {onClose && (
          <button type="button" className="btn btn-ghost" disabled={saving || drafting} onClick={onClose}>
            Close
          </button>
        )}
        {saved && (
          <button type="button" className="btn btn-mini" onClick={() => void api.openExternal(GMAIL_DRAFTS_URL)}>
            Open Gmail to send
          </button>
        )}
        <span className="draft-status">{status}</span>
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
  onOpenSettings,
  onAnalyze,
  onBack,
  onToggleRead,
  onSetUserRisk,
  onSetDone,
  labels,
  onApplyLabels,
  onSuggestLabels,
  onSaveDraft,
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
  const [verdictBusy, setVerdictBusy] = useState(false);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const setDoneSafely = async (done: boolean) => {
    setVerdictBusy(true);
    setVerdictError(null);
    try {
      await onSetDone(email.id, done);
    } catch (e) {
      setVerdictError(String(e));
    } finally {
      setVerdictBusy(false);
    }
  };
  const setVerdict = async (risk: "safe" | "caution" | "danger" | null) => {
    setVerdictBusy(true);
    setVerdictError(null);
    try {
      await onSetUserRisk(email.id, risk);
    } catch (e) {
      setVerdictError(String(e));
    } finally {
      setVerdictBusy(false);
    }
  };
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);

  useEffect(() => {
    setSignalsOpen(false);
    setReplyOpen(false);
  }, [email.id]);

  // Escape returns to the inbox (unless focus is in a textarea, where Esc just blurs it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
        return;
      }
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

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
        renderExpanded: () => (
          <MessageBody email={m} risk={null} compact onOpenLink={(url) => api.openExternal(url)} />
        ),
      };
    });
    // Quoted messages that match a stored one (same address, within ~3 min, or same opening
    // text) are duplicates; keep only the gaps.
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
  const risk = ok ? (triage!.user_risk ?? triage!.risk) : null;
  const overridden = ok && !!triage!.user_risk && triage!.user_risk !== triage!.risk;
  const signals = triage ? parseSignals(triage.signals_json) : [];
  const isDanger = risk === "danger";
  const showAiDraft =
    ok && (risk === "caution" || (risk === "safe" && triage!.type === "action_needed")) && !!triage!.draft_reply;
  const canReply = !isDanger && !analyzing;
  const youLabel = (r: { name: string; address: string | null }) =>
    r.address && userEmail && r.address.toLowerCase() === userEmail.toLowerCase() ? "you" : r.name;

  const isReadNow = email.is_read && email.thread_unread === 0;

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
        <button type="button" className="tb-btn tb-back" onClick={onBack} title="Back to inbox (Esc)">
          <ArrowLeftIcon />
          Inbox
        </button>
        <span className="tb-sep" aria-hidden="true" />
        <div className="tb-group">
          <button
            type="button"
            className="tb-btn"
            title={isReadNow ? "Mark as unread" : "Mark as read"}
            onClick={() => onToggleRead(email.id, !email.is_read)}
          >
            {isReadNow ? <MailIcon /> : <MailOpenIcon />}
            {isReadNow ? "Mark unread" : "Mark read"}
          </button>
          {ok &&
            (!triage!.done ? (
              <button type="button" className="tb-btn" disabled={verdictBusy} onClick={() => void setDoneSafely(true)}>
                <CheckIcon />
                Mark done
              </button>
            ) : (
              <button type="button" className="tb-btn" disabled={verdictBusy} onClick={() => void setDoneSafely(false)}>
                <UndoIcon />
                Reopen
              </button>
            ))}
          {ok && (
            <button
              type="button"
              className="tb-btn"
              disabled={!modelReady || verdictBusy || analyzing}
              title={modelReady ? "Run the on-device analysis again" : "Load the triage model first"}
              onClick={() => onAnalyze(email.id)}
            >
              <RefreshIcon />
              Re-analyze
            </button>
          )}
        </div>
        <span className="tb-spacer" />
        {ok && (
          <div className={`tb-group tb-security ${risk === "danger" ? "is-danger" : risk === "caution" ? "is-caution" : ""}`} aria-label="Security verdict">
            <span className="tb-group-label">
              <ShieldIcon />
              Verdict
            </span>
            {risk !== "safe" && (
              <button type="button" className="tb-btn" disabled={verdictBusy} onClick={() => void setVerdict("safe")}>
                <ShieldCheckIcon />
                Not a threat
              </button>
            )}
            {risk === "safe" && (
              <button type="button" className="tb-btn" disabled={verdictBusy} onClick={() => void setVerdict("caution")}>
                <ShieldAlertIcon />
                Flag as suspicious
              </button>
            )}
            {risk !== "danger" && (
              <button type="button" className="tb-btn tb-btn-danger" disabled={verdictBusy} onClick={() => void setVerdict("danger")}>
                <ShieldAlertIcon />
                Mark danger
              </button>
            )}
            {triage!.user_risk && (
              <button type="button" className="tb-btn" disabled={verdictBusy} title="Go back to the model's verdict" onClick={() => void setVerdict(null)}>
                <UndoIcon />
                Reset
              </button>
            )}
          </div>
        )}
      </div>

      <div className="reading-body">
        <header className="reading-header">
          <h2 className="reading-subject">{email.subject || "(no subject)"}</h2>

          <div className="reading-from">
            <div className="reading-from-lines">
              <div className="reading-from-line">
                <span className="reading-sender">{sender.name}</span>
                {sender.address && sender.address !== sender.name && (
                  <span className={`reading-address ${isDanger && signals.includes("sender_mismatch") ? "is-spoofed" : ""}`}>
                    {sender.address}
                  </span>
                )}
                {ok && (
                  <span className="reading-badges">
                    {risk !== "safe" && <RiskPill risk={risk!} />}
                    {triage!.type === "action_needed" && !triage!.done && <MetaTag tone="urgent">Needs action</MetaTag>}
                    {triage!.type !== "action_needed" && <MetaTag>{typeLabel(triage!.type)}</MetaTag>}
                    {triage!.priority === "high" && <MetaTag tone="urgent">High priority</MetaTag>}
                    {triage!.done && <MetaTag tone="accent">Done</MetaTag>}
                    {overridden && <MetaTag>Your call · was {triage!.risk}</MetaTag>}
                  </span>
                )}
                <time className="reading-time" dateTime={email.received_at}>
                  {formatFullTime(email.received_at)}
                </time>
              </div>
              {(toList.length > 0 || ccList.length > 0) && (
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
                  {addressing === "cc" && <MetaTag tone="caution">You're cc'd</MetaTag>}
                  {addressing === "none" && <MetaTag>Not addressed to you</MetaTag>}
                </div>
              )}
            </div>
          </div>

          {labels.length > 0 && (
            <div className="labels-row">
              <span className="field-label">Labels</span>
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
              {suggestions?.filter((s) => !email.label_ids.includes(s.gmail_label_id)).map((s) => (
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
              <button
                type="button"
                className="link-action is-accent"
                disabled={labelBusy || !modelReady}
                title={modelReady ? "Ask the on-device model which of your described labels fit" : "Load the triage model first"}
                onClick={() => void runLabels(async () => setSuggestions(await onSuggestLabels(email.id)))}
              >
                <SparklesIcon />
                {labelBusy ? "Thinking…" : suggestions ? "Suggest again" : "Suggest labels"}
              </button>
              <span className="label-picker">
                <button type="button" className="link-action" disabled={labelBusy} onClick={() => setPickerOpen((o) => !o)}>
                  <PlusIcon />
                  Add label
                </button>
                {pickerOpen && (
                  <ul className="label-picker-menu sm-fade">
                    {labels
                      .filter((l) => !email.label_ids.includes(l.gmail_label_id))
                      .map((l) => (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setPickerOpen(false);
                              void runLabels(() => onApplyLabels(email.id, [l.gmail_label_id], []));
                            }}
                          >
                            <span className="label-dot" style={{ background: l.color_bg ?? "var(--neutral-dot)" }} />
                            {l.name}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </span>
              {labelError && <span className="inline-error">{labelError}</span>}
            </div>
          )}
          <UnsubscribeControl emailId={email.id} />
        </header>

        <section className={`summary-card summary-${risk ?? "none"}`} aria-live="polite">
          <span className="summary-icon" aria-hidden="true">
            {analyzing ? <SparklesIcon className="sm-pulse" /> : isDanger ? <ShieldAlertIcon /> : <SparklesIcon />}
          </span>
          <div className="summary-content">
            <div className="summary-head">
              <span className="summary-label">Summary</span>
              <span className="summary-meta">
                {analyzing ? "Analyzing on-device…" : ok ? "On-device" : modelReady ? "Not analyzed" : "Analysis off"}
              </span>
            </div>

            {!analyzing && !triage && (
              <div className="summary-status">
                {modelReady ? (
                  <>
                    <span className="summary-muted">This email hasn't been analyzed yet.</span>
                    <button type="button" className="btn btn-mini" onClick={() => onAnalyze(email.id)}>
                      {analysisError ? "Retry" : "Analyze"}
                    </button>
                    {analysisError && <span className="inline-error">{analysisError}</span>}
                  </>
                ) : (
                  <>
                    <span className="summary-muted">Turn on analysis to get a summary and a risk check.</span>
                    <button type="button" className="btn btn-mini" onClick={onOpenSettings}>
                      Open settings
                    </button>
                  </>
                )}
              </div>
            )}

            {!analyzing && triage && !ok && (
              <div className="summary-status">
                <span className="summary-muted">Analysis didn't produce a readable result.</span>
                <button type="button" className="btn btn-mini" disabled={!modelReady} onClick={() => onAnalyze(email.id)}>
                  Retry
                </button>
              </div>
            )}

            {analyzing && (
              <div className="skeleton">
                <span className="skeleton-bar sm-sweep" style={{ width: "62%" }} />
                <span className="skeleton-bar sm-sweep" style={{ width: "38%" }} />
              </div>
            )}

            {!analyzing && triage && ok && (
              <div className="summary-body sm-fade">
                <p className="summary-text">{triage.summary}</p>
                {risk !== "safe" && <p className="summary-why">{triage.risk_explanation}</p>}
                {signals.length > 0 && (
                  <div className="signals">
                    <button type="button" className="link-action" aria-expanded={signalsOpen} onClick={() => setSignalsOpen((o) => !o)}>
                      <ChevronDownIcon className={`chev ${signalsOpen ? "is-open" : ""}`} />
                      {signalsOpen ? "Hide" : "Show"} {signals.length} {signals.length === 1 ? "warning sign" : "warning signs"}
                    </button>
                    {signalsOpen && (
                      <ul className="signal-list sm-fade">
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
                {verdictError && <p className="inline-error">{verdictError}</p>}
              </div>
            )}
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

        {!analyzing && showAiDraft && (
          <DraftPanel
            emailId={email.id}
            title="Suggested reply"
            toneNote={`Tone: ${risk === "caution" ? "cautious, verify first" : "matched to thread"} · editable`}
            initialText={triage!.draft_reply ?? ""}
            verifyNote={risk === "caution" ? triage!.next_step_warning : null}
            modelReady={modelReady}
            otherRecipients={otherRecipients}
            onSave={onSaveDraft}
            onDraftWithAi={onDraftWithAi}
            onClose={null}
          />
        )}

        {!analyzing && !showAiDraft && canReply && !replyOpen && (
          <div className="reply-cta">
            <button type="button" className="btn" onClick={() => setReplyOpen(true)}>
              Reply
            </button>
            <span className="reply-cta-note">{addressing === "cc" ? "You were cc'd · no reply expected" : ""}</span>
          </div>
        )}

        {!analyzing && !showAiDraft && canReply && replyOpen && (
          <DraftPanel
            emailId={email.id}
            title="Your reply"
            toneNote={addressing === "cc" ? "You were cc'd · optional" : "Editable"}
            initialText=""
            verifyNote={risk === "caution" && triage?.next_step_warning ? triage.next_step_warning : null}
            modelReady={modelReady}
            otherRecipients={otherRecipients}
            onSave={onSaveDraft}
            onDraftWithAi={onDraftWithAi}
            onClose={() => setReplyOpen(false)}
          />
        )}

        <ThreadHistory
          items={threadItems}
          userEmail={userEmail}
          summarize={api.summarizeMessage}
          modelReady={modelReady}
          autoSummarize={!analyzing}
        />
      </div>
    </article>
  );
}
