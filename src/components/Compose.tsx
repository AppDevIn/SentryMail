import { useEffect, useRef, useState } from "react";
import type { AccountDto, ComposeDraft } from "../types";
import { CheckIcon, SparklesIcon } from "./icons";
import { RecipientField, joinRecipients, type Recipient } from "./RecipientField";

interface ComposeProps {
  accounts: AccountDto[];
  /** Preselected From account; null means the user must pick one. */
  defaultAccountId: number | null;
  narrow: boolean;
  /** True when the on-device (Gemma) model is loaded and can draft. */
  modelReady: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  onSend: (accountId: number, to: string, cc: string | null, subject: string, body: string) => Promise<void>;
  /**
   * Ask the on-device model to write (or, with `previousBody`, rewrite) the message from the
   * recipients, subject and instructions. Returns a subject suggestion too, used only when
   * the Subject field is still blank.
   */
  onDraftWithAi: (
    accountId: number,
    to: string,
    cc: string | null,
    subject: string,
    instructions?: string,
    previousBody?: string,
  ) => Promise<ComposeDraft>;
}

/** New message form in the reading pane. Send goes straight out through Gmail (ADR 0010). */
export function Compose({ accounts, defaultAccountId, narrow, modelReady, onOpenSettings, onClose, onSend, onDraftWithAi }: ComposeProps) {
  const [accountId, setAccountId] = useState<number | null>(defaultAccountId);
  const [to, setTo] = useState<Recipient[]>([]);
  const [cc, setCc] = useState<Recipient[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [guidance, setGuidance] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    toRef.current?.focus();
  }, []);

  // Escape closes compose unless something was typed (then it just blurs the field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const dirty = to.length || cc.length || subject.trim() || body.trim() || guidance.trim();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (!dirty) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [to, cc, subject, body, guidance, onClose]);

  const busy = sending || drafting;
  // Header strings for the backend; chips keep the raw "Name <addr>" form the user typed.
  const toHeader = joinRecipients(to);
  const ccHeader = joinRecipients(cc);
  const recipientsOk = to.length > 0 && to.every((r) => r.valid) && cc.every((r) => r.valid);
  const canSend = !busy && accountId !== null && recipientsOk && body.trim().length > 0;
  // The model needs something to go on: instructions, a subject, or a body to rewrite.
  const hasDraftInput = guidance.trim().length > 0 || subject.trim().length > 0 || body.trim().length > 0;
  const canDraft = !busy && modelReady && accountId !== null && hasDraftInput;
  const from = accounts.find((a) => a.id === accountId) ?? null;

  const send = async () => {
    if (!canSend || accountId === null) return;
    setSending(true);
    setError(null);
    try {
      await onSend(accountId, toHeader, ccHeader || null, subject.trim(), body);
      setSent(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const draftWithAi = async () => {
    if (!canDraft || accountId === null) return;
    setDrafting(true);
    setError(null);
    try {
      // Redrafting sends the current body so "shorter" / "more formal" revise it, not restart.
      const draft = await onDraftWithAi(accountId, toHeader, ccHeader || null, subject.trim(), guidance, body.trim() ? body : undefined);
      setBody(draft.body);
      if (!subject.trim() && draft.subject.trim()) setSubject(draft.subject.trim());
      // The instruction has been applied; clear it so the next Enter starts from a blank prompt.
      setGuidance("");
      // Put the caret in the draft so the user can edit straight away.
      requestAnimationFrame(() => bodyRef.current?.focus());
    } catch (e) {
      setError(String(e));
    } finally {
      setDrafting(false);
    }
  };

  const draftTitle = !modelReady
    ? "Load the on-device model in Settings first"
    : accountId === null
      ? "Choose an inbox first"
      : !hasDraftInput
        ? "Add a subject or instructions first"
        : body.trim()
          ? "Rewrite the message with the on-device model"
          : "Ask the on-device model to write the message";

  if (sent) {
    const recipients = to.map((r) => r.label).join(", ");
    const copied = cc.map((r) => r.label).join(", ");
    return (
      <article className="compose sm-fade">
        <div className="reading-toolbar" role="toolbar" aria-label="Sent message actions">
          {narrow && (
            <button type="button" className="tb-btn" onClick={onClose}>
              ‹ Back
            </button>
          )}
          <span className="tb-title">Message sent</span>
          <span className="tb-spacer" />
          <button type="button" className="tb-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="compose-body">
          <section className="compose-sent" role="status" aria-live="polite">
            <span className="compose-sent-mark" aria-hidden="true">
              <CheckIcon />
            </span>
            <div className="compose-sent-main">
              <p className="compose-sent-title">Sent</p>
              <p className="compose-sent-subject">{subject.trim() || "(no subject)"}</p>
              <dl className="compose-sent-meta">
                <div>
                  <dt>To</dt>
                  <dd>{recipients}</dd>
                </div>
                {copied && (
                  <div>
                    <dt>Cc</dt>
                    <dd>{copied}</dd>
                  </div>
                )}
                <div>
                  <dt>From</dt>
                  <dd className="mono">{from?.email_address ?? "your account"}</dd>
                </div>
              </dl>
              <p className="compose-note">Delivered through Gmail. You will find it in your Sent folder there.</p>
              <div className="compose-actions">
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => {
                    setSent(false);
                    setTo([]);
                    setCc([]);
                    setShowCc(false);
                    setSubject("");
                    setBody("");
                    setGuidance("");
                    requestAnimationFrame(() => toRef.current?.focus());
                  }}
                >
                  New message
                </button>
                <button type="button" className="link-action" onClick={onClose}>
                  Back to inbox
                </button>
              </div>
            </div>
          </section>
        </div>
      </article>
    );
  }

  return (
    <article className="compose sm-fade">
      <div className="reading-toolbar" role="toolbar" aria-label="Compose actions">
        {narrow && (
          <button type="button" className="tb-btn" onClick={onClose}>
            ‹ Back
          </button>
        )}
        <span className="tb-title">New message</span>
        <span className="tb-spacer" />
        <button type="button" className="tb-btn" disabled={busy} onClick={onClose}>
          Discard
        </button>
        <button type="button" className="btn btn-accent btn-mini" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>

      <form
        className="compose-body"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {accounts.length > 1 && (
          <label className="compose-field">
            <span className="field-label">From</span>
            <select
              value={accountId ?? ""}
              onChange={(e) => setAccountId(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
              disabled={busy}
            >
              <option value="">Choose an inbox</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email_address}
                </option>
              ))}
            </select>
          </label>
        )}
        {accounts.length === 1 && (
          <div className="compose-field">
            <span className="field-label">From</span>
            <span className="mono compose-from">{accounts[0].email_address}</span>
          </div>
        )}
        <RecipientField
          label="To"
          value={to}
          onChange={setTo}
          disabled={busy}
          inputRef={toRef}
          placeholder="Add recipients - comma, Enter or paste a list"
          trailing={
            !showCc && (
              <button type="button" className="link-action" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )
          }
        />
        {showCc && (
          <RecipientField label="Cc" value={cc} onChange={setCc} disabled={busy} placeholder="Copy others in" autoFocus />
        )}
        <label className="compose-field">
          <span className="field-label">Subject</span>
          <input
            type="text"
            value={subject}
            disabled={busy}
            onChange={(e) => setSubject(e.currentTarget.value)}
            autoComplete="off"
            placeholder={modelReady ? "Leave blank and the draft will suggest one" : undefined}
          />
        </label>

        {/* On-device drafting: tell the model what to say, it writes the body (and a subject if blank). */}
        <div className="guidance compose-guidance" role="group" aria-label="Draft with the on-device model">
          <span className="guidance-label">
            <SparklesIcon /> Instructions
          </span>
          <input
            type="text"
            value={guidance}
            disabled={busy || !modelReady}
            onChange={(e) => setGuidance(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Enter here drafts; it must not submit the surrounding form (which would send).
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (canDraft) void draftWithAi();
            }}
            placeholder={
              modelReady
                ? "e.g. ask Dana if Thursday 3pm works for the review · decline the invite politely · two lines, casual"
                : "Load the on-device model to draft here"
            }
            aria-label="Instructions for the AI draft"
          />
          <button type="button" className="btn btn-mini" disabled={!canDraft} title={draftTitle} onClick={() => void draftWithAi()}>
            {drafting ? "Drafting…" : body.trim() ? "Redraft" : "Write a draft"}
          </button>
        </div>
        {!modelReady && (
          <p className="compose-note">
            The on-device model is off, so drafting is unavailable.{" "}
            <button type="button" className="link-action is-accent" onClick={onOpenSettings}>
              Open settings
            </button>
          </p>
        )}

        {drafting ? (
          <div className="ai-card-running compose-drafting" aria-live="polite">
            <p className="processing sm-pulse">Drafting locally…</p>
            <div className="skeleton">
              <span className="skeleton-bar sm-sweep" style={{ width: "38%" }} />
              <span className="skeleton-bar sm-sweep" style={{ width: "88%" }} />
              <span className="skeleton-bar sm-sweep" style={{ width: "64%" }} />
            </div>
          </div>
        ) : (
          <textarea
            ref={bodyRef}
            className="compose-text"
            value={body}
            disabled={sending}
            onChange={(e) => setBody(e.currentTarget.value)}
            rows={14}
            placeholder={modelReady ? "Write your message, or let the on-device model draft one." : "Write your message"}
            aria-label="Message"
          />
        )}
        {error && <p className="inline-error">{error}</p>}
      </form>
    </article>
  );
}
