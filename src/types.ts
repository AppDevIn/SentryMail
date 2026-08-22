export interface AccountDto {
  id: number;
  email_address: string;
  provider: string;
  last_history_id: string | null;
}

export interface EmailDto {
  id: number;
  account_id: number;
  sender: string;
  /** Raw To / Cc header values; empty strings when not recorded. */
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  body_text: string;
  /** HTML part of the message when present; rendered in a locked-down sandbox. */
  body_html: string | null;
  gmail_thread_id: string;
  /** Messages in this conversation; list rows are one per thread (latest message shown). */
  thread_count: number;
  thread_unread: number;
  /** Gmail label ids on this message (INBOX, UNREAD, Label_12, ...). */
  label_ids: string[];
  received_at: string;
  is_read: boolean;
}

export interface SyncSummary {
  accounts_synced: number;
  new_emails: number;
  errors: string[];
}

export type TriageType =
  | "action_needed"
  | "fyi"
  | "scam_risk"
  | "personal"
  | "newsletter_promo";

export type Priority = "high" | "medium" | "low";
export type Risk = "safe" | "caution" | "danger";
export type TriageStatus = "ok" | "parse_error";

export interface TriageResult {
  email_id: number;
  type: TriageType;
  priority: Priority;
  summary: string;
  risk: Risk;
  signals_json: string;
  risk_explanation: string;
  draft_reply: string | null;
  next_step_warning: string | null;
  triage_status: TriageStatus;
  model_version: string;
  /** Your own verdict overriding the model's `risk`; null = go with the model. */
  user_risk: Risk | null;
  /** You marked this email handled. */
  done: boolean;
}

export type ModelStatus =
  | { state: "not_configured" }
  | { state: "not_loaded" }
  | { state: "loading"; progress_pct: number | null }
  | { state: "ready"; context_size: number }
  | { state: "failed"; message: string };

export interface TriageProgressEvent {
  email_id: number;
  done: number;
  total: number;
  result: TriageResult | null;
  error: string | null;
}

export type UnsubscribeMethod =
  | { kind: "one_click_post"; url: string }
  | { kind: "browser"; url: string }
  | { kind: "mailto"; to: string; subject: string | null; body: string | null }
  | { kind: "unavailable" };

export interface UnsubscribeInfo {
  method: UnsubscribeMethod;
  unsubscribed_at: string | null;
}

/** Which ranking sources found a search hit (ADR 0003/0006). */
export type SearchMatchSource = "keyword" | "semantic";

/** One specific message that matched a search, with its thread context (ADR 0007). */
export interface SearchResultDto {
  email_id: number;
  account_id: number;
  gmail_thread_id: string;
  /** Messages in this conversation; shown as an "n in thread" tag when > 1. */
  thread_count: number;
  sender: string;
  subject: string;
  /**
   * Plain-text snippet. Keyword-matched terms are wrapped in U+E000 (start) / U+E001 (end)
   * marker characters; the UI turns those into <mark> spans. Semantic-only hits carry no markers.
   */
  snippet: string;
  received_at: string;
  /** Fused RRF score; only meaningful relative to other rows of the same response. */
  score: number;
  matched: SearchMatchSource[];
}

export interface EmbedProgressEvent {
  email_id: number;
  done: number;
  total: number;
  error: string | null;
}

export type Folder = "inbox" | "quarantine";
export type ListFilter = "all" | "unread" | "needs_action" | "flagged";
/** List ordering: newest first (backend order) or by triage priority, newest within each tier. */
export type ListSort = "newest" | "priority";

export interface EmailCounts {
  total: number;
  unread: number;
}

export interface SetReadResult {
  synced_to_gmail: boolean;
  warning: string | null;
}

export interface LabelDto {
  id: number;
  account_id: number;
  gmail_label_id: string;
  name: string;
  label_type: string;
  color_bg: string | null;
  color_fg: string | null;
  /** Your local description of what belongs under this label (what the model reads). */
  description: string | null;
  auto_apply: boolean;
}

export interface LabelSuggestion {
  gmail_label_id: string;
  name: string;
}

export interface ApplyLabelsResult {
  label_ids: string[];
  warning: string | null;
}

export interface AttachmentDto {
  id: number;
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  is_inline: boolean;
}

export interface InlineImageDto {
  content_id: string;
  mime_type: string;
  data_base64: string;
}

export interface SyncProgressEvent {
  account: string;
  /** "listing" | "fetching" | "history" | "done" */
  phase: string;
  done: number;
  total: number | null;
}
