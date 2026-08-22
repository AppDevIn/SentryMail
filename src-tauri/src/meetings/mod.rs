//! Thread-level meeting extraction.
//!
//! Unlike triage (one message at a time), a meeting is agreed across a conversation: one side
//! proposes a time, the other accepts. That exchange is only visible with the whole thread and
//! the user's own sent replies, so this runs as its own pass over threads.
//!
//! One row per thread (`UNIQUE(account_id, gmail_thread_id)`), so re-scanning an updated thread
//! refreshes the meeting in place while preserving the user's dismissal.

mod url;

#[allow(unused_imports)]
pub use url::{validate_join_url, MeetingProvider};

use crate::llm::grammar::{MEETING_GBNF, MEETING_GRAMMAR_ROOT};
use crate::llm::LlmHandle;
use crate::triage::{build_meeting_prompt, ThreadMessage};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const MODEL_VERSION: &str = "gemma-meetings-v1";

/// Raw shape the GBNF grammar admits. `starts_at` is already guaranteed to be
/// `YYYY-MM-DDTHH:MM` by the grammar, so it needs no shape validation here.
#[derive(Debug, Deserialize)]
pub struct RawMeetingOutput {
    pub has_meeting: bool,
    pub kind: String,
    pub title: String,
    pub starts_at: String,
    pub duration_minutes: i64,
    pub join_url: Option<String>,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingDto {
    pub id: i64,
    pub account_id: i64,
    pub gmail_thread_id: String,
    pub source_email_id: Option<i64>,
    /// "confirmed" (has a joinable link) | "possible" (mutually agreed, no link).
    pub kind: String,
    pub title: String,
    pub starts_at: String,
    pub duration_minutes: Option<i64>,
    pub join_url: Option<String>,
    pub provider: Option<String>,
    pub confidence: String,
}

/// A thread that needs (re)scanning, with the data the prompt builder needs.
pub struct ThreadToScan {
    pub account_id: i64,
    pub gmail_thread_id: String,
    pub user_email: String,
    /// Newest message id, used as the click-through target.
    pub source_email_id: i64,
    pub message_count: i64,
    pub messages: Vec<StoredMessage>,
}

pub struct StoredMessage {
    pub sender: String,
    pub from_user: bool,
    pub received_at: String,
    pub body_text: String,
}

/// Scans one thread and upserts the result. `today` is the current local date (`YYYY-MM-DD`),
/// passed in so the caller controls the clock and tests stay deterministic.
pub async fn scan_thread(
    db: &Mutex<Connection>,
    llm: &LlmHandle,
    thread: &ThreadToScan,
    today: &str,
) -> Result<Option<MeetingDto>, String> {
    let borrowed: Vec<ThreadMessage> = thread
        .messages
        .iter()
        .map(|m| ThreadMessage {
            sender: &m.sender,
            from_user: m.from_user,
            received_at: &m.received_at,
            body_text: &m.body_text,
        })
        .collect();

    let prompt = build_meeting_prompt(&borrowed, &thread.user_email, today);
    // generate() defaults to the *triage* grammar - the meeting schema must be passed
    // explicitly, or the model is constrained into the wrong JSON shape entirely.
    let raw = llm
        .generate_with(prompt, 300, MEETING_GBNF, MEETING_GRAMMAR_ROOT)
        .await?;

    // A parse failure means we learned nothing about this thread. Record the scan so we do not
    // retry it forever, but never write a half-populated meeting - a wrong calendar entry is
    // worse than a missing one.
    let parsed: RawMeetingOutput = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => {
            mark_scanned(db, thread)?;
            return Ok(None);
        }
    };

    if !parsed.has_meeting || parsed.kind == "none" {
        clear_meeting(db, thread)?;
        mark_scanned(db, thread)?;
        return Ok(None);
    }

    let dto = upsert(db, thread, parsed)?;
    mark_scanned(db, thread)?;
    Ok(Some(dto))
}

/// Applies the model's answer to the thread, validating the link before it is stored.
fn upsert(
    db: &Mutex<Connection>,
    thread: &ThreadToScan,
    parsed: RawMeetingOutput,
) -> Result<MeetingDto, String> {
    let thread_text: String = thread
        .messages
        .iter()
        .map(|m| m.body_text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    // The model is allowed to find the link, but a link it invented or truncated would be a
    // visibly broken calendar entry, so it must survive validation against the actual thread.
    let validated = parsed
        .join_url
        .as_deref()
        .and_then(|u| validate_join_url(u, &thread_text));

    // "confirmed" means joinable. Without a link that survived validation it is at best a
    // mutually-agreed time, so it degrades rather than making a promise the row cannot keep.
    let (kind, join_url, provider) = match validated {
        Some((url, provider)) => ("confirmed", Some(url), Some(provider.as_str().to_string())),
        None => ("possible", None, None),
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meetings
           (account_id, gmail_thread_id, source_email_id, kind, title, starts_at,
            duration_minutes, join_url, provider, confidence, model_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
            source_email_id=excluded.source_email_id,
            kind=excluded.kind,
            title=excluded.title,
            starts_at=excluded.starts_at,
            duration_minutes=excluded.duration_minutes,
            join_url=excluded.join_url,
            provider=excluded.provider,
            confidence=excluded.confidence,
            model_version=excluded.model_version",
        params![
            thread.account_id,
            thread.gmail_thread_id,
            thread.source_email_id,
            kind,
            parsed.title,
            parsed.starts_at,
            parsed.duration_minutes,
            join_url,
            provider,
            parsed.confidence,
            MODEL_VERSION,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Note the DO UPDATE deliberately does not touch dismissed_at: once the user has dismissed
    // a thread's meeting, later messages in that thread must not resurrect it.
    let id: i64 = conn
        .query_row(
            "SELECT id FROM meetings WHERE account_id = ?1 AND gmail_thread_id = ?2",
            params![thread.account_id, thread.gmail_thread_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(MeetingDto {
        id,
        account_id: thread.account_id,
        gmail_thread_id: thread.gmail_thread_id.clone(),
        source_email_id: Some(thread.source_email_id),
        kind: kind.to_string(),
        title: parsed.title,
        starts_at: parsed.starts_at,
        duration_minutes: Some(parsed.duration_minutes),
        join_url,
        provider,
        confidence: parsed.confidence,
    })
}

/// The thread no longer describes a meeting (or never did). Drop any stored meeting, but keep a
/// dismissed row so a dismissal is never silently forgotten.
fn clear_meeting(db: &Mutex<Connection>, thread: &ThreadToScan) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    // A dismissed row is kept: it is the record of the user's decision, and deleting it would
    // let a later message in the same thread resurrect a meeting they already dismissed.
    conn.execute(
        "DELETE FROM meetings
         WHERE account_id = ?1 AND gmail_thread_id = ?2 AND dismissed_at IS NULL",
        params![thread.account_id, thread.gmail_thread_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Records that this thread has been scanned at its current message count - including when no
/// meeting was found, so a meeting-free thread is not re-scanned on every run.
pub fn mark_scanned(db: &Mutex<Connection>, thread: &ThreadToScan) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO thread_scans
           (account_id, gmail_thread_id, scanned_message_count, last_scanned_at, model_version)
         VALUES (?1, ?2, ?3, datetime('now'), ?4)
         ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
            scanned_message_count=excluded.scanned_message_count,
            last_scanned_at=datetime('now'),
            model_version=excluded.model_version",
        params![
            thread.account_id,
            thread.gmail_thread_id,
            thread.message_count,
            MODEL_VERSION
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Meetings in `[from, to)` for the calendar grid. Dismissed meetings are never returned.
pub fn list_meetings(
    db: &Mutex<Connection>,
    account_id: Option<i64>,
    from: &str,
    to: &str,
) -> Result<Vec<MeetingDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, gmail_thread_id, source_email_id, kind, title, starts_at,
                    duration_minutes, join_url, provider, confidence
             FROM meetings
             WHERE dismissed_at IS NULL
               AND (?1 IS NULL OR account_id = ?1)
               AND starts_at >= ?2 AND starts_at < ?3
             ORDER BY starts_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id, from, to], |row| {
            Ok(MeetingDto {
                id: row.get(0)?,
                account_id: row.get(1)?,
                gmail_thread_id: row.get(2)?,
                source_email_id: row.get(3)?,
                kind: row.get(4)?,
                title: row.get(5)?,
                starts_at: row.get(6)?,
                duration_minutes: row.get(7)?,
                join_url: row.get(8)?,
                provider: row.get(9)?,
                confidence: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn dismiss_meeting(db: &Mutex<Connection>, meeting_id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE meetings SET dismissed_at = datetime('now') WHERE id = ?1",
            params![meeting_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no meeting with id {meeting_id}"));
    }
    Ok(())
}
