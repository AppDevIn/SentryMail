import { useRef, useState, type KeyboardEvent, type ClipboardEvent, type ReactNode } from "react";
import { parseAddressList } from "../format";

/** One recipient as entered: the raw text we send to Gmail plus what we show on the chip. */
export interface Recipient {
  /** What goes in the header, e.g. `Dana K <dana@example.com>` or `dana@example.com`. */
  raw: string;
  /** Display name when one was given, otherwise the address. */
  label: string;
  /** Bare address (lower-cased for de-duplication), or null when none could be found. */
  address: string | null;
  valid: boolean;
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Splits free text into recipients. Accepts `a@x.com, b@y.org`, `Name <a@x.com>`, and
 * newline/semicolon/whitespace separated lists (common when pasting from a spreadsheet
 * or another mail app). Anything without a usable address is kept but marked invalid so
 * the user sees it rather than silently losing it.
 */
export function parseRecipients(text: string): Recipient[] {
  // parseAddressList splits on commas outside quotes/angle brackets; treat ; and newlines
  // as commas first, and split bare address runs on whitespace.
  const normalized = text.replace(/[;\n\r]+/g, ",");
  const out: Recipient[] = [];
  for (const part of parseAddressList(normalized)) {
    const raw = part.address && part.name !== part.address ? `${part.name} <${part.address}>` : (part.address ?? part.name);
    // A bare run like "a@x.com b@y.org" or "typo priya@x.com" (no angle brackets or quotes)
    // arrives as one part: split it on whitespace so each address stands alone and only the
    // stray token is flagged, instead of the whole run becoming one invalid chip.
    if (!raw.includes("<") && !raw.includes('"') && /\s/.test(raw.trim()) && raw.split(/\s+/).some((w) => w.includes("@"))) {
      for (const w of raw.trim().split(/\s+/)) out.push(toRecipient(w, w, w.includes("@") ? w : null));
      continue;
    }
    out.push(toRecipient(raw, part.name, part.address));
  }
  return out;
}

function toRecipient(raw: string, name: string, address: string | null): Recipient {
  const addr = address?.trim() ?? null;
  const valid = !!addr && ADDRESS_RE.test(addr);
  return { raw: raw.trim(), label: name.trim() || (addr ?? raw.trim()), address: addr ? addr.toLowerCase() : null, valid };
}

/** Header value for the backend: `a@x.com, Dana K <dana@y.org>`. */
export function joinRecipients(list: Recipient[]): string {
  return list.map((r) => r.raw).join(", ");
}

interface RecipientFieldProps {
  label: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Rendered after the input, e.g. the "Cc" reveal link. */
  trailing?: ReactNode;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Chip-style recipient input (compose To / Cc). Each address becomes a removable pill;
 * comma, Enter, Tab, semicolon and blur commit the text being typed; Backspace on an empty
 * input pulls the last chip back into the box for editing; pasted lists are split.
 */
export function RecipientField({ label, value, onChange, disabled, placeholder, autoFocus, trailing, inputRef }: RecipientFieldProps) {
  const [text, setText] = useState("");
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;

  const commit = (raw: string): boolean => {
    const parsed = parseRecipients(raw);
    if (parsed.length === 0) return false;
    const seen = new Set(value.map((r) => r.address ?? r.raw.toLowerCase()));
    const added: Recipient[] = [];
    for (const r of parsed) {
      const key = r.address ?? r.raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(r);
    }
    if (added.length) onChange([...value, ...added]);
    return true;
  };

  const commitText = () => {
    if (text.trim() && commit(text)) setText("");
    else if (!text.trim()) setText("");
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      // Enter here commits the chip; it must not submit the compose form.
      e.preventDefault();
      commitText();
      return;
    }
    if (e.key === "Tab") {
      // Commit what was typed, then let focus move on as usual.
      if (text.trim()) commitText();
      return;
    }
    if (e.key === "Backspace" && !text && value.length) {
      e.preventDefault();
      const last = value[value.length - 1];
      onChange(value.slice(0, -1));
      setText(last.raw);
      return;
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    // Only take over when the clipboard holds a list; a single address behaves like typing.
    if (!/[,;\n]/.test(pasted) && !(/\s/.test(pasted.trim()) && pasted.includes("@"))) return;
    e.preventDefault();
    commit(text + pasted);
    setText("");
  };

  const invalidCount = value.filter((r) => !r.valid).length;

  return (
    <div
      className={`compose-field recipients${disabled ? " is-disabled" : ""}`}
      onClick={(e) => {
        // Clicking the empty area of the row focuses the input, like a normal text field.
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("recipients-list")) ref.current?.focus();
      }}
    >
      <span className="field-label">{label}</span>
      <div className="recipients-list" role="list" aria-label={`${label} recipients`}>
        {value.map((r, i) => (
          <span
            key={`${r.raw}-${i}`}
            role="listitem"
            className={`recipient-chip${r.valid ? "" : " is-invalid"}`}
            title={r.valid ? (r.address && r.address !== r.label.toLowerCase() ? r.address : undefined) : "Not a valid email address"}
          >
            <span className="recipient-chip-text">{r.label}</span>
            <button
              type="button"
              className="recipient-chip-remove"
              aria-label={`Remove ${r.label}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                remove(i);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={ref}
          type="text"
          className="recipients-input"
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={commitText}
          placeholder={value.length ? "" : placeholder}
          aria-label={label}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          size={Math.max(6, text.length + 1)}
        />
      </div>
      {invalidCount > 0 ? (
        <span className="recipients-count is-invalid">
          {invalidCount} invalid
        </span>
      ) : (
        value.length > 1 && <span className="recipients-count">{value.length} recipients</span>
      )}
      {trailing}
    </div>
  );
}
