import { useEffect, useMemo, useState } from "react";
import type { EmailDto, LabelDto, LabelSuggestion, TriageResult } from "../types";
import { api } from "../api";
import { MetaTag, RiskPill, typeLabel } from "./Badge";
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
  const [aiUsed, setAiUsed] = useState(false);
  const [guidance, setGuidance] = useState("");

  useEffect(() => {
    setText(initialText);
    setSaved(false);
    setError(null);
    setAiUsed(false);
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
      setAiUsed(true);
      setSaved(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDrafting(false);
    }
  };

  const status = saved
    ? "SAVED TO GMAIL DRAFTS · NOT SENT"
    : aiUsed || initialText
      ? "NOT SENT"
      : "NOT SENT";

  return (
    <section className="draft sm-fade">
      <div className="draft-head">
        <span className="mono draft-title">{title}</span>
        {otherRecipients.length > 0 && (
          <label className="mono reply-all">
            <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.currentTarget.checked)} />
            REPLY ALL · +{otherRecipients.length} {otherRecipients.length === 1 ? "RECIPIENT" : "RECIPIENTS"}
          </label>
        )}
        <span className="mono draft-tone">{toneNote}</span>
      </div>
      {drafting ? (
        <div className="ai-card-running">
          <p className="mono processing sm-pulse">DRAFTING LOCALLY…</p>
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
          <span className="mono">VERIFY FIRST</span> {verifyNote}
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
          <span className="mono guidance-label">INSTRUCTIONS</span>
          <input
            type="text"
            value={guidance}
            disabled={drafting}
            onChange={(e) => setGuidance(e.currentTarget.value)}
            placeholder="e.g. decline politely · keep it to two lines · say I'm free Thursday · more formal"
            aria-label="Instructions for the AI draft"
          />
          <span className="mono guidance-hint">ENTER = {text.trim() ? "REDRAFT" : "DRAFT"}</span>
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
          <button type="button" className="btn btn-mini mono" onClick={() => void api.openExternal(GMAIL_DRAFTS_URL)}>
            OPEN GMAIL TO SEND
          </button>
        )}
        <span className="mono draft-status">{status}</span>
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

  return (
    <article className={`reading sm-fade ${isDanger ? "reading-danger" : ""}`}>
      {isDanger && (
        <div className="danger-banner" role="alert">
          <span className="mono danger-banner-title">
            DANGER — {triage!.type === "scam_risk" ? "LIKELY SCAM" : typeLabel(triage!.type).toUpperCase()}
          </span>
          <span className="mono danger-banner-note">LINKS AND REPLY DISABLED · DO NOT ACT ON THIS EMAIL</span>
        </div>
      )}

      <div className="reading-body">
        <button type="button" className="mono back-link" onClick={onBack}>
          ← BACK TO INBOX
        </button>

        <header className="reading-header">
          <h2 className="reading-subject">{email.subject || "(no subject)"}</h2>
          <div className="reading-meta">
            <span className="reading-sender">{sender.name}</span>
            {sender.address && sender.address !== sender.name && (
              <span className={`mono reading-address ${isDanger && signals.includes("sender_mismatch") ? "is-spoofed" : ""}`}>
                {sender.address}
              </span>
            )}
            <span className="mono reading-time">{formatFullTime(email.received_at)}</span>
            <button
              type="button"
              className="mono read-toggle"
              title={email.is_read ? "Mark as unread" : "Mark as read"}
              onClick={() => onToggleRead(email.id, !email.is_read)}
            >
              {email.is_read && email.thread_unread === 0 ? "MARK UNREAD" : "MARK READ"}
            </button>
          </div>
          {ok && (
            <div className="header-chips">
              {risk !== "safe" && <RiskPill risk={risk!} />}
              {overridden && <MetaTag>YOUR CALL · WAS {triage!.risk.toUpperCase()}</MetaTag>}
              {triage!.type === "action_needed" && !triage!.done && <MetaTag tone="urgent">NEEDS ACTION</MetaTag>}
              {triage!.type !== "action_needed" && <MetaTag>{typeLabel(triage!.type).toUpperCase()}</MetaTag>}
              {triage!.priority === "high" && <MetaTag tone="urgent">HIGH PRIORITY</MetaTag>}
              {triage!.done && <MetaTag tone="accent">DONE</MetaTag>}
            </div>
          )}
          {(toList.length > 0 || ccList.length > 0) && (
            <div className="recipients">
              {toList.length > 0 && (
                <span className="recipients-group">
                  <span className="mono recipients-label">TO</span>
                  <span className="recipients-names">{toList.map(youLabel).join(", ")}</span>
                </span>
              )}
              {ccList.length > 0 && (
                <span className="recipients-group">
                  <span className="mono recipients-label">CC</span>
                  <span className="recipients-names">{ccList.map(youLabel).join(", ")}</span>
                </span>
              )}
              {addressing === "cc" && <MetaTag tone="caution">YOU'RE CC'D</MetaTag>}
              {addressing === "none" && <MetaTag>NOT ADDRESSED TO YOU</MetaTag>}
            </div>
          )}
          {labels.length > 0 && (
            <div className="labels-row">
              <span className="mono recipients-label">LABELS</span>
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
                <span className="mono label-note">NO MATCHING LABEL</span>
              )}
              <button
                type="button"
                className="mono verdict-btn is-accent"
                disabled={labelBusy || !modelReady}
                title={modelReady ? "Ask the on-device model which of your described labels fit" : "Load the triage model first"}
                onClick={() => void runLabels(async () => setSuggestions(await onSuggestLabels(email.id)))}
              >
                {labelBusy ? "THINKING…" : suggestions ? "SUGGEST AGAIN" : "SUGGEST LABELS"}
              </button>
              <span className="label-picker">
                <button type="button" className="mono verdict-btn" disabled={labelBusy} onClick={() => setPickerOpen((o) => !o)}>
                  + ADD LABEL
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

        <section className={`gist gist-${risk ?? "none"}`} aria-live="polite">
          {analyzing && <p className="mono gist-status sm-pulse">ANALYZING…</p>}

          {!analyzing && !triage && (
            <p className="gist-status-line">
              {modelReady ? (
                <>
                  <span className="gist-muted">Not analyzed yet.</span>
                  <button type="button" className="mono verdict-btn is-accent" onClick={() => onAnalyze(email.id)}>
                    {analysisError ? "RETRY" : "ANALYZE"}
                  </button>
                  {analysisError && <span className="inline-error">{analysisError}</span>}
                </>
              ) : (
                <>
                  <span className="gist-muted">Analysis is off.</span>
                  <button type="button" className="mono verdict-btn is-accent" onClick={onOpenSettings}>
                    TURN ON IN SETTINGS
                  </button>
                </>
              )}
            </p>
          )}

          {!analyzing && triage && !ok && (
            <p className="gist-status-line">
              <span className="gist-muted">Analysis didn't produce a readable result.</span>
              <button type="button" className="mono verdict-btn is-accent" disabled={!modelReady} onClick={() => onAnalyze(email.id)}>
                RETRY
              </button>
            </p>
          )}

          {!analyzing && triage && ok && (
            <div className="gist-body sm-fade">
              <p className="gist-summary">{triage.summary}</p>
              {risk !== "safe" && <p className="gist-why">{triage.risk_explanation}</p>}
              {signals.length > 0 && (
                <div className="signals">
                  <button type="button" className="mono signals-toggle" aria-expanded={signalsOpen} onClick={() => setSignalsOpen((o) => !o)}>
                    {signals.length} {signals.length === 1 ? "WARNING SIGN" : "WARNING SIGNS"} — {signalsOpen ? "HIDE" : "SHOW"}
                  </button>
                  {signalsOpen && (
                    <ul className="signal-list sm-fade">
                      {signals.map((s) => (
                        <li key={s}>
                          <span className={`mono signal-tag signal-tag-${risk}`}>{signalLabel(s)}</span>
                          <span className="signal-desc">{SIGNAL_INFO[s]?.description ?? ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="gist-actions">
                {!triage.done ? (
                  <button type="button" className="mono verdict-btn" disabled={verdictBusy} onClick={() => void setDoneSafely(true)}>
                    MARK DONE
                  </button>
                ) : (
                  <button type="button" className="mono verdict-btn" disabled={verdictBusy} onClick={() => void setDoneSafely(false)}>
                    REOPEN
                  </button>
                )}
                {risk !== "safe" && (
                  <button type="button" className="mono verdict-btn" disabled={verdictBusy} onClick={() => void setVerdict("safe")}>
                    NOT A THREAT
                  </button>
                )}
                {risk === "safe" && (
                  <button type="button" className="mono verdict-btn" disabled={verdictBusy} onClick={() => void setVerdict("caution")}>
                    FLAG AS SUSPICIOUS
                  </button>
                )}
                {risk !== "danger" && (
                  <button type="button" className="mono verdict-btn verdict-btn-danger" disabled={verdictBusy} onClick={() => void setVerdict("danger")}>
                    MARK DANGER
                  </button>
                )}
                {triage.user_risk && (
                  <button type="button" className="mono verdict-btn" disabled={verdictBusy} onClick={() => void setVerdict(null)}>
                    RESET
                  </button>
                )}
                <button type="button" className="mono verdict-btn" disabled={!modelReady || verdictBusy} title="Analyze again" onClick={() => onAnalyze(email.id)}>
                  RE-ANALYZE
                </button>
              </div>
              {verdictError && <p className="inline-error">{verdictError}</p>}
            </div>
          )}
        </section>

        {!analyzing && ok && isDanger && (
          <section className="action-panel action-panel-danger">
            <div className="mono action-title">WHAT TO DO</div>
            <p className="action-copy">
              {triage!.next_step_warning ?? "Don't click links or reply. Contact the sender through a channel you already trust."}
            </p>
            <div className="mono action-foot">REPLY DISABLED FOR THIS EMAIL</div>
          </section>
        )}

        <MessageBody email={email} risk={risk} onOpenLink={(url) => api.openExternal(url)} />

        {!analyzing && showAiDraft && (
          <DraftPanel
            emailId={email.id}
            title="SUGGESTED REPLY"
            toneNote={`TONE: ${risk === "caution" ? "CAUTIOUS · VERIFY-FIRST" : "MATCHED TO THREAD"} · EDITABLE`}
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
            <span className="mono reply-cta-note">
              {addressing === "cc" ? "YOU WERE CC'D · NO REPLY EXPECTED" : ""}
            </span>
          </div>
        )}

        {!analyzing && !showAiDraft && canReply && replyOpen && (
          <DraftPanel
            emailId={email.id}
            title="YOUR REPLY"
            toneNote={addressing === "cc" ? "YOU WERE CC'D · OPTIONAL" : "EDITABLE"}
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
