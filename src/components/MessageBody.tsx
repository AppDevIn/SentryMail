import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentDto, EmailDto, InlineImageDto, RemoteImageDto, SkippedInlineImageDto, Risk } from "../types";
import { api } from "../api";
import { cleanUrl, formatSize, linkLabel, splitQuotedHistory } from "../format";

/** Swaps `src="cid:…"` references for data URIs of the message's own inline images. */
function inlineCidImages(html: string, images: InlineImageDto[]): string {
  if (!images.length) return html;
  return html.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (m, pre: string, cid: string) => {
    const img = images.find((i) => i.content_id === cid || i.content_id === decodeURIComponent(cid));
    return img ? `${pre}data:${img.mime_type};base64,${img.data_base64}` : m;
  });
}

/** The cids the body actually references, so an unreferenced inline image can still be found. */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src\s*=\s*["']?|url\(\s*["']?)cid:([^"'\s)>]+)/gi)) {
    const cid = m[1];
    out.add(cid);
    // Mirror the lookup in inlineCidImages, which accepts either form.
    try {
      out.add(decodeURIComponent(cid));
    } catch {
      /* a malformed escape just means the raw form is the only one worth having */
    }
  }
  return out;
}

/** A flat neutral block, so a picture that failed reads as "missing" rather than "app broken". */
const MISSING_IMAGE =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#e6e8eb"/></svg>',
  );

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swaps the remote URLs the backend fetched for data URIs.
 *
 * Works on the raw URL string rather than per-context parsing, so one pass covers `src`,
 * `srcset` candidates, `background`, inline `style` `url()` and `<style>` `url()` alike. The
 * entity-encoded form is replaced too: the DOM hands us decoded URLs, but the HTML still holds
 * `&amp;`.
 */
function inlineRemoteImages(html: string, images: RemoteImageDto[]): string {
  if (!images.length) return html;
  let out = html;
  // Longest first: when one URL is a prefix of another (`…/hero.png` vs `…/hero.png?w=2`, which
  // srcset produces constantly), replacing the short one first would corrupt the long one.
  const byLength = [...images].sort((a, b) => b.url.length - a.url.length);
  for (const img of byLength) {
    const replacement = img.data_base64 ? `data:${img.mime_type};base64,${img.data_base64}` : MISSING_IMAGE;
    for (const form of new Set([img.url, img.url.replace(/&/g, "&amp;")])) {
      out = out.replace(new RegExp(escapeRegExp(form), "g"), replacement);
    }
  }
  return out;
}

/** Every remote URL the rendered document actually references, in document order, deduped. */
export function collectRemoteUrls(doc: Document): string[] {
  const found = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const v = (raw ?? "").trim();
    if (/^https?:\/\//i.test(v)) found.add(v);
  };
  const addFromCss = (text: string) => {
    for (const m of text.matchAll(/url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/gi)) add(m[2]);
  };
  const addFromSrcset = (raw: string | null) => {
    for (const candidate of (raw ?? "").split(",")) add(candidate.trim().split(/\s+/)[0]);
  };

  for (const el of doc.querySelectorAll("*")) {
    // Tag name, not `instanceof`: these elements live in the iframe's realm, so they are not
    // instances of *this* window's HTMLImageElement and the check would silently never match.
    if (el.tagName === "IMG") add(el.getAttribute("src"));
    // <body background> and <td background> are still common in marketing mail.
    add(el.getAttribute("background"));
    addFromSrcset(el.getAttribute("srcset"));
    const style = el.getAttribute("style");
    if (style) addFromCss(style);
  }

  // <style> blocks: the frame is same-origin, so the parsed rules are readable. A regex over
  // the raw text is the fallback when a rule refuses to serialise.
  try {
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) walk(nested);
        const style = (rule as CSSStyleRule).style;
        if (!style) continue;
        for (const prop of ["backgroundImage", "background", "listStyleImage", "borderImageSource", "content"] as const) {
          const v = style[prop];
          if (v) addFromCss(v);
        }
      }
    };
    for (const sheet of doc.styleSheets) walk(sheet.cssRules);
  } catch {
    for (const el of doc.querySelectorAll("style")) addFromCss(el.textContent ?? "");
  }

  return [...found];
}

interface MessageBodyProps {
  email: EmailDto;
  risk: Risk | null;
  userEmail?: string | null;
  /** Compact variant for thread cards: no END OF MESSAGE line, lighter toolbar. */
  compact?: boolean;
  onOpenLink: (url: string) => Promise<void> | void;
  /**
   * Opens the attachment in the in-app preview pane. When omitted the chip falls back to
   * handing the file to the system's default app, so this component stays usable standalone.
   */
  onPreviewAttachment?: (attachment: AttachmentDto) => void;
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

/** Colors the sandboxed frame inherits from the app theme so the card doesn't fracture the page. */
export interface FramePalette {
  dark: boolean;
  bg: string;
  text: string;
  link: string;
}

const LIGHT_PALETTE: FramePalette = { dark: false, bg: "#ffffff", text: "#111418", link: "#0b57d0" };

/** Reads the live app palette off :root so the frame matches light/dark exactly. */
function readPalette(): FramePalette {
  const cs = getComputedStyle(document.documentElement);
  const get = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  const dark = get("color-scheme", "dark") === "dark";
  if (!dark) return LIGHT_PALETTE;
  return { dark: true, bg: get("--surface", "#181b20"), text: get("--text", "#e6edf3"), link: get("--accent-strong", "#60a5fa") };
}

/** Re-reads the palette whenever the theme attribute/class on <html> or the OS scheme changes. */
function usePalette(): FramePalette {
  const [pal, setPal] = useState<FramePalette>(() => readPalette());
  useEffect(() => {
    const update = () => setPal(readPalette());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", update);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", update);
    };
  }, []);
  return pal;
}

/** Where reply/forward history starts: Gmail/Yahoo/Proton/Thunderbird classes, Outlook's From: block. */
const HISTORY_START_RE =
  /class="[^"]*\b(gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix)\b|id="(divRplyFwdMsg|appendonsend)"|<blockquote[^>]+type="cite"|<b>\s*From:\s*<\/b>|border-top:\s*solid\s+#e1e1e1|-{3,}\s*Original Message\s*-{3,}/i;

const WHITE_RE = /^(#fff(?:fff)?\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i;

/**
 * Designed (marketing) mail paints its own canvas: a background on a structural element
 * (table/cell/body/center) that isn't plain white. Coloured spans, signature badges, and a
 * `background:white` wrapper are prose and stay on the app theme, where the dark fix-up
 * keeps them readable. Only the visible part counts - collapsed history says nothing
 * about how this message was designed.
 */
export function paintsOwnCanvas(html: string): boolean {
  const cut = html.search(HISTORY_START_RE);
  const visible = cut >= 0 ? html.slice(0, cut) : html;
  for (const m of visible.matchAll(/<(?:table|td|th|body|center)\b[^>]*?(?:\bbgcolor\s*=\s*["']?([^"'\s>]+)|background(?:-color)?\s*:\s*([^;"']+))/gi)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (!v || /^(transparent|none|inherit|initial|unset)\b/i.test(v) || WHITE_RE.test(v)) continue;
    return true;
  }
  return false;
}

function parseRgb(v: string): [number, number, number, number] | null {
  const m = v.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)/i);
  if (!m) return null;
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Lifts a dark colour into the readable range while keeping its hue (greys go to the app text colour). */
function lighten([r, g, b]: [number, number, number, number], fallback: string): string {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) return fallback;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return `hsl(${h} ${Math.round(Math.min(sat, 0.9) * 100)}% 74%)`;
}

/**
 * Dark-theme fix-up for mail that hard-codes dark text (Outlook forward headers use
 * `<font color="#000000">`, signatures use `color:#333`): text sitting directly on the
 * frame's dark surface is lifted to a readable colour; text inside a block that paints its
 * own background is left alone, since that block still looks the way its author intended.
 */
function adaptDarkText(doc: Document, pal: FramePalette) {
  const win = doc.defaultView;
  if (!win) return;
  const hasOwnBg = new WeakMap<Element, boolean>();
  const paintsBg = (el: Element): boolean => {
    const cached = hasOwnBg.get(el);
    if (cached !== undefined) return cached;
    const cs = win.getComputedStyle(el);
    let bg = parseRgb(cs.backgroundColor);
    if (bg && bg[3] > 0.05 && luminance(bg) > 0.93 && cs.backgroundImage === "none") {
      // White/near-white is the author's "paper", not a design choice: drop it onto the theme.
      (el as HTMLElement).style.setProperty("background-color", "transparent", "important");
      bg = null;
    }
    const own = (bg !== null && bg[3] > 0.05) || cs.backgroundImage !== "none";
    // The frame's own body/html surface doesn't count: that's the app theme, not the author's design.
    const parent = el.parentElement;
    const result = own || (parent && parent !== doc.body && parent !== doc.documentElement ? paintsBg(parent) : false);
    hasOwnBg.set(el, result);
    return result;
  };
  for (const el of doc.body.querySelectorAll<HTMLElement>("*")) {
    if (el.childNodes.length === 0) continue;
    const cs = win.getComputedStyle(el);
    const rgb = parseRgb(cs.color);
    if (!rgb || luminance(rgb) > 0.35) continue;
    if (paintsBg(el)) continue;
    el.style.setProperty("color", lighten(rgb, pal.text), "important");
  }
  // Outlook/Word forward rules are drawn in currentColor; make sure they stay visible too.
  for (const hr of doc.body.querySelectorAll<HTMLElement>("hr")) {
    if (!paintsBg(hr)) hr.style.setProperty("border-color", "rgba(148,163,184,0.35)", "important");
  }
}

function buildSrcdoc(html: string, pal: FramePalette): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="color-scheme" content="${pal.dark ? "dark" : "light"}"><style>
html,body{margin:0;padding:0;background:${pal.bg};color:${pal.text};}
body{display:flow-root;padding:20px 22px;font:14.5px/1.65 "IBM Plex Sans",-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;word-break:break-word;overflow-wrap:anywhere;}
img{max-width:100%;height:auto;}
a{color:${pal.link};}
pre{white-space:pre-wrap;}
table{max-width:100%;}
body.hide-quotes:not(.is-forward) .gmail_quote,body.hide-quotes:not(.is-forward) blockquote[type="cite"],body.hide-quotes:not(.is-forward) .yahoo_quoted,body.hide-quotes:not(.is-forward) #divRplyFwdMsg,body.hide-quotes:not(.is-forward) #divRplyFwdMsg ~ *,body.hide-quotes:not(.is-forward) .moz-cite-prefix,body.hide-quotes:not(.is-forward) .moz-cite-prefix ~ blockquote,body.hide-quotes:not(.is-forward) .protonmail_quote{display:none!important;}
body.hide-sig .gmail_signature,body.hide-sig [data-smartmail="gmail_signature"]{display:none!important;}
body.hide-quotes .sm-cut,body.hide-quotes .sm-cut-after{display:none!important;}
</style></head><body class="hide-quotes">${sanitizeHtml(html)}</body></html>`;
}

interface FrameMeta {
  hasQuotes: boolean;
  hasSignature: boolean;
  /** Remote URLs found in the rendered document, exactly as they appear in the HTML. */
  remoteUrls: string[];
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

/**
 * Every way a user gesture can navigate the frame goes through the app instead. Clicks on
 * links are routed to `onLink` (which opens them in the system browser after the risk
 * check); link drags, drops, middle-clicks and the native "Open Link" context menu item
 * are cancelled outright - each of those would otherwise load the URL *into* the frame,
 * bypassing the click handler and the "no network from mail" guarantee. Attached before
 * any other work on the document so a later exception can't leave the frame unguarded.
 */
function guardFrame(doc: Document, onLink: (url: string) => void) {
  const linkOf = (e: Event) => (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  doc.addEventListener("click", (e) => {
    const a = linkOf(e);
    if (!a) return;
    e.preventDefault();
    const href = (a.getAttribute("href") ?? "").trim();
    if (/^(https?:|mailto:)/i.test(href)) onLink(href);
  });
  doc.addEventListener("auxclick", (e) => {
    if (linkOf(e)) e.preventDefault();
  });
  doc.addEventListener("contextmenu", (e) => {
    if (linkOf(e)) e.preventDefault();
  });
  doc.addEventListener("dragstart", (e) => e.preventDefault());
  doc.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  doc.addEventListener("drop", (e) => e.preventDefault());
}

function HtmlFrame({
  html,
  subject,
  palette,
  hideQuotes,
  hideSignature,
  onLink,
  onMeta,
}: {
  html: string;
  subject: string;
  palette: FramePalette;
  hideQuotes: boolean;
  hideSignature: boolean;
  onLink: (url: string) => void;
  onMeta: (meta: FrameMeta) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const srcdoc = useMemo(() => buildSrcdoc(html, palette), [html, palette]);

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
  const observerRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  // Remount counter: bumped when the frame has navigated away from its srcdoc (see handleLoad).
  const [frameKey, setFrameKey] = useState(0);
  const remountsRef = useRef(0);
  useEffect(() => {
    remountsRef.current = 0;
  }, [html]);

  const handleLoad = () => {
    let doc: Document | null = null;
    try {
      doc = ref.current?.contentDocument ?? null;
    } catch {
      doc = null; // cross-origin: the frame is showing a remote page
    }
    // `sandbox` has no flag that stops a frame navigating itself: a dropped link or the
    // native context menu's "Open Link" would replace the mail with a live remote page
    // (and make a network request). If the document is no longer our srcdoc, throw the
    // frame away and render the mail again.
    if (!doc || !/^about:/i.test(doc.URL)) {
      if (remountsRef.current < 3) {
        remountsRef.current += 1;
        setFrameKey((k) => k + 1);
      }
      return;
    }
    if (!doc.body || doc.URL !== "about:srcdoc") return; // initial about:blank; wait for srcdoc
    guardFrame(doc, (url) => onLinkRef.current(url));
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
    if (palette.dark) adaptDarkText(doc, palette);
    measure();
    onMeta({
      hasQuotes: hasHistory,
      hasSignature: !!doc.querySelector(SIGNATURE_SELECTOR),
      remoteUrls: collectRemoteUrls(doc),
    });
    // measure() above runs before any image has decoded. Nothing used to load, so nobody
    // noticed; the moment data: images render, a long email would clip. Watch the document and
    // re-measure as content settles.
    const view = doc.defaultView;
    if (view?.ResizeObserver) {
      observerRef.current?.disconnect();
      const ro = new view.ResizeObserver(() => measure());
      ro.observe(doc.documentElement);
      observerRef.current = ro;
    }
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
      key={frameKey}
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

export function MessageBody({ email, risk, compact = false, onOpenLink, onPreviewAttachment }: MessageBodyProps) {
  const hasHtml = !!email.body_html && email.body_html.trim().length > 0;
  const linksDisabled = risk === "danger";
  const [mode, setMode] = useState<"html" | "text">(hasHtml ? "html" : "text");
  const [quotedOpen, setQuotedOpen] = useState(false);
  // Signatures are part of the message (Gmail shows them too); the toggle lets you hide one.
  const [signatureOpen, setSignatureOpen] = useState(true);
  const [meta, setMeta] = useState<FrameMeta>({ hasQuotes: false, hasSignature: false, remoteUrls: [] });
  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);
  const [inlineImgs, setInlineImgs] = useState<InlineImageDto[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const appPalette = usePalette();
  const designed = useMemo(() => hasHtml && paintsOwnCanvas(email.body_html ?? ""), [hasHtml, email.body_html]);
  // Designed mail defaults to a light card; the user can flip either way per message.
  const [lightCard, setLightCard] = useState<boolean | null>(null);
  const useLight = lightCard ?? designed;
  const palette = appPalette.dark && useLight ? LIGHT_PALETTE : appPalette;
  const [skippedInline, setSkippedInline] = useState<SkippedInlineImageDto[]>([]);
  // Remote images are never loaded until the user asks. Gated on this state rather than on
  // meta.remoteUrls, because rewriting the HTML reloads the frame and reports no URLs at all.
  const [imagesState, setImagesState] = useState<"blocked" | "loading" | "shown" | "failed">("blocked");
  const [remoteImgs, setRemoteImgs] = useState<RemoteImageDto[]>([]);
  /**
   * The remote URLs found in the message, held separately from `meta`. Substituting the images
   * rewrites the srcdoc, which reloads the frame; that second pass sees only data: URIs and
   * reports no remote URLs at all. Reading the list off `meta` would therefore make "Show
   * pictures" a one-shot and leave "Try again" fetching nothing.
   */
  const [discoveredUrls, setDiscoveredUrls] = useState<string[]>([]);

  useEffect(() => {
    setLightCard(null);
    setMode(hasHtml ? "html" : "text");
    setQuotedOpen(false);
    setSignatureOpen(true);
    setMeta({ hasQuotes: false, hasSignature: false, remoteUrls: [] });
    setPendingLink(null);
    setLinkError(null);
    setAttachments([]);
    setInlineImgs([]);
    setSkippedInline([]);
    setAttachError(null);
    setImagesState("blocked");
    setRemoteImgs([]);
    setDiscoveredUrls([]);
    let cancelled = false;
    api
      .listAttachments(email.id)
      .then((list) => {
        if (cancelled) return;
        setAttachments(list);
        // Inline images are part of the message itself (fetched from Gmail, not a remote host).
        if (list.some((a) => a.content_id && a.mime_type.startsWith("image/")) && /cid:/i.test(email.body_html ?? "")) {
          api
            .inlineImages(email.id)
            .then((res) => {
              if (cancelled) return;
              setInlineImgs(res.images);
              setSkippedInline(res.skipped);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email.id, hasHtml, email.body_html]);

  const htmlWithImages = useMemo(
    () => inlineRemoteImages(inlineCidImages(email.body_html ?? "", inlineImgs), remoteImgs),
    [email.body_html, inlineImgs, remoteImgs],
  );
  /** Fetches `urls`, merging over anything already loaded so a retry never drops a success. */
  const loadImages = async (urls: string[]) => {
    if (linksDisabled || !urls.length) return;
    setImagesState("loading");
    try {
      const fetched = await api.fetchRemoteImages(email.id, urls);
      const merged = new Map(remoteImgs.map((i) => [i.url, i]));
      for (const img of fetched) merged.set(img.url, img);
      const next = [...merged.values()];
      setRemoteImgs(next);
      setImagesState(next.some((i) => i.data_base64) ? "shown" : "failed");
    } catch {
      setImagesState("failed");
    }
  };
  const failedImages = remoteImgs.filter((i) => !i.data_base64);
  const handleMeta = (m: FrameMeta) => {
    setMeta(m);
    // Only ever grow the set: the post-substitution reload legitimately reports none.
    if (m.remoteUrls.length) setDiscoveredUrls(m.remoteUrls);
  };
  const refs = useMemo(() => referencedCids(email.body_html ?? ""), [email.body_html]);
  const shownCids = new Set(inlineImgs.map((i) => i.content_id));
  // An inline image only earns its place in the body. If the HTML never references it, or it
  // was too large to inline, or we are in plain-text view, it must still be reachable as a chip
  // - otherwise it is invisible and un-openable, which is what the old filter did.
  const files = attachments.filter((a) => {
    if (!a.is_inline || !a.mime_type.startsWith("image/") || !a.content_id) return true;
    if (mode === "text") return true;
    if (!refs.has(a.content_id)) return true;
    return !shownCids.has(a.content_id);
  });
  const openAttachment = async (a: AttachmentDto) => {
    // The in-app preview renders in a script-less worker, which is strictly safer than handing
    // the file to the OS - so it stays available even on mail triaged as danger.
    if (onPreviewAttachment) {
      onPreviewAttachment(a);
      return;
    }
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
          <button type="button" className="toolbar-btn" onClick={() => setMode((m) => (m === "html" ? "text" : "html"))}>
            {mode === "html" ? "View plain text" : "View formatted"}
          </button>
        )}
        {hasHtml && mode === "html" && appPalette.dark && (
          <button
            type="button"
            className="toolbar-btn"
            title={useLight ? "Render this message on the app's dark surface" : "Render this message on a light card"}
            onClick={() => setLightCard(!useLight)}
          >
            {useLight ? "Match dark theme" : "Light background"}
          </button>
        )}
        {showQuoteToggle && (
          <button type="button" className="toolbar-btn" aria-expanded={quotedOpen} onClick={() => setQuotedOpen((o) => !o)}>
            {quotedOpen ? "Hide" : "Show"} quoted history
            {mode === "text" && quoted ? ` · ${quoted.split("\n").length} lines` : ""}
          </button>
        )}
        {showSignatureToggle && (
          <button type="button" className="toolbar-btn" aria-expanded={signatureOpen} onClick={() => setSignatureOpen((o) => !o)}>
            {signatureOpen ? "Hide" : "Show"} signature
          </button>
        )}
        <span className="toolbar-notes">
          {mode === "html" && imagesState === "shown" && (
            <span className="toolbar-note" title="Fetched by the app, not by this message">
              Pictures shown
            </span>
          )}
          {linksDisabled && <span className="toolbar-note is-danger">Links disabled</span>}
        </span>
      </div>

      {pendingLink && (
        <div className="link-confirm sm-fade" role="dialog" aria-label="Open link">
          <span className="link-confirm-label">Open in browser?</span>
          <span className="link-url">{pendingLink}</span>
          <button type="button" className="btn btn-mini" onClick={() => open(pendingLink)}>
            Open
          </button>
          <button type="button" className="btn btn-mini" onClick={() => setPendingLink(null)}>
            Cancel
          </button>
        </div>
      )}
      {linkError && <p className="inline-error">{linkError}</p>}

      {mode === "html" && hasHtml && discoveredUrls.length > 0 && imagesState !== "shown" && (
        <div className="images-banner sm-fade" aria-busy={imagesState === "loading"}>
          {linksDisabled ? (
            <>
              <p className="images-banner-title">Pictures are not shown for this email.</p>
              <p className="images-banner-note">It looks like a scam, so we are not asking the sender's server for anything.</p>
            </>
          ) : (
            <>
              <p className="images-banner-title">This email has pictures stored on the internet.</p>
              <p className="images-banner-note">If you show them, the sender can tell that you opened this email.</p>
              <button type="button" className="btn images-banner-btn" disabled={imagesState === "loading"} onClick={() => void loadImages(discoveredUrls)}>
                {imagesState === "loading" ? "Getting pictures…" : imagesState === "failed" ? "Try again" : "Show pictures"}
              </button>
            </>
          )}
        </div>
      )}
      {imagesState === "shown" && failedImages.length > 0 && (
        <p className="images-note sm-fade">
          {failedImages.length} of {remoteImgs.length} pictures could not be shown.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => void loadImages(failedImages.map((i) => i.url))}
            title={failedImages.map((i) => i.error).join(" · ")}
          >
            Try again
          </button>
        </p>
      )}

      {mode === "html" && hasHtml ? (
        <div className={`html-card ${palette.dark ? "html-card-dark" : "html-card-light"}`}>
          <HtmlFrame
            html={htmlWithImages}
            subject={email.subject}
            palette={palette}
            hideQuotes={!quotedOpen}
            hideSignature={!signatureOpen}
            onLink={requestLink}
            onMeta={handleMeta}
          />
        </div>
      ) : (
        <div className={compact ? undefined : "html-card text-card"}>
          <PlainText
            text={newest}
            quoted={quoted}
            quotedOpen={quotedOpen}
            signatureOpen={signatureOpen}
            onLink={requestLink}
            linksDisabled={linksDisabled}
          />
        </div>
      )}

      {files.length > 0 && (
        <div className="attachments">
          <span className="attachments-label">
            {files.length} {files.length === 1 ? "attachment" : "attachments"}
            {linksDisabled && !onPreviewAttachment ? " · opening disabled for this email" : ""}
          </span>
          {skippedInline.length > 0 && (
            <p className="images-note">
              {skippedInline.length === 1
                ? `One picture in this email was ${skippedInline[0].reason}. You can open it below.`
                : `${skippedInline.length} pictures in this email could not be shown in the message. You can open them below.`}
            </p>
          )}
          <div className="attachment-chips">
            {files.map((a) => (
              <button
                key={a.id}
                type="button"
                className="attachment-chip"
                disabled={(linksDisabled && !onPreviewAttachment) || opening !== null}
                title={`${a.filename} — ${formatSize(a.size)}`}
                onClick={() => void openAttachment(a)}
              >
                <span className="attachment-name">{a.filename}</span>
                <span className="attachment-size">{opening === a.attachment_id ? "Opening…" : formatSize(a.size)}</span>
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
