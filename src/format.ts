import type { Priority, Risk, TriageType } from "./types";

/** Mirrors `triage::MODEL_VERSION` in src-tauri; older results are flagged as outdated. */
export const CURRENT_TRIAGE_VERSION = "gemma-triage-v2";

export const TYPE_LABELS: Record<TriageType, string> = {
  action_needed: "Action needed",
  fyi: "FYI",
  scam_risk: "Scam risk",
  personal: "Personal",
  newsletter_promo: "Newsletter / promo",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const RISK_LABELS: Record<Risk, string> = {
  safe: "Safe",
  caution: "Caution",
  danger: "Danger",
};

/** Short mono note shown next to the risk pill in list rows (DANGER / CAUTION only). */
export const RISK_NOTES: Record<Risk, string | null> = {
  safe: null,
  caution: "VERIFY BEFORE ACTING",
  danger: "DO NOT REPLY",
};

/**
 * The fixed set of scam/fraud signals the on-device model can report
 * (see src-tauri/src/llm/triage_grammar.gbnf), each with a plain-language
 * description for non-technical readers.
 */
export const SIGNAL_INFO: Record<string, { label: string; description: string }> = {
  urgency_pressure: {
    label: "Urgency pressure",
    description: "Pushes you to act right now, before you have time to think or check.",
  },
  money_request: {
    label: "Money request",
    description: "Asks for a payment, transfer, gift cards, or crypto.",
  },
  credential_request: {
    label: "Credential request",
    description: "Asks for a password, one-time code, bank details, or remote access.",
  },
  sender_mismatch: {
    label: "Sender mismatch",
    description: "The display name doesn't match the real address, or the domain looks like a copycat.",
  },
  suspicious_links: {
    label: "Suspicious links",
    description: "Contains unexpected, shortened, or disguised links or attachments.",
  },
  emotional_manipulation: {
    label: "Emotional manipulation",
    description: "Leans on fear, a prize, a family emergency, or claimed authority to pressure you.",
  },
  secrecy_request: {
    label: "Secrecy request",
    description: "Asks you to keep this private or not tell anyone.",
  },
  inconsistent_formatting: {
    label: "Inconsistent formatting",
    description: "Grammar, tone, or layout doesn't fit who the sender claims to be.",
  },
};

/** The verdict that drives the UI: the user's override when set, otherwise the model's. */
export function effectiveRisk(triage: { risk: Risk; user_risk: Risk | null } | null | undefined): Risk | null {
  if (!triage) return null;
  return triage.user_risk ?? triage.risk;
}

export function parseSignals(signalsJson: string): string[] {
  try {
    const parsed = JSON.parse(signalsJson);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function signalLabel(signal: string): string {
  const raw = signal.replace(/_/g, " ");
  return SIGNAL_INFO[signal]?.label ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Splits a raw RFC 5322 sender ("Name <addr>", "addr", "'Name' via List <addr>") into parts. */
export function parseSender(raw: string): { name: string; address: string | null } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    // Strip a quoted display name: 'Greg Thom' via Group -> Greg Thom via Group
    const name = match[1].trim().replace(/^'([^']*)'\s*/, "$1 ").replace(/^"([^"]*)"\s*/, "$1 ").trim();
    return { name: name || match[2].trim(), address: match[2].trim() };
  }
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return { name: trimmed, address: trimmed };
  return { name: trimmed || "(unknown sender)", address: null };
}

/** Gmail-style relative time for list rows: 09:12 · Yesterday · Mon · 21 Aug · 21 Aug 2025. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diffDays <= 0) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Full timestamp for the reading view header. */
export function formatFullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} MS`;
  return `${(ms / 1000).toFixed(1)} S`;
}

/** Splits a comma-separated address header into display parts. */
export function parseAddressList(header: string): { name: string; address: string | null }[] {
  if (!header.trim()) return [];
  // Split on commas that are not inside quotes or angle brackets.
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "<") depth++;
    if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean).map(parseSender);
}

export type Addressing = "to" | "cc" | "none" | "unknown";

/** How the user relates to an email's recipients. */
export function addressingFor(email: { to_addrs: string; cc_addrs: string }, userEmail: string | null): Addressing {
  if (!userEmail) return "unknown";
  const u = userEmail.trim().toLowerCase();
  if (email.to_addrs.toLowerCase().includes(u)) return "to";
  if (email.cc_addrs.toLowerCase().includes(u)) return "cc";
  if (!email.to_addrs.trim() && !email.cc_addrs.trim()) return "unknown";
  return "none";
}

/**
 * Splits a plain-text body into the newest message and the quoted history below it
 * (mirrors `strip_quoted_history` in src-tauri/src/triage/prompt.rs).
 */
export function splitQuotedHistory(body: string): { newest: string; quoted: string | null } {
  const lines = body.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(">")) {
      cut = i;
      break;
    }
    // Forwarded content is the message itself, not history: skip the forward divider and
    // keep scanning - reply history *below* the forwarded message is still trimmed.
    if (/^-{3,}\s*Forwarded message\s*-{3,}$/i.test(t) || /^Begin forwarded message:?$/i.test(t) || /^-+\s*Forwarded message/i.test(t)) {
      continue;
    }
    if (t.startsWith("-----Original Message")) {
      cut = i;
      break;
    }
    const onWrote =
      (t.startsWith("On ") || t.startsWith("Le ") || t.startsWith("Am ")) &&
      (t.includes(",") || t.includes(" at ") || t.includes(" um ")) &&
      (t.endsWith("wrote:") ||
        t.endsWith("écrit :") ||
        t.endsWith("schrieb:") ||
        lines.slice(i + 1, i + 3).some((l) => l.trim().endsWith("wrote:")));
    if (onWrote) {
      cut = i;
      break;
    }
    const fromLine = t.startsWith("From:") || t.startsWith("*From:*");
    if (
      fromLine &&
      lines.slice(i + 1, i + 6).some((l) => {
        const x = l.trim().replace(/^\*+/, "");
        return x.startsWith("Sent:") || x.startsWith("To:") || x.startsWith("Subject:") || x.startsWith("Date:");
      })
    ) {
      // An Outlook header block is a reply quote only when its Subject is a RE:; a block whose
      // subject isn't a reply (or has no subject) is a forward - keep it as message content.
      const subjectLine = lines.slice(i + 1, i + 8).map((l) => l.trim().replace(/^\*+/, "")).find((l) => /^Subject:/i.test(l));
      const isReplyBlock = !!subjectLine && /^Subject:\*?\s*(re|aw|sv|antw)\s*:/i.test(subjectLine);
      if (!isReplyBlock) {
        i += 1; // skip past the forward header; keep scanning the forwarded body
        continue;
      }
      cut = i;
      break;
    }
  }
  if (cut < 0) return { newest: body, quoted: null };
  let head = lines.slice(0, cut).join("\n").trimEnd();
  if (head.endsWith("--")) head = head.replace(/-+\s*$/, "").trimEnd();
  if (!head.trim()) return { newest: body, quoted: null };
  return { newest: head, quoted: lines.slice(cut).join("\n").trim() };
}

export interface ThreadMessage {
  sender: string;
  address: string | null;
  date: string | null;
  text: string;
}

/** Strips leading ">" quote markers (any depth) from a line. */
function unquote(line: string): string {
  return line.replace(/^(\s*>)+\s?/, "");
}

/** Parses a Gmail / Apple Mail attribution line into its parts. */
function parseOnWrote(header: string): { sender: string; address: string | null; date: string | null } | null {
  const m = header.match(/^On\s+(.+?)\s*wrote:\s*$/i) ?? header.match(/^Le\s+(.+?)\s*a écrit\s*:\s*$/i) ?? header.match(/^Am\s+(.+?)\s*schrieb:\s*$/i);
  if (!m) return null;
  const inner = m[1].trim();
  const addrMatch = inner.match(/<([^>]+)>\s*$/);
  const address = addrMatch ? addrMatch[1].trim() : null;
  const pre = (addrMatch ? inner.slice(0, addrMatch.index) : inner).trim().replace(/,\s*$/, "");
  // The name is whatever follows the last time-of-day token ("1:07 PM", "06:07,"); failing
  // that, whatever follows the last comma.
  const timeSplit = pre.match(/^(.*?\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*,?\s+(.+)$/i);
  let date: string | null;
  let sender: string;
  if (timeSplit) {
    date = timeSplit[1].trim();
    sender = timeSplit[2].trim();
  } else {
    const comma = pre.lastIndexOf(",");
    date = comma >= 0 ? pre.slice(0, comma).trim() : null;
    sender = (comma >= 0 ? pre.slice(comma + 1) : pre).trim();
  }
  sender = sender
    .replace(/\s+via\s+.+$/i, "")
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
  if (!sender) sender = address ?? "(unknown)";
  return { sender, address, date };
}

/**
 * Splits the quoted history of a plain-text reply chain into individual earlier messages,
 * oldest first. Works header-by-header ("On … wrote:", Outlook "From:/Sent:" blocks,
 * forwarded-message dividers), ignoring quote depth - deep Gmail chains wrap and re-indent
 * too inconsistently for depth to be reliable. Returns [] when nothing recognizable is found.
 */
export function parseThread(quoted: string): ThreadMessage[] {
  const rawLines = quoted.split(/\r?\n/).map(unquote);
  const messages: ThreadMessage[] = [];
  let current: ThreadMessage | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      // Drop a trailing signature separator and surrounding blank lines.
      while (buffer.length && !buffer[buffer.length - 1].trim()) buffer.pop();
      if (buffer.length && /^--\s*$/.test(buffer[buffer.length - 1])) buffer.pop();
      while (buffer.length && !buffer[0].trim()) buffer.shift();
      current.text = buffer.join("\n").trim();
      if (current.text || current.date) messages.push(current);
    }
    current = null;
    buffer = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t) {
      buffer.push("");
      continue;
    }

    // "On … wrote:" possibly wrapped onto the next line or two.
    if (/^(On|Le|Am)\s/.test(t) && (t.includes(",") || t.includes(" at ") || t.includes(" um "))) {
      let header = t;
      let consumed = 0;
      while (!/(wrote|schrieb):\s*$|a écrit\s*:\s*$/.test(header) && consumed < 2 && i + consumed + 1 < rawLines.length) {
        consumed++;
        header += " " + rawLines[i + consumed].trim();
      }
      const parsed = parseOnWrote(header);
      if (parsed) {
        flush();
        current = { ...parsed, text: "" };
        i += consumed;
        continue;
      }
    }

    // Outlook / forwarded-message header blocks.
    const isDivider = /^-+\s*(Original Message|Forwarded message)\s*-+$/i.test(t);
    const isFrom = /^\*?From:\*?\s/i.test(t);
    if (isDivider || isFrom) {
      const look = rawLines.slice(i, i + 8);
      const fromLine = look.find((l) => /^\*?From:\*?\s/i.test(l.trim()));
      const dateLine = look.find((l) => /^\*?(Sent|Date):\*?\s/i.test(l.trim()));
      if (fromLine && (isDivider || look.some((l) => /^\*?(Sent|Date|To|Subject):\*?\s/i.test(l.trim())))) {
        flush();
        const from = fromLine.trim().replace(/^\*?From:\*?\s*/i, "");
        const parsedFrom = parseSender(from);
        current = {
          sender: parsedFrom.name,
          address: parsedFrom.address,
          date: dateLine ? dateLine.trim().replace(/^\*?(Sent|Date):\*?\s*/i, "") : null,
          text: "",
        };
        // Skip the header block: From/Sent/To/Cc/Subject lines up to the first blank line.
        let j = i;
        while (j < rawLines.length && rawLines[j].trim() && (j === i || /^\*?(From|Sent|Date|To|Cc|Subject):\*?\s/i.test(rawLines[j].trim()) || /^-+/.test(rawLines[j].trim()))) j++;
        i = j - 1;
        continue;
      }
    }

    if (current) buffer.push(rawLines[i]);
    // Lines before any recognizable header (e.g. stray wrapped fragments) are ignored.
  }
  flush();
  return messages.reverse(); // quoted chains are newest-first; present oldest-first
}

const GREETING_RE = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b[^.!?\n]{0,40}[,!:]?\s*$/i;

/** First substantive content of a message (skips greetings/image placeholders), for previews. */
export function previewLine(text: string, max = 150): string {
  const all = text.split("\n").map((l) => l.trim());
  // Stop at a forward/quote divider or header block so previews show the person's own words.
  const stop = all.findIndex((l) => /^[_\-=]{5,}$/.test(l) || /^(\*?From:|On .+wrote:$|-{3,}\s*(Original|Forwarded))/i.test(l));
  const lines = (stop >= 0 ? all.slice(0, stop) : all).filter((l) => l && !/^\[image:/i.test(l) && !GREETING_RE.test(l));
  const joined = lines.slice(0, 3).join(" ").replace(/\s+/g, " ");
  // Stop at the end of the first sentence once we have a reasonable amount of text.
  const sentenceEnd = joined.search(/(?<=[.!?])\s/);
  const candidate = sentenceEnd > 40 ? joined.slice(0, sentenceEnd) : joined;
  return candidate.length > max ? `${candidate.slice(0, max - 1)}…` : candidate;
}

/** Undoes common link-rewriting wrappers (Proofpoint urldefense, Outlook safelinks) for display/opening. */
export function cleanUrl(url: string): string {
  const ud = url.match(/^https?:\/\/urldefense\.com\/v3\/__(.+?)__;/i);
  if (ud) return ud[1].replace(/\*/g, "%");
  const sl = url.match(/^https?:\/\/[^/]*safelinks\.protection\.outlook\.com\/.*?[?&]url=([^&]+)/i);
  if (sl) {
    try {
      return decodeURIComponent(sl[1]);
    } catch {
      return url;
    }
  }
  return url;
}

/** Short, readable label for a link: host + trimmed path, no scheme. */
export function linkLabel(url: string, max = 64): string {
  const clean = cleanUrl(url).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

