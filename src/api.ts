import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AccountDto,
  ApiFolder,
  ApplyLabelsResult,
  ArchiveResult,
  FolderCounts,
  AttachmentDto,
  LabelDto,
  LabelSuggestion,
  MeetingDto,
  EmailCounts,
  EmailDto,
  InlineImageDto,
  SetReadResult,
  ModelStatus,
  SearchResultDto,
  SyncSummary,
  TriageResult,
  UnsubscribeInfo,
} from "./types";

export const api = {
  addAccount: () => invoke<AccountDto>("add_account"),
  listAccounts: () => invoke<AccountDto[]>("list_accounts"),
  /** Removes an inbox from this device (local data + keychain token + Google grant). */
  removeAccount: (accountId: number) => invoke<void>("remove_account", { accountId }),
  listEmails: (accountId?: number, limit?: number, offset?: number, labelId?: string | null, folder?: ApiFolder) =>
    invoke<EmailDto[]>("list_emails", {
      accountId: accountId ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
      labelId: labelId ?? null,
      folder: folder ?? null,
    }),
  emailCounts: (accountId?: number, labelId?: string | null, folder?: ApiFolder) =>
    invoke<EmailCounts>("email_counts", { accountId: accountId ?? null, labelId: labelId ?? null, folder: folder ?? null }),
  /** Sidebar counts for every folder in one call (ADR 0013). */
  folderCounts: (accountId?: number) => invoke<FolderCounts>("folder_counts", { accountId: accountId ?? null }),
  /** Archive (or restore) the whole conversation `emailId` belongs to (ADR 0010). */
  archiveThread: (emailId: number, archived: boolean) =>
    invoke<ArchiveResult>("archive_thread", { emailId, archived }),
  /** Compose and send a new message from `accountId` (ADR 0010). */
  sendMessage: (accountId: number, to: string, cc: string | null, subject: string, body: string) =>
    invoke<void>("send_message", { accountId, to, cc, subject, body }),
  listLabels: (accountId?: number) => invoke<LabelDto[]>("list_labels", { accountId: accountId ?? null }),
  setLabelSettings: (labelId: number, description: string | null, autoApply: boolean) =>
    invoke<LabelDto>("set_label_settings", { labelId, description, autoApply }),
  suggestLabels: (emailId: number) => invoke<LabelSuggestion[]>("suggest_labels", { emailId }),
  applyLabels: (emailId: number, add: string[], remove: string[]) =>
    invoke<ApplyLabelsResult>("apply_labels", { emailId, add, remove }),
  setRead: (emailId: number, isRead: boolean) =>
    invoke<SetReadResult>("set_read", { emailId, isRead }),
  getEmail: (emailId: number) => invoke<EmailDto | null>("get_email", { emailId }),
  /** All stored messages in the same conversation, newest first. */
  listThreadMessages: (emailId: number) => invoke<EmailDto[]>("list_thread_messages", { emailId }),
  syncNow: (accountId?: number) =>
    invoke<SyncSummary>("sync_now", { accountId: accountId ?? null }),
  modelStatus: () => invoke<ModelStatus>("model_status"),
  loadModel: () => invoke<void>("load_model"),
  triageEmail: (emailId: number) =>
    invoke<TriageResult>("triage_email", { emailId }),
  /** One-line summary of an earlier thread message; cache-only unless allowGenerate. */
  summarizeMessage: (sender: string, text: string, allowGenerate: boolean) =>
    invoke<string | null>("summarize_message", { sender, text, allowGenerate }),
  /** On-demand reply draft from the local model (for emails triage didn't draft for). */
  draftReply: (emailId: number, instructions?: string, previousDraft?: string) =>
    invoke<string>("draft_reply", {
      emailId,
      instructions: instructions?.trim() ? instructions.trim() : null,
      previousDraft: previousDraft?.trim() ? previousDraft : null,
    }),
  /** Opens an http(s)/mailto URL in the user's default browser or mail app. */
  openExternal: (url: string) => openUrl(url),
  triageAllUntriaged: (accountId?: number) =>
    invoke<number>("triage_all_untriaged", { accountId: accountId ?? null }),
  /** Mark an analyzed email handled (or reopen it). */
  setDone: (emailId: number, done: boolean) => invoke<void>("set_done", { emailId, done }),
  /** Set (or clear with null) your own verdict for an analyzed email. */
  setUserRisk: (emailId: number, risk: "safe" | "caution" | "danger" | null) =>
    invoke<TriageResult>("set_user_risk", { emailId, risk }),
  getTriageResult: (emailId: number) =>
    invoke<TriageResult | null>("get_triage_result", { emailId }),
  /** Creates a reply draft in Gmail; with `send` it is sent at once (ADR 0010). */
  createGmailDraft: (emailId: number, bodyOverride?: string, replyAll?: boolean, send?: boolean) =>
    invoke<string>("create_gmail_draft", {
      emailId,
      bodyOverride: bodyOverride ?? null,
      replyAll: replyAll ?? false,
      send: send ?? false,
    }),
  listAttachments: (emailId: number) => invoke<AttachmentDto[]>("list_attachments", { emailId }),
  /** Downloads the attachment to the app cache and opens it with the default app. */
  openAttachment: (emailId: number, attachmentId: string) =>
    invoke<string>("open_attachment", { emailId, attachmentId }),
  /** Inline (cid:) images as data URIs for the sandboxed HTML view. */
  inlineImages: (emailId: number) => invoke<InlineImageDto[]>("inline_images", { emailId }),

  unsubscribeInfo: (emailId: number) =>
    invoke<UnsubscribeInfo>("unsubscribe_info", { emailId }),
  unsubscribeViaPost: (emailId: number) =>
    invoke<void>("unsubscribe_via_post", { emailId }),
  unsubscribeOpenBrowser: (emailId: number) =>
    invoke<void>("unsubscribe_open_browser", { emailId }),
  unsubscribeViaMailto: (emailId: number) =>
    invoke<void>("unsubscribe_via_mailto", { emailId }),

  embeddingModelStatus: () => invoke<ModelStatus>("embedding_model_status"),
  loadEmbeddingModel: () => invoke<void>("load_embedding_model"),
  embedPending: (accountId?: number) =>
    invoke<number>("embed_pending", { accountId: accountId ?? null }),
  /** Re-scans threads whose meeting data is stale. One inference per changed thread. */
  scanMeetings: (accountId?: number) =>
    invoke<number>("scan_meetings", { accountId: accountId ?? null }),
  /** Meetings starting in [from, to) - the visible month. Excludes dismissed ones. */
  listMeetings: (from: string, to: string, accountId?: number) =>
    invoke<MeetingDto[]>("list_meetings", { accountId: accountId ?? null, from, to }),
  /** Hides a meeting permanently; a later rescan will not bring it back. */
  dismissMeeting: (meetingId: number) => invoke<void>("dismiss_meeting", { meetingId }),

  /**
   * Hybrid (keyword + semantic when available) search over the current view's scope:
   * the selected account (or all), the open label, and only DANGER mail in Quarantine.
   */
  search: (query: string, scope: { accountId?: number; labelId?: string | null; dangerOnly: boolean }, limit?: number) =>
    invoke<SearchResultDto[]>("search", {
      query,
      accountId: scope.accountId ?? null,
      labelId: scope.labelId ?? null,
      dangerOnly: scope.dangerOnly,
      limit: limit ?? null,
    }),
};
