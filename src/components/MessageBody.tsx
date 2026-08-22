import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentDto, EmailDto, InlineImageDto, Risk } from "../types";
import { api } from "../api";
import { cleanUrl, linkLabel, splitQuotedHistory } from "../format";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Swaps `src="cid:…"` references for data URIs of the message's own inline images. */
function inlineCidImages(html: string, images: InlineImageDto[]): string {
  if (!images.length) return html;
  return html.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (m, pre: string, cid: string) => {
    const img = images.find((i) => i.content_id === cid || i.content_id === decodeURIComponent(cid));
    return img ? `${pre}data:${img.mime_type};base64,${img.data_base64}` : m;
  });
}

interface MessageBodyProps {
  email: EmailDto;
  risk: Risk | null;
  userEmail?: string | null;
  /** Compact variant for thread cards: no END OF MESSAGE line, lighter toolbar. */
  compact?: boolean;
  onOpenLink: (url: string) => Promise<void> | void;
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
const QUOTE_SELECTOR =
  '.gmail_quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, .moz-cite-prefix, .protonmail_quote';

/**
 * Belt-and-braces sanitizer. The real protection is the iframe: `sandbox` without
 * `allow-scripts` (nothing executes) plus a CSP that forbids every network load, so no
 * tracking pixels, remote fonts, or external CSS ever fire. This pass just removes the
 * obviously active content so it never reaches the document at all.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(iframe|object|embed|applet|form|frame|frameset|video|audio|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|object|embed|applet|form|meta|link|base|frame|input|button|textarea|select)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, " $1=$2#$2")
    .replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*')/gi, "");
}

const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'";

function buildSrcdoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>
html,body{margin:0;padding:0;background:#ffffff;color:#111418;}
body{display:flow-root;padding:18px 20px;font:14px/1.55 -apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;word-break:break-word;overflow-wrap:anywhere;}
img{max-width:100%;height:auto;}
a{color:#0b57d0;}
pre{white-space:pre-wrap;}
table{max-width:100%;}
body.hide-quotes:not(.is-forward) .gmail_quote,body.hide-quotes:not(.is-forward) blockquote[type="cite"],body.hide-quotes:not(.is-forward) .yahoo_quoted,body.hide-quotes:not(.is-forward) #divRplyFwdMsg,body.hide-quotes:not(.is-forward) #divRplyFwdMsg ~ *,body.hide-quotes:not(.is-forward) .moz-cite-prefix,body.hide-quotes:not(.is-forward) .moz-cite-prefix ~ blockquote,body.hide-quotes:not(.is-forward) .protonmail_quote{display:none!important;}
body.hide-sig .gmail_signature,body.hide-sig [data-smartmail="gmail_signature"]{display:none!important;}
body.hide-quotes .sm-cut,body.hide-quotes .sm-cut-after{display:none!important;}
</style></head><body class="hide-quotes">${sanitizeHtml(html)}</body></html>`;
}

interface FrameMeta {
  hasQuotes: boolean;
  hasRemote: boolean;
  hasSignature: boolean;
}
const SIGNATURE_SELECTOR = '.gmail_signature, [data-smartmail="gmail_signature"]';

/** Does this element start a run of reply history (a quote, an "On … wrote:", a RE: header block)? */
function isReplyBoundary(el: Element, quoteSelector: string): boolean {
  if (el.matches(quoteSelector) && !isForwardBlock(el)) return true;
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^from:/i.test(t) && /subject:\s*(re|aw|sv|antw)\s*:/i.test(t.slice(0, 400))) return true;
  if (/^-+\s*original message\s*-+/i.test(t)) return true;
  if (/^on .{5,160}? wrote:/i.test(t.slice(0, 220)) && el.children.length < 6) return true;
  return false;
}

/**
 * In a forward, the forwarded message stays visible but whatever reply history sits
 * *below* it is trimmed (Gmail's "…"). Marks the first boundary after the forward header
 * plus everything after it; returns whether anything was trimmed.
 */
function trimHistoryBelowForward(doc: Document, forwardHeader: Element, quoteSelector: string): boolean {
  const all = [...doc.body.querySelectorAll("*")];
  let passed = false;
  for (const el of all) {
    if (el === forwardHeader) {
      passed = true;
      continue;
    }
    if (!passed || forwardHeader.contains(el) || el.contains(forwardHeader)) continue;
    if (!isReplyBoundary(el, quoteSelector)) continue;
    el.classList.add("sm-cut");
    let node: Element | null = el;
    while (node && node !== doc.body) {
      let sib = node.nextElementSibling;
      while (sib) {
        sib.classList.add("sm-cut-after");
        sib = sib.nextElementSibling;
      }
      node = node.parentElement;
    }
    return true;
  }
  return false;
}

/** True when a quote-looking block is actually forwarded content (keep it visible). */
function isForwardBlock(el: Element): boolean {
  const head = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (/forwarded message|begin forwarded message/i.test(head)) return true;
  if (/^from:/i.test(head)) {
    const m = head.match(/subject:\s*([^\n]{0,80})/i);
    return !m || !/^\s*(re|aw|sv|antw)\s*:/i.test(m[1]);
  }
  return false;
}

function HtmlFrame({
  html,
  subject,
  hideQuotes,
  hideSignature,
  onLink,
  onMeta,
}: {
  html: string;
  subject: string;
  hideQuotes: boolean;
  hideSignature: boolean;
  onLink: (url: string) => void;
  onMeta: (meta: FrameMeta) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const srcdoc = useMemo(() => buildSrcdoc(html), [html]);

  const measure = () => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    // body.offsetHeight follows the in-flow content (hidden quotes excluded); the document's
    // scrollHeight can be inflated by stray positioned/oversized elements in marketing mail.
    const body = doc.body.offsetHeight;
    const docH = doc.documentElement?.scrollHeight ?? body;
    setHeight(Math.max(80, Math.min(body + 2, docH + 2)));
  };

  const forwardRef = useRef(false);
  const handleLoad = () => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    const quoteBlocks = [...doc.querySelectorAll(QUOTE_SELECTOR)];
    // A forward: the forwarded message is content (kept visible), but reply history below
    // it is still trimmed behind the toggle - the same thing Gmail does with its "…".
    const forwardHeader = quoteBlocks.find(isForwardBlock) ?? null;
    const subjectSaysForward = /^\s*(fwd?|fw|wg|tr)\s*:/i.test(subject);
    forwardRef.current = !!forwardHeader || subjectSaysForward;
    // In a forward the generic selector rules would hide the forwarded message itself;
    // switch them off and rely on the explicit cut markers instead.
    doc.body.classList.toggle("is-forward", forwardRef.current);
    let hasHistory: boolean;
    if (forwardHeader) {
      hasHistory = trimHistoryBelowForward(doc, forwardHeader, QUOTE_SELECTOR);
    } else if (subjectSaysForward) {
      // Forward without a recognizable header block (e.g. inline "Begin forwarded message"):
      // find the first reply boundary anywhere and trim from there.
      const first = [...doc.body.querySelectorAll("*")].find((el) => isReplyBoundary(el, QUOTE_SELECTOR));
      hasHistory = !!first && trimHistoryBelowForward(doc, first.previousElementSibling ?? doc.body.firstElementChild ?? first, QUOTE_SELECTOR);
    } else {
      hasHistory = quoteBlocks.length > 0;
    }
    doc.body.classList.toggle("hide-quotes", hideQuotes);
    doc.body.classList.toggle("hide-sig", hideSignature);
    measure();
    onMeta({
      hasQuotes: hasHistory,
      hasRemote: /<img[^>]+src\s*=\s*["']?https?:/i.test(html),
      hasSignature: !!doc.querySelector(SIGNATURE_SELECTOR),
    });
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href.trim())) onLinkRef.current(href.trim());
    });
  };

  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      doc.body.classList.toggle("hide-quotes", hideQuotes);
      doc.body.classList.toggle("hide-sig", hideSignature);
      requestAnimationFrame(measure);
    }
  }, [hideQuotes, hideSignature]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <iframe
      ref={ref}
      title="Email content (sandboxed)"
      className="html-frame"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      style={{ height }}
      onLoad={handleLoad}
    />
  );
}

/** Rejoins hard-wrapped plain-text paragraphs and wrapped <URL>s so they read naturally. */
export function unwrapPlainText(text: string): string {
  // "<\nhttps://…\n>" and "<https://…\n…>" -> "<https://…>" (Gmail wraps long links when quoting).
  const joinedUrls = text
    .replace(/<\s*(https?:\/\/[^>]+?)\s*>/g, (_m, u: string) => `<${u.replace(/\s+/g, "")}>`)
    // A lone "<" line whose closing ">" got lost in re-quoting: drop it, keep the URL line.
    .replace(/(^|\n)<\s*\n(?=https?:\/\/)/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  // Gmail's text/plain marks bold as *word*; drop emphasis asterisks glued to words
  // (list markers like "* item" keep their trailing space and survive).
  const deEmphasized = joinedUrls.replace(/(?<=\S)\*+|\*+(?=\S)/g, "");
  const lines = deEmphasized.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Decide on the *physical* previous line: only a line that ran close to the wrap width
    // (~60+ chars) was hard-wrapped; a short line ended on purpose (list item, sign-off).
    let last = line;
    while (i + 1 < lines.length) {
      const lastT = last.trimEnd();
      const next = lines[i + 1];
      const joinable =
        lastT.length >= 60 &&
        !last.endsWith("  ") &&
        !/:$/.test(lastT) &&
        next.trim().length > 0 &&
        !/^(\s*[-*•>]|\s*\d+[.)]\s|\s{2,}|\t)/.test(next) &&
        // A URL on its own line stays separate unless the sentence clearly continues into it.
        (!/^<?https?:\/\//.test(next.trim()) || !/[.!?:]$/.test(lastT));
      if (!joinable) break;
      line = `${line.trimEnd()} ${next.trim()}`;
      last = next;
      i++;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Renders plain text with rejoined paragraphs, dimmed image placeholders, and clickable links. */
export function renderPlainLines(source: string, keyPrefix: string, onLink: (url: string) => void, linksDisabled: boolean) {
  return (
    unwrapPlainText(source)
      .split("\n")
      .map((line, i) => {
        if (/^\s*\[image:[^\]]*\]\s*$/i.test(line)) {
          return (
            <span key={`${keyPrefix}${i}`} className="plain-line plain-dim">
              {line}
            </span>
          );
        }
        // Strip the angle brackets around bare <URL>s; render the URL as a short label.
        const parts = line.replace(/<(https?:\/\/[^>]+)>/g, "$1").split(URL_RE);
        return (
          <span key={`${keyPrefix}${i}`} className="plain-line">
            {parts.map((part, j) =>
              j % 2 === 1 ? (
                <button
                  key={j}
                  type="button"
                  className="link-btn"
                  disabled={linksDisabled}
                  title={linksDisabled ? "Links are disabled for this email" : cleanUrl(part)}
                  onClick={() => onLink(cleanUrl(part))}
                >
                  {linkLabel(part)}
                </button>
              ) : (
                part
              ),
            )}
          </span>
        );
      })
  );
}

/** Splits a plain-text body at the "-- " signature delimiter. */
export function splitSignature(text: string): { body: string; signature: string | null } {
  const lines = text.split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && /^--\s?$/.test(l));
  if (idx < 0) return { body: text, signature: null };
  return { body: lines.slice(0, idx).join("\n").trimEnd(), signature: lines.slice(idx).join("\n").trim() };
}

function PlainText({
  text,
  quoted,
  quotedOpen,
  signatureOpen,
  onLink,
  linksDisabled,
}: {
  text: string;
  quoted: string | null;
  quotedOpen: boolean;
  signatureOpen: boolean;
  onLink: (url: string) => void;
  linksDisabled: boolean;
}) {
  const { body, signature } = splitSignature(text);
  return (
    <div className="plain-text">
      {renderPlainLines(body || "(empty message)", "n", onLink, linksDisabled)}
      {signature && signatureOpen && <div className="plain-signature sm-fade">{renderPlainLines(signature, "s", onLink, linksDisabled)}</div>}
      {quoted && quotedOpen && <div className="plain-quoted sm-fade">{renderPlainLines(quoted, "q", onLink, linksDisabled)}</div>}
    </div>
  );
}

export function MessageBody({ email, risk, compact = false, onOpenLink }: MessageBodyProps) {
  const hasHtml = !!email.body_html && email.body_html.trim().length > 0;
  const linksDisabled = risk === "danger";
  const [mode, setMode] = useState<"html" | "text">(hasHtml ? "html" : "text");
  const [quotedOpen, setQuotedOpen] = useState(false);
  // Signatures are part of the message (Gmail shows them too); the toggle lets you hide one.
  const [signatureOpen, setSignatureOpen] = useState(true);
  const [meta, setMeta] = useState<FrameMeta>({ hasQuotes: false, hasRemote: false, hasSignature: false });
  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);
  const [inlineImgs, setInlineImgs] = useState<InlineImageDto[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    setMode(hasHtml ? "html" : "text");
    setQuotedOpen(false);
    setSignatureOpen(true);
    setMeta({ hasQuotes: false, hasRemote: false, hasSignature: false });
    setPendingLink(null);
    setLinkError(null);
    setAttachments([]);
    setInlineImgs([]);
    setAttachError(null);
    let cancelled = false;
    api
      .listAttachments(email.id)
      .then((list) => {
        if (cancelled) return;
        setAttachments(list);
        // Inline images are part of the message itself (fetched from Gmail, not a remote host).
        if (list.some((a) => a.content_id && a.mime_type.startsWith("image/")) && /cid:/i.test(email.body_html ?? "")) {
          api.inlineImages(email.id).then((imgs) => !cancelled && setInlineImgs(imgs)).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email.id, hasHtml, email.body_html]);

  const htmlWithImages = useMemo(() => inlineCidImages(email.body_html ?? "", inlineImgs), [email.body_html, inlineImgs]);
  const files = attachments.filter((a) => !a.is_inline || !a.mime_type.startsWith("image/") || !a.content_id);
  const openAttachment = async (a: AttachmentDto) => {
    if (linksDisabled) return;
    setOpening(a.attachment_id);
    setAttachError(null);
    try {
      await api.openAttachment(email.id, a.attachment_id);
    } catch (e) {
      setAttachError(String(e));
    } finally {
      setOpening(null);
    }
  };

  const { newest, quoted } = splitQuotedHistory(email.body_text || "");
  const hasPlainSignature = splitSignature(newest).signature !== null;
  const showSignatureToggle = mode === "html" ? meta.hasSignature : hasPlainSignature;
  // The parent renders earlier messages as thread cards, so quoted history is hidden here;
  // the toggle only appears in compact cards (where there is no thread list below).
  const showQuoteToggle = compact && (mode === "html" ? meta.hasQuotes : !!quoted);

  const open = async (url: string) => {
    setPendingLink(null);
    setLinkError(null);
    try {
      await onOpenLink(url);
    } catch (e) {
      setLinkError(String(e));
    }
  };
  const requestLink = (url: string) => {
    if (linksDisabled) return;
    if (risk === "safe") void open(url);
    else setPendingLink(url); // untriaged or CAUTION: confirm first, showing the real target
  };

  return (
    <section className={`message ${compact ? "message-compact" : ""}`}>
      <div className="message-toolbar">
        {hasHtml && (
          <button type="button" className="mono toolbar-btn" onClick={() => setMode((m) => (m === "html" ? "text" : "html"))}>
            {mode === "html" ? "VIEW PLAIN TEXT" : "VIEW FORMATTED"}
          </button>
        )}
        {showQuoteToggle && (
          <button type="button" className="mono toolbar-btn" aria-expanded={quotedOpen} onClick={() => setQuotedOpen((o) => !o)}>
            {quotedOpen ? "HIDE" : "SHOW"} QUOTED HISTORY
            {mode === "text" && quoted ? ` · ${quoted.split("\n").length} LINES` : ""}
          </button>
        )}
        {showSignatureToggle && (
          <button type="button" className="mono toolbar-btn" aria-expanded={signatureOpen} onClick={() => setSignatureOpen((o) => !o)}>
            {signatureOpen ? "HIDE" : "SHOW"} SIGNATURE
          </button>
        )}
        <span className="toolbar-notes mono">
          {mode === "html" && meta.hasRemote && <span title="Remote images (often tracking pixels) are never loaded">IMAGES BLOCKED</span>}
          {linksDisabled && <span className="is-danger">LINKS DISABLED</span>}
        </span>
      </div>

      {pendingLink && (
        <div className="link-confirm sm-fade" role="dialog" aria-label="Open link">
          <span className="mono link-confirm-label">OPEN IN BROWSER?</span>
          <span className="link-url">{pendingLink}</span>
          <button type="button" className="btn btn-mini mono" onClick={() => open(pendingLink)}>
            OPEN
          </button>
          <button type="button" className="btn btn-mini mono" onClick={() => setPendingLink(null)}>
            CANCEL
          </button>
        </div>
      )}
      {linkError && <p className="inline-error">{linkError}</p>}

      {mode === "html" && hasHtml ? (
        <div className="html-card">
          <HtmlFrame
            html={htmlWithImages}
            subject={email.subject}
            hideQuotes={!quotedOpen}
            hideSignature={!signatureOpen}
            onLink={requestLink}
            onMeta={setMeta}
          />
        </div>
      ) : (
        <PlainText
          text={newest}
          quoted={quoted}
          quotedOpen={quotedOpen}
          signatureOpen={signatureOpen}
          onLink={requestLink}
          linksDisabled={linksDisabled}
        />
      )}

      {files.length > 0 && (
        <div className="attachments">
          <span className="mono attachments-label">
            {files.length} {files.length === 1 ? "ATTACHMENT" : "ATTACHMENTS"}
            {linksDisabled ? " · OPENING DISABLED FOR THIS EMAIL" : ""}
          </span>
          <div className="attachment-chips">
            {files.map((a) => (
              <button
                key={a.id}
                type="button"
                className="attachment-chip"
                disabled={linksDisabled || opening !== null}
                title={`${a.filename} · ${a.mime_type}`}
                onClick={() => void openAttachment(a)}
              >
                <span className="attachment-name">{a.filename}</span>
                <span className="mono attachment-size">{opening === a.attachment_id ? "OPENING…" : formatSize(a.size)}</span>
              </button>
            ))}
          </div>
          {attachError && <p className="inline-error">{attachError}</p>}
        </div>
      )}

      {!compact && <div className="message-end-rule" />}
    </section>
  );
}
