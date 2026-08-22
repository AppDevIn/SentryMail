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

-- Records that a thread has been scanned for meetings at a given message count, whether or
-- not one was found. Kept separate from `meetings` so a thread with no meeting is still
-- remembered as scanned - otherwise every meeting-free thread would be re-scanned, at one
-- on-device inference each, on every run.
CREATE TABLE IF NOT EXISTS thread_scans (
    account_id            INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gmail_thread_id       TEXT NOT NULL,
    scanned_message_count INTEGER NOT NULL,
    last_scanned_at       TEXT NOT NULL DEFAULT (datetime('now')),
    model_version         TEXT NOT NULL,
    PRIMARY KEY (account_id, gmail_thread_id)
);

CREATE TABLE IF NOT EXISTS meetings (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id            INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gmail_thread_id       TEXT NOT NULL,
    source_email_id       INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    kind                  TEXT NOT NULL,
    title                 TEXT NOT NULL,
    starts_at             TEXT NOT NULL,
    duration_minutes      INTEGER,
    join_url              TEXT,
    provider              TEXT,
    confidence            TEXT NOT NULL,
    dismissed_at          TEXT,
    model_version         TEXT NOT NULL,
    UNIQUE(account_id, gmail_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_starts ON meetings(starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_account ON meetings(account_id);

-- Known-phishing URL feeds (PhishTank / OpenPhish / URLhaus), downloaded whole and matched
-- locally. Whole-list download is what keeps the privacy promise: a per-URL lookup service
-- would learn who the user talks to and what they were sent.
CREATE TABLE IF NOT EXISTS threat_urls (
    canonical_url TEXT PRIMARY KEY,
    host          TEXT NOT NULL,
    source        TEXT NOT NULL,
    first_seen    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threat_urls_host ON threat_urls(host);

-- Hosts judged to belong to the attacker rather than to a compromised legitimate site.
-- Populated only via the promotion rule in `threat::matching` - never straight from a feed.
CREATE TABLE IF NOT EXISTS threat_hosts (
    host      TEXT PRIMARY KEY,
    url_count INTEGER NOT NULL,
    source    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threat_feed_state (
    source       TEXT PRIMARY KEY,
    last_fetched TEXT,
    etag         TEXT,
    entry_count  INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
);

CREATE TABLE IF NOT EXISTS email_link_hits (
    email_id   INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    match_kind TEXT NOT NULL,
    source     TEXT NOT NULL,
    PRIMARY KEY (email_id, url)
);
CREATE INDEX IF NOT EXISTS idx_email_link_hits_email ON email_link_hits(email_id);

-- A sender caught mailing a confirmed phishing URL. This is what turns a URL feed into the
-- "warn me when a known bad sender contacts me" behaviour the feeds cannot provide directly.
CREATE TABLE IF NOT EXISTS sender_reputation (
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    sender_address TEXT NOT NULL,
    phish_hits     INTEGER NOT NULL DEFAULT 0,
    first_hit_at   TEXT,
    last_hit_at    TEXT,
    PRIMARY KEY (account_id, sender_address)
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
    // attachment_names: space-joined attachment filenames, denormalised onto the email row
    // so keyword search can index them without joining `attachments` (ADR 0002).
    // Written by upsert_message; backfilled once here for rows stored before the column existed.
    add_column_if_missing(conn, "emails", "attachment_names", "attachment_names TEXT")?;
    conn.execute(
        "UPDATE emails SET attachment_names = (
            SELECT group_concat(filename, ' ') FROM attachments a WHERE a.email_id = emails.id
         )
         WHERE attachment_names IS NULL
           AND EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = emails.id)",
        [],
    )?;
    create_fts_index(conn)?;
    Ok(())
}

/// External-content FTS5 index over `emails`, kept in step by triggers so no write path
/// has to know it exists (ADR 0002). Runs a one-time `rebuild` when the table is first
/// created so rows that predate the index are searchable.
fn create_fts_index(conn: &Connection) -> rusqlite::Result<()> {
    let fts_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'emails_fts')",
        [],
        |row| row.get(0),
    )?;
    conn.execute_batch(FTS_SCHEMA)?;
    if !fts_exists {
        conn.execute("INSERT INTO emails_fts(emails_fts) VALUES('rebuild')", [])?;
    }
    Ok(())
}

/// Column order here is what `bm25()` weights refer to (see search::keyword).
const FTS_SCHEMA: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    subject, body_text, sender, to_addrs, cc_addrs, attachment_names,
    content='emails', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(rowid, subject, body_text, sender, to_addrs, cc_addrs, attachment_names)
    VALUES (new.id, new.subject, new.body_text, new.sender, new.to_addrs, new.cc_addrs, new.attachment_names);
END;

CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, sender, to_addrs, cc_addrs, attachment_names)
    VALUES ('delete', old.id, old.subject, old.body_text, old.sender, old.to_addrs, old.cc_addrs, old.attachment_names);
END;

CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE OF subject, body_text, sender, to_addrs, cc_addrs, attachment_names ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, sender, to_addrs, cc_addrs, attachment_names)
    VALUES ('delete', old.id, old.subject, old.body_text, old.sender, old.to_addrs, old.cc_addrs, old.attachment_names);
    INSERT INTO emails_fts(rowid, subject, body_text, sender, to_addrs, cc_addrs, attachment_names)
    VALUES (new.id, new.subject, new.body_text, new.sender, new.to_addrs, new.cc_addrs, new.attachment_names);
END;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_create_fts_index() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();
        let fts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('emails_fts', 'emails_ai', 'emails_ad', 'emails_au')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts, 4);
    }

    #[test]
    fn migration_backfills_attachment_names_and_rebuilds_index() {
        // Simulate a pre-FTS database: base schema plus rows, then run the full migration.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO accounts (id, email_address) VALUES (1, 'me@example.com')", []).unwrap();
        conn.execute(
            "INSERT INTO emails (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, body_text, received_at)
             VALUES (7, 1, 'm7', 't7', 'Ann <ann@example.com>', 'Quarterly report', 'See attached', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (email_id, attachment_id, filename, mime_type) VALUES (7, 'a1', 'budget.xlsx', 'application/x')",
            [],
        )
        .unwrap();
        run_migrations(&conn).unwrap();
        let names: String = conn
            .query_row("SELECT attachment_names FROM emails WHERE id = 7", [], |row| row.get(0))
            .unwrap();
        assert_eq!(names, "budget.xlsx");
        let hits: i64 = conn
            .query_row("SELECT COUNT(*) FROM emails_fts WHERE emails_fts MATCH '\"budget\"'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(hits, 1);
    }
}
