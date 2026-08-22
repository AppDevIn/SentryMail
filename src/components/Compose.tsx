import { useEffect, useRef, useState } from "react";
import type { AccountDto } from "../types";

interface ComposeProps {
  accounts: AccountDto[];
  /** Preselected From account; null means the user must pick one. */
  defaultAccountId: number | null;
  narrow: boolean;
  onClose: () => void;
  onSend: (accountId: number, to: string, cc: string | null, subject: string, body: string) => Promise<void>;
}

/** New message form in the reading pane. Send goes straight out through Gmail (ADR 0010). */
export function Compose({ accounts, defaultAccountId, narrow, onClose, onSend }: ComposeProps) {
  const [accountId, setAccountId] = useState<number | null>(defaultAccountId);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    toRef.current?.focus();
  }, []);

  // Escape closes compose unless something was typed (then it just blurs the field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const dirty = to.trim() || cc.trim() || subject.trim() || body.trim();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (!dirty) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [to, cc, subject, body, onClose]);

  const canSend = !sending && accountId !== null && to.trim().includes("@") && body.trim().length > 0;
  const from = accounts.find((a) => a.id === accountId) ?? null;

  const send = async () => {
    if (!canSend || accountId === null) return;
    setSending(true);
    setError(null);
    try {
      await onSend(accountId, to.trim(), cc.trim() || null, subject.trim(), body);
      setSent(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <article className="compose sm-fade">
        <div className="reading-toolbar" role="toolbar">
          {narrow && (
            <button type="button" className="tb-btn" onClick={onClose}>
              ‹ Back
            </button>
          )}
          <span className="tb-spacer" />
          <button type="button" className="tb-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="compose-body">
          <p className="compose-sent-title">Sent</p>
          <p className="compose-sent-copy">
            To {to.trim()}
            {cc.trim() ? `, cc ${cc.trim()}` : ""} from {from?.email_address ?? "your account"}.
          </p>
          <div className="compose-actions">
            <button
              type="button"
              className="link-action is-accent"
              onClick={() => {
                setSent(false);
                setTo("");
                setCc("");
                setSubject("");
                setBody("");
              }}
            >
              New message
            </button>
          </div>
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
        <button type="button" className="tb-btn" disabled={sending} onClick={onClose}>
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
              disabled={sending}
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
        <label className="compose-field">
          <span className="field-label">To</span>
          <input
            ref={toRef}
            type="text"
            value={to}
            disabled={sending}
            onChange={(e) => setTo(e.currentTarget.value)}
            placeholder="name@example.com, another@example.com"
            autoComplete="off"
            spellCheck={false}
          />
          {!showCc && (
            <button type="button" className="link-action" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
        </label>
        {showCc && (
          <label className="compose-field">
            <span className="field-label">Cc</span>
            <input
              type="text"
              value={cc}
              disabled={sending}
              onChange={(e) => setCc(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <label className="compose-field">
          <span className="field-label">Subject</span>
          <input type="text" value={subject} disabled={sending} onChange={(e) => setSubject(e.currentTarget.value)} autoComplete="off" />
        </label>
        <textarea
          className="compose-text"
          value={body}
          disabled={sending}
          onChange={(e) => setBody(e.currentTarget.value)}
          rows={14}
          placeholder="Write your message"
          aria-label="Message"
        />
        {error && <p className="inline-error">{error}</p>}
      </form>
    </article>
  );
}
