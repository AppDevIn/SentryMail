//! Known-phishing link detection.
//!
//! A deterministic layer underneath the on-device model. The model reasons about pretext and
//! tone; it cannot know that a specific URL is a *confirmed* phishing page. Three public feeds
//! supply that fact, downloaded whole and matched locally.
//!
//! Downloading whole lists rather than querying a lookup service is what preserves the app's
//! promise: a per-URL API would tell a third party who the user corresponds with and what they
//! were sent.

pub mod canon;
pub mod feeds;
pub mod matching;

use feeds::Source;
use matching::MatchKind;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct LinkHitDto {
    pub url: String,
    /// "exact" | "host"
    pub match_kind: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreatFeedStatusDto {
    pub source: String,
    pub last_fetched: Option<String>,
    pub entry_count: i64,
    pub last_error: Option<String>,
}

/// Replaces one source's URLs in a single transaction.
///
/// All-or-nothing on purpose: a partial write would leave a half-empty blocklist that still
/// *looks* populated, which is worse than an obviously stale one.
pub fn store_feed(db: &Mutex<Connection>, source: Source, urls: &[String], etag: Option<&str>) -> Result<usize, String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM threat_urls WHERE source = ?1", params![source.as_str()])
        .map_err(|e| e.to_string())?;

    let mut stored = 0usize;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO threat_urls (canonical_url, host, source) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for raw in urls {
            let Some(canonical) = canon::canonicalize(raw) else { continue };
            let Some(host) = canon::host_of(&canonical) else { continue };
            stmt.execute(params![canonical, host, source.as_str()])
                .map_err(|e| e.to_string())?;
            stored += 1;
        }
    }

    // Recompute host promotions across *all* sources: a host can cross the threshold only by
    // combining evidence, so this cannot be done per-source.
    tx.execute("DELETE FROM threat_hosts", []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "SELECT host, COUNT(DISTINCT canonical_url) AS n, MIN(source)
                 FROM threat_urls GROUP BY host HAVING n >= ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![matching::HOST_PROMOTION_THRESHOLD], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut ins = tx
            .prepare("INSERT OR REPLACE INTO threat_hosts (host, url_count, source) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (host, n, src) in rows {
            if matching::is_promotable_host(&host, n) {
                ins.execute(params![host, n, src]).map_err(|e| e.to_string())?;
            }
        }
    }

    tx.execute(
        "INSERT INTO threat_feed_state (source, last_fetched, etag, entry_count, last_error)
         VALUES (?1, datetime('now'), ?2, ?3, NULL)
         ON CONFLICT(source) DO UPDATE SET
            last_fetched=datetime('now'), etag=excluded.etag,
            entry_count=excluded.entry_count, last_error=NULL",
        params![source.as_str(), etag, stored as i64],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(stored)
}

/// Records a failed refresh **without** touching the stored URLs. A feed being unreachable must
/// never silently downgrade to "no warnings".
pub fn record_feed_error(db: &Mutex<Connection>, source: Source, message: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO threat_feed_state (source, last_error) VALUES (?1, ?2)
         ON CONFLICT(source) DO UPDATE SET last_error=excluded.last_error",
        params![source.as_str(), message],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn feed_status(db: &Mutex<Connection>) -> Result<Vec<ThreatFeedStatusDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for source in Source::ALL {
        let row = conn
            .query_row(
                "SELECT last_fetched, entry_count, last_error FROM threat_feed_state WHERE source = ?1",
                params![source.as_str()],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?)),
            )
            .ok();
        let (last_fetched, entry_count, last_error) = row.unwrap_or((None, 0, None));
        out.push(ThreatFeedStatusDto {
            source: source.as_str().to_string(),
            last_fetched,
            entry_count,
            last_error,
        });
    }
    Ok(out)
}

/// Every http(s) URL appearing in a message body, de-duplicated.
///
/// Both the plain-text and HTML parts are scanned: a phishing link is frequently only in the
/// HTML, behind friendly anchor text.
pub fn extract_urls(body_text: &str, body_html: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |candidate: &str| {
        if let Some(c) = canon::canonicalize(candidate) {
            if seen.insert(c.clone()) {
                out.push(c);
            }
        }
    };

    for chunk in body_text.split(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '\'') {
        if chunk.starts_with("http://") || chunk.starts_with("https://") {
            push(chunk);
        }
    }

    if let Some(html) = body_html {
        // Anchor/image targets, plus anything else quoted that looks like a URL.
        for chunk in html.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')' || c == '<' || c == '>') {
            if chunk.starts_with("http://") || chunk.starts_with("https://") {
                push(chunk);
            }
        }
    }
    out
}

/// Looks each URL up in the feeds. Exact match first; host match only if the host was promoted.
pub fn match_urls(conn: &Connection, urls: &[String]) -> Result<Vec<(String, MatchKind, String)>, String> {
    let mut hits = Vec::new();
    for url in urls {
        if let Ok((source,)) = conn.query_row(
            "SELECT source FROM threat_urls WHERE canonical_url = ?1",
            params![url],
            |r| Ok((r.get::<_, String>(0)?,)),
        ) {
            hits.push((url.clone(), MatchKind::Exact, source));
            continue;
        }
        let Some(host) = canon::host_of(url) else { continue };
        if let Ok((source,)) = conn.query_row(
            "SELECT source FROM threat_hosts WHERE host = ?1",
            params![host],
            |r| Ok((r.get::<_, String>(0)?,)),
        ) {
            hits.push((url.clone(), MatchKind::Host, source));
        }
    }
    Ok(hits)
}

/// Scans one stored email, records hits, and credits the sender's reputation on an exact hit.
pub fn scan_email(db: &Mutex<Connection>, email_id: i64) -> Result<Vec<LinkHitDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let (account_id, sender, body_text, body_html): (i64, String, String, Option<String>) = conn
        .query_row(
            "SELECT account_id, sender, COALESCE(body_text,''), body_html FROM emails WHERE id = ?1",
            params![email_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let urls = extract_urls(&body_text, body_html.as_deref());
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let hits = match_urls(&conn, &urls)?;

    conn.execute("DELETE FROM email_link_hits WHERE email_id = ?1", params![email_id])
        .map_err(|e| e.to_string())?;
    for (url, kind, source) in &hits {
        conn.execute(
            "INSERT OR REPLACE INTO email_link_hits (email_id, url, match_kind, source)
             VALUES (?1, ?2, ?3, ?4)",
            params![email_id, url, kind.as_str(), source],
        )
        .map_err(|e| e.to_string())?;
    }

    // Only an exact hit is strong enough to stain a sender: a host-level inference could be
    // wrong, and a wrongly-blacklisted correspondent is a bad failure.
    if hits.iter().any(|(_, k, _)| *k == MatchKind::Exact) {
        let address = crate::gmail::client::extract_email_address(&sender);
        if !address.is_empty() {
            conn.execute(
                "INSERT INTO sender_reputation (account_id, sender_address, phish_hits, first_hit_at, last_hit_at)
                 VALUES (?1, ?2, 1, datetime('now'), datetime('now'))
                 ON CONFLICT(account_id, sender_address) DO UPDATE SET
                    phish_hits = phish_hits + 1, last_hit_at = datetime('now')",
                params![account_id, address.to_ascii_lowercase()],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(hits
        .into_iter()
        .map(|(url, kind, source)| LinkHitDto { url, match_kind: kind.as_str().to_string(), source })
        .collect())
}

/// Has this sender ever mailed a confirmed phishing URL to this account?
pub fn sender_flagged(conn: &Connection, account_id: i64, sender: &str) -> bool {
    let address = crate::gmail::client::extract_email_address(sender).to_ascii_lowercase();
    if address.is_empty() {
        return false;
    }
    conn.query_row(
        "SELECT phish_hits FROM sender_reputation WHERE account_id = ?1 AND sender_address = ?2",
        params![account_id, address],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

pub fn link_hits(db: &Mutex<Connection>, email_id: i64) -> Result<Vec<LinkHitDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT url, match_kind, source FROM email_link_hits WHERE email_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![email_id], |r| {
            Ok(LinkHitDto { url: r.get(0)?, match_kind: r.get(1)?, source: r.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
