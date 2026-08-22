use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;

const API_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

#[derive(Debug, Clone)]
pub struct FetchedEmail {
    pub gmail_message_id: String,
    pub gmail_thread_id: String,
    pub sender: String,
    pub to_addrs: String, // raw "To" header value ("" if absent)
    pub cc_addrs: String, // raw "Cc" header value ("" if absent)
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub received_at: String, // RFC3339, derived from the message's internalDate
    pub is_read: bool,
    pub is_from_sent_folder: bool,
    pub rfc_message_id: Option<String>, // from the "Message-ID" header, used for In-Reply-To threading
    pub list_unsubscribe: Option<String>, // raw "List-Unsubscribe" header value, if present
    pub list_unsubscribe_post: bool, // true iff "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
    pub attachments: Vec<AttachmentMeta>,
    /// Gmail label ids on the message (INBOX, UNREAD, user labels like Label_12, ...).
    pub label_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LabelsResponse {
    labels: Option<Vec<GmailLabel>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub label_type: String,
    #[serde(default)]
    pub color: Option<GmailLabelColor>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GmailLabelColor {
    #[serde(rename = "backgroundColor")]
    pub background_color: Option<String>,
    #[serde(rename = "textColor")]
    pub text_color: Option<String>,
}

/// Metadata of one MIME attachment part (the bytes stay at Gmail until opened).
#[derive(Debug, Clone)]
pub struct AttachmentMeta {
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    /// Content-ID (without <>), for `cid:` references from the HTML body.
    pub content_id: Option<String>,
    pub is_inline: bool,
}

#[derive(Debug, Deserialize)]
struct ListMessagesResponse {
    messages: Option<Vec<MessageId>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "resultSizeEstimate")]
    result_size_estimate: Option<u64>,
}

/// One page of inbox message ids.
pub struct MessagePage {
    pub ids: Vec<String>,
    pub next_page_token: Option<String>,
    /// Gmail's (rough) estimate of the total matching messages, for progress display.
    pub estimate: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ProfileResponse {
    #[serde(rename = "historyId")]
    history_id: String,
}

#[derive(Debug, Deserialize)]
struct HistoryResponse {
    history: Option<Vec<HistoryRecord>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct HistoryRecord {
    #[serde(rename = "messagesAdded", default)]
    pub messages_added: Vec<HistoryMessageRef>,
    #[serde(rename = "labelsAdded", default)]
    pub labels_added: Vec<HistoryLabelChange>,
    #[serde(rename = "labelsRemoved", default)]
    pub labels_removed: Vec<HistoryLabelChange>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessageRef {
    pub message: HistoryMessage,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessage {
    pub id: String,
    #[serde(rename = "labelIds", default)]
    pub label_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryLabelChange {
    pub message: HistoryMessage,
    /// The labels that were added/removed in this change (not the message's full label set).
    #[serde(rename = "labelIds", default)]
    pub label_ids: Vec<String>,
}

pub enum HistoryOutcome {
    Page {
        records: Vec<HistoryRecord>,
        next_page_token: Option<String>,
    },
    /// Gmail no longer has history from the requested id (too old); do a full listing instead.
    Expired,
}

#[derive(Debug, Deserialize)]
struct MessageId {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GmailMessage {
    #[serde(rename = "threadId")]
    thread_id: String,
    #[serde(rename = "internalDate")]
    internal_date: String,
    #[serde(rename = "labelIds", default)]
    label_ids: Vec<String>,
    payload: GmailPayload,
}

#[derive(Debug, Deserialize)]
struct GmailPayload {
    #[serde(default)]
    headers: Vec<GmailHeader>,
    #[serde(default)]
    parts: Vec<GmailPayload>,
    #[serde(default)]
    body: GmailBody,
    #[serde(rename = "mimeType", default)]
    mime_type: String,
    #[serde(default)]
    filename: String,
}

#[derive(Debug, Deserialize, Default)]
struct GmailBody {
    data: Option<String>,
    #[serde(rename = "attachmentId")]
    attachment_id: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct AttachmentResponse {
    data: String,
}

#[derive(Debug, Deserialize)]
struct GmailHeader {
    name: String,
    value: String,
}

pub struct GmailClient {
    http: reqwest::Client,
    access_token: String,
}

impl GmailClient {
    pub fn new(access_token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            access_token,
        }
    }

    /// Lists one page of inbox message ids (newest first), for the full-listing sync path.
    pub async fn list_inbox_page(
        &self,
        max_results: u32,
        page_token: Option<&str>,
    ) -> Result<MessagePage, String> {
        self.list_inbox_query_page(max_results, page_token, None).await
    }

    /// Same, optionally narrowed by a Gmail search query (e.g. `before:2026/08/05`).
    pub async fn list_inbox_query_page(
        &self,
        max_results: u32,
        page_token: Option<&str>,
        query: Option<&str>,
    ) -> Result<MessagePage, String> {
        let mut url = format!("{API_BASE}/messages?maxResults={max_results}&labelIds=INBOX");
        if let Some(q) = query {
            url.push_str("&q=");
            url.push_str(&urlencoding_encode(q));
        }
        if let Some(token) = page_token {
            url.push_str("&pageToken=");
            url.push_str(token);
        }
        let resp: ListMessagesResponse = self
            .http
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        Ok(MessagePage {
            ids: resp.messages.unwrap_or_default().into_iter().map(|m| m.id).collect(),
            next_page_token: resp.next_page_token,
            estimate: resp.result_size_estimate,
        })
    }

    /// The mailbox's current historyId, used as the starting point for the next incremental sync.
    pub async fn current_history_id(&self) -> Result<String, String> {
        let resp: ProfileResponse = self
            .http
            .get(format!("{API_BASE}/profile"))
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        Ok(resp.history_id)
    }

    /// One page of mailbox changes since `start_history_id`: new messages plus label
    /// (read/unread) changes. Returns `Expired` when Gmail has discarded that history.
    pub async fn list_history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryOutcome, String> {
        let mut url = format!(
            "{API_BASE}/history?startHistoryId={start_history_id}&maxResults=500\
             &historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved"
        );
        if let Some(token) = page_token {
            url.push_str("&pageToken=");
            url.push_str(token);
        }
        let resp = self
            .http
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(HistoryOutcome::Expired);
        }
        let resp: HistoryResponse = resp
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        Ok(HistoryOutcome::Page {
            records: resp.history.unwrap_or_default(),
            next_page_token: resp.next_page_token,
        })
    }

    /// Adds/removes labels on a message (e.g. UNREAD). Needs the `gmail.modify` scope; a
    /// token granted with only `gmail.readonly` gets a 403 here.
    pub async fn modify_labels(
        &self,
        message_id: &str,
        add: &[&str],
        remove: &[&str],
    ) -> Result<(), String> {
        let resp = self
            .http
            .post(format!("{API_BASE}/messages/{message_id}/modify"))
            .bearer_auth(&self.access_token)
            .json(&serde_json::json!({ "addLabelIds": add, "removeLabelIds": remove }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err("insufficient permission (the account was connected with read-only access)".to_string());
        }
        Err(format!("Gmail returned {status}"))
    }

    /// Phase 1 sync: list the most recent inbox message ids (kept for callers that only
    /// need a quick peek; the sync itself now pages through the inbox / uses history).
    #[allow(dead_code)]
    pub async fn list_recent_message_ids(&self, max_results: u32) -> Result<Vec<String>, String> {
        let url = format!(
            "{API_BASE}/messages?maxResults={max_results}&labelIds=INBOX"
        );
        let resp: ListMessagesResponse = self
            .http
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        Ok(resp
            .messages
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.id)
            .collect())
    }

    pub async fn get_message(&self, message_id: &str) -> Result<FetchedEmail, String> {
        let url = format!("{API_BASE}/messages/{message_id}?format=full");
        let msg: GmailMessage = self
            .http
            .get(url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        let header = |name: &str| -> String {
            msg.payload
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.clone())
                .unwrap_or_default()
        };

        let (body_text, body_html) = extract_body(&msg.payload);
        let attachments = collect_attachments(&msg.payload);

        let internal_date_ms: i64 = msg.internal_date.parse().map_err(|_| {
            format!("unexpected internalDate value: {}", msg.internal_date)
        })?;
        let received_at = chrono::DateTime::from_timestamp_millis(internal_date_ms)
            .ok_or("invalid internalDate timestamp")?
            .to_rfc3339();

        let rfc_message_id = {
            let v = header("Message-ID");
            if v.is_empty() { None } else { Some(v) }
        };
        let list_unsubscribe = {
            let v = header("List-Unsubscribe");
            if v.is_empty() { None } else { Some(v) }
        };
        let list_unsubscribe_post = header("List-Unsubscribe-Post")
            .eq_ignore_ascii_case("List-Unsubscribe=One-Click");

        Ok(FetchedEmail {
            gmail_message_id: message_id.to_string(),
            gmail_thread_id: msg.thread_id,
            sender: header("From"),
            to_addrs: header("To"),
            cc_addrs: header("Cc"),
            subject: header("Subject"),
            body_text,
            body_html,
            received_at,
            is_read: !msg.label_ids.iter().any(|l| l == "UNREAD"),
            is_from_sent_folder: msg.label_ids.iter().any(|l| l == "SENT"),
            rfc_message_id,
            list_unsubscribe,
            list_unsubscribe_post,
            attachments,
            label_ids: msg.label_ids.clone(),
        })
    }

    /// All labels in the mailbox (system + user).
    pub async fn list_labels(&self) -> Result<Vec<GmailLabel>, String> {
        let resp: LabelsResponse = self
            .http
            .get(format!("{API_BASE}/labels"))
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        Ok(resp.labels.unwrap_or_default())
    }

    /// Downloads one attachment's bytes (`users.messages.attachments.get`).
    pub async fn get_attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>, String> {
        let resp: AttachmentResponse = self
            .http
            .get(format!("{API_BASE}/messages/{message_id}/attachments/{attachment_id}"))
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        URL_SAFE_NO_PAD
            .decode(resp.data.trim_end_matches('='))
            .map_err(|e| format!("attachment decode failed: {e}"))
    }

    /// Creates a Gmail draft. `thread_id` should be `Some` when replying within an
    /// existing thread, or `None` for a standalone draft (e.g. the mailto-unsubscribe
    /// flow, which must not thread onto the original email). `subject` is sent as-is;
    /// non-ASCII subjects are a known v1 limitation (would need RFC 2047 encoding).
    pub async fn create_draft(
        &self,
        from: &str,
        to: &str,
        cc: Option<&str>,
        subject: &str,
        body: &str,
        thread_id: Option<&str>,
        in_reply_to_rfc_message_id: Option<&str>,
    ) -> Result<String, String> {
        let mut mime = format!("From: {from}\r\nTo: {to}\r\n");
        if let Some(cc) = cc.filter(|c| !c.trim().is_empty()) {
            mime.push_str(&format!("Cc: {cc}\r\n"));
        }
        mime.push_str(&format!("Subject: {subject}\r\n"));
        if let Some(mid) = in_reply_to_rfc_message_id {
            mime.push_str(&format!("In-Reply-To: {mid}\r\nReferences: {mid}\r\n"));
        }
        mime.push_str("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
        mime.push_str(body);

        let raw = URL_SAFE_NO_PAD.encode(mime.as_bytes());
        let mut payload = serde_json::json!({ "message": { "raw": raw } });
        if let Some(tid) = thread_id {
            payload["message"]["threadId"] = serde_json::json!(tid);
        }

        #[derive(Debug, Deserialize)]
        struct DraftResponse {
            id: String,
        }

        let resp: DraftResponse = self
            .http
            .post(format!("{API_BASE}/drafts"))
            .bearer_auth(&self.access_token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        Ok(resp.id)
    }

    /// Sends an already-created draft via `users.drafts.send`. This is the app's one
    /// deliberate use of the send capability inherent to the `gmail.compose` scope -
    /// see the `unsubscribe` module, the only caller. Never used for arbitrary mail.
    pub async fn send_draft(&self, draft_id: &str) -> Result<(), String> {
        self.http
            .post(format!("{API_BASE}/drafts/send"))
            .bearer_auth(&self.access_token)
            .json(&serde_json::json!({ "id": draft_id }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Minimal percent-encoding for a query-string value (Gmail `q=` parameter).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Pulls the bare address out of a "Display Name <addr@x.com>" header value,
/// or returns the trimmed input unchanged if it's already a bare address.
pub fn extract_email_address(header_value: &str) -> String {
    if let (Some(start), Some(end)) = (header_value.find('<'), header_value.find('>')) {
        if start < end {
            return header_value[start + 1..end].trim().to_string();
        }
    }
    header_value.trim().to_string()
}

/// Walks the (possibly nested, multipart) payload tree for the first
/// text/plain and text/html parts, base64url-decoding Gmail's body encoding.
fn extract_body(payload: &GmailPayload) -> (String, Option<String>) {
    let mut text = None;
    let mut html = None;
    walk_parts(payload, &mut text, &mut html);
    (text.unwrap_or_default(), html)
}

/// Every part that carries a filename or an attachmentId (real files and inline images).
fn collect_attachments(payload: &GmailPayload) -> Vec<AttachmentMeta> {
    let mut out = Vec::new();
    fn walk(p: &GmailPayload, out: &mut Vec<AttachmentMeta>) {
        if let Some(id) = &p.body.attachment_id {
            let header = |name: &str| -> Option<String> {
                p.headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case(name))
                    .map(|h| h.value.clone())
            };
            let content_id = header("Content-ID")
                .or_else(|| header("X-Attachment-Id"))
                .map(|v| v.trim().trim_start_matches('<').trim_end_matches('>').to_string());
            let disposition = header("Content-Disposition").unwrap_or_default().to_ascii_lowercase();
            out.push(AttachmentMeta {
                attachment_id: id.clone(),
                filename: if p.filename.is_empty() { "attachment".to_string() } else { p.filename.clone() },
                mime_type: p.mime_type.clone(),
                size: p.body.size,
                is_inline: disposition.starts_with("inline") || (content_id.is_some() && p.filename.is_empty()),
                content_id,
            });
        }
        for part in &p.parts {
            walk(part, out);
        }
    }
    walk(payload, &mut out);
    out
}

fn walk_parts(payload: &GmailPayload, text: &mut Option<String>, html: &mut Option<String>) {
    if let Some(data) = &payload.body.data {
        if let Ok(decoded) = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')) {
            if let Ok(decoded_str) = String::from_utf8(decoded) {
                if payload.mime_type == "text/plain" && text.is_none() {
                    *text = Some(decoded_str);
                } else if payload.mime_type == "text/html" && html.is_none() {
                    *html = Some(decoded_str);
                }
            }
        }
    }
    for part in &payload.parts {
        walk_parts(part, text, html);
    }
}

#[cfg(test)]
mod tests {
    use super::extract_email_address;

    #[test]
    fn extracts_address_from_display_name() {
        assert_eq!(
            extract_email_address("Jane Doe <jane@example.com>"),
            "jane@example.com"
        );
    }

    #[test]
    fn passes_through_bare_address() {
        assert_eq!(extract_email_address("jane@example.com"), "jane@example.com");
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(
            extract_email_address("  Jane Doe  <  jane@example.com  >  "),
            "jane@example.com"
        );
    }

    #[test]
    fn falls_back_when_malformed() {
        // no matching '>' - not a valid <...> pair, so return the trimmed input as-is
        assert_eq!(extract_email_address("Jane Doe <jane@example.com"), "Jane Doe <jane@example.com");
    }

    #[test]
    fn falls_back_on_empty_string() {
        assert_eq!(extract_email_address(""), "");
    }
}
