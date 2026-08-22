use rusqlite::Connection;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    email_address         TEXT NOT NULL UNIQUE,
    provider              TEXT NOT NULL DEFAULT 'gmail',
    display_name          TEXT,
    last_history_id       TEXT,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gmail_message_id    TEXT NOT NULL,
    gmail_thread_id     TEXT NOT NULL,
    sender              TEXT NOT NULL,
    subject             TEXT,
    body_text           TEXT,
    body_html           TEXT,
    received_at         TEXT NOT NULL,
    is_read             INTEGER NOT NULL DEFAULT 0,
    is_from_sent_folder INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_emails_account_received
    ON emails(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread
    ON emails(gmail_thread_id);

CREATE TABLE IF NOT EXISTS triage_results (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id           INTEGER NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
    type               TEXT NOT NULL,
    priority           TEXT NOT NULL,
    summary            TEXT NOT NULL,
    risk               TEXT NOT NULL,
    signals_json       TEXT NOT NULL,
    risk_explanation   TEXT NOT NULL,
    draft_reply        TEXT,
    next_step_warning  TEXT,
    triage_status      TEXT NOT NULL DEFAULT 'ok',
    model_version      TEXT NOT NULL,
    triaged_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triage_results_risk
    ON triage_results(risk);

CREATE TABLE IF NOT EXISTS sync_state (
    account_id        INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_synced_at    TEXT,
    last_sync_status  TEXT,
    last_error_message TEXT
);

CREATE TABLE IF NOT EXISTS labels (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gmail_label_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    label_type     TEXT NOT NULL DEFAULT 'user',
    color_bg       TEXT,
    color_fg       TEXT,
    description    TEXT,
    auto_apply     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, gmail_label_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id      INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    filename      TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    content_id    TEXT,
    is_inline     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);

CREATE TABLE IF NOT EXISTS message_summaries (
    content_hash  TEXT PRIMARY KEY,
    summary       TEXT NOT NULL,
    model_version TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_embeddings (
    email_id      INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    embedding     BLOB NOT NULL,
    dims          INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    embedded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ddl: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {ddl}"), [])?;
    }
    Ok(())
}

pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    // rfc_message_id: RFC 5322 Message-ID header, needed for In-Reply-To/References
    // when creating threaded Gmail drafts (gmail_message_id is Gmail's internal id, not this).
    add_column_if_missing(conn, "emails", "rfc_message_id", "rfc_message_id TEXT")?;
    // gmail_draft_id: set once a triaged draft reply has been saved to Gmail, so the UI
    // can show "Saved" instead of "Save as Gmail draft".
    add_column_if_missing(conn, "triage_results", "gmail_draft_id", "gmail_draft_id TEXT")?;
    // list_unsubscribe / list_unsubscribe_post: raw RFC 8058 headers captured at sync time
    // so the unsubscribe UI never needs a live re-fetch. unsubscribed_at: set once an
    // unsubscribe action has been taken, so the UI stops re-offering it.
    add_column_if_missing(conn, "emails", "list_unsubscribe", "list_unsubscribe TEXT")?;
    add_column_if_missing(
        conn,
        "emails",
        "list_unsubscribe_post",
        "list_unsubscribe_post INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "emails", "unsubscribed_at", "unsubscribed_at TEXT")?;
    // to_addrs / cc_addrs: raw "To" / "Cc" header values, so triage can tell whether the
    // user is the addressee or merely CC'd. NULL on rows synced before this column existed;
    // sync re-fetches those once to backfill.
    add_column_if_missing(conn, "emails", "to_addrs", "to_addrs TEXT")?;
    add_column_if_missing(conn, "emails", "cc_addrs", "cc_addrs TEXT")?;
    // backfill_done: set once sync has walked the whole inbox back to the oldest message;
    // until then each sync also pulls a batch of older mail.
    add_column_if_missing(conn, "accounts", "backfill_done", "backfill_done INTEGER NOT NULL DEFAULT 0")?;
    // attachments_scanned: rows stored before attachment parts were recorded get re-fetched
    // once by sync so their attachment list is known.
    add_column_if_missing(conn, "emails", "attachments_scanned", "attachments_scanned INTEGER NOT NULL DEFAULT 0")?;
    // user_risk: the user's own verdict (safe|caution|danger) overriding the model's `risk`.
    // Kept across re-runs; NULL means "go with the model".
    add_column_if_missing(conn, "triage_results", "user_risk", "user_risk TEXT")?;
    add_column_if_missing(conn, "triage_results", "user_risk_at", "user_risk_at TEXT")?;
    // done_at: the user marked this item handled (drops out of "needs action").
    add_column_if_missing(conn, "triage_results", "done_at", "done_at TEXT")?;
    // label_ids: JSON array of the message's Gmail label ids (e.g. ["INBOX","Label_12"]).
    add_column_if_missing(conn, "emails", "label_ids", "label_ids TEXT")?;
    Ok(())
}
