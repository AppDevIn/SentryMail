//! Keyword (FTS5 / BM25) side of hybrid search (ADR 0001, 0002, 0006).

use rusqlite::{params, Connection};

/// Marker characters wrapped around matched terms in a keyword snippet. The UI turns
/// them into highlight spans; they are never HTML (ADR 0006).
pub const HIGHLIGHT_START: char = '\u{E000}';
pub const HIGHLIGHT_END: char = '\u{E001}';

/// Builds a safe FTS5 MATCH expression from raw user input: every term is a quoted
/// string (so operators and stray punctuation can never be parsed as syntax), quoted
/// phrases are kept as phrases, and the last bare term gets a prefix match so partial
/// words work while typing. Returns `None` when there is nothing to search for.
pub fn sanitize_query(raw: &str) -> Option<String> {
    let terms = tokenize(raw);
    if terms.is_empty() {
        return None;
    }
    let last = terms.len() - 1;
    let parts: Vec<String> = terms
        .iter()
        .enumerate()
        .map(|(i, term)| {
            let quoted = format!("\"{}\"", term.text.replace('"', "\"\""));
            if i == last && !term.is_phrase && term.text.chars().count() >= 2 {
                format!("{quoted}*")
            } else {
                quoted
            }
        })
        .collect();
    Some(parts.join(" "))
}

struct Term {
    text: String,
    is_phrase: bool,
}

/// Splits on whitespace, treating `"..."` (balanced or not) as one phrase. Terms with no
/// alphanumeric character are dropped: the tokenizer would index nothing for them anyway.
fn tokenize(raw: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let mut chars = raw.chars().peekable();
    let mut bare = String::new();

    let flush_bare = |bare: &mut String, terms: &mut Vec<Term>| {
        if bare.chars().any(char::is_alphanumeric) {
            terms.push(Term {
                text: std::mem::take(bare),
                is_phrase: false,
            });
        } else {
            bare.clear();
        }
    };

    while let Some(c) = chars.next() {
        if c == '"' {
            flush_bare(&mut bare, &mut terms);
            let mut phrase = String::new();
            for pc in chars.by_ref() {
                if pc == '"' {
                    break;
                }
                phrase.push(pc);
            }
            let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
            if normalized.chars().any(char::is_alphanumeric) {
                terms.push(Term {
                    text: normalized,
                    is_phrase: true,
                });
            }
        } else if c.is_whitespace() {
            flush_bare(&mut bare, &mut terms);
        } else {
            bare.push(c);
        }
    }
    flush_bare(&mut bare, &mut terms);
    terms
}

/// Top keyword candidates for a sanitized MATCH expression, best first, scoped the same
/// way the embedding candidates are (ADR 0004). Returns `(email_id, bm25_rank, snippet)`;
/// bm25 is negative and lower is better. Column weights favour subject and sender over
/// body text (ADR 0002).
pub fn keyword_search(
    conn: &Connection,
    match_expr: &str,
    account_id: Option<i64>,
    label_id: Option<&str>,
    danger_only: bool,
    limit: u32,
) -> Result<Vec<(i64, f64, String)>, String> {
    let sql = format!(
        "SELECT e.id,
                    bm25(emails_fts, 10.0, 1.0, 5.0, 2.0, 2.0, 3.0) AS rank,
                    snippet(emails_fts, -1, char({start}), char({end}), '…', 24)
             FROM emails_fts
             JOIN emails e ON e.id = emails_fts.rowid
             LEFT JOIN triage_results t ON t.email_id = e.id
             WHERE emails_fts MATCH ?1
               AND (?2 IS NULL OR e.account_id = ?2)
               AND (?3 IS NULL OR e.label_ids LIKE '%\"' || ?3 || '\"%')
               AND (?4 = 0 OR COALESCE(t.user_risk, t.risk) = 'danger')
             ORDER BY rank
             LIMIT ?5",
        start = HIGHLIGHT_START as u32,
        end = HIGHLIGHT_END as u32,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, account_id, label_id, danger_only, limit], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    // --- sanitize_query -------------------------------------------------------

    #[test]
    fn single_term_gets_prefix_match() {
        assert_eq!(sanitize_query("remit").as_deref(), Some("\"remit\"*"));
    }

    #[test]
    fn only_last_term_gets_prefix_match() {
        assert_eq!(sanitize_query("invoice 4471").as_deref(), Some("\"invoice\" \"4471\"*"));
    }

    #[test]
    fn one_char_last_term_is_not_prefixed() {
        assert_eq!(sanitize_query("plan b").as_deref(), Some("\"plan\" \"b\""));
    }

    #[test]
    fn quoted_phrase_is_kept_as_phrase_without_prefix() {
        assert_eq!(
            sanitize_query("\"bank details\" invoice").as_deref(),
            Some("\"bank details\" \"invoice\"*")
        );
        assert_eq!(sanitize_query("invoice \"bank details\"").as_deref(), Some("\"invoice\" \"bank details\""));
    }

    #[test]
    fn unbalanced_quote_runs_to_end_as_phrase() {
        assert_eq!(sanitize_query("\"wire transfer").as_deref(), Some("\"wire transfer\""));
    }

    #[test]
    fn operators_are_quoted_as_plain_terms() {
        assert_eq!(
            sanitize_query("AND OR NOT NEAR").as_deref(),
            Some("\"AND\" \"OR\" \"NOT\" \"NEAR\"*")
        );
    }

    #[test]
    fn punctuation_only_terms_are_dropped() {
        // Dropped terms do not count: "invoice" is the last real term and is prefixed.
        assert_eq!(sanitize_query("invoice - * ( )").as_deref(), Some("\"invoice\"*"));
        assert_eq!(sanitize_query("... !!! \"\"").as_deref(), None);
    }

    #[test]
    fn empty_and_whitespace_yield_none() {
        assert_eq!(sanitize_query(""), None);
        assert_eq!(sanitize_query("   \t "), None);
    }

    #[test]
    fn quote_adjacent_to_word_splits_terms() {
        let expr = sanitize_query("say \"hi\"there").unwrap();
        assert_eq!(expr, "\"say\" \"hi\" \"there\"*");
    }

    #[test]
    fn very_long_input_is_sanitized_and_searchable() {
        let raw: String = (0..1000).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ");
        assert!(raw.len() > 5_000);
        let expr = sanitize_query(&raw).expect("long input yields an expression");
        assert!(expr.starts_with("\"word0\" \"word1\""));
        assert!(expr.ends_with("\"word999\"*"));
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "word0 word1", "", None, "[]");
        keyword_search(&conn, &expr, None, None, false, 50).unwrap();
    }

    #[test]
    fn unicode_terms_are_sanitized_and_searchable() {
        let expr = sanitize_query("café naïve 東京 émail").expect("unicode input yields an expression");
        assert_eq!(expr, "\"café\" \"naïve\" \"東京\" \"émail\"*");
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Café in 東京", "naïve émail", None, "[]");
        let hits = keyword_search(&conn, &expr, None, None, false, 50).unwrap();
        assert_eq!(hits.len(), 1);
        // remove_diacritics 2: accented query terms also match unaccented text.
        assert_eq!(ids(&conn, "cafe", None, None, false), vec![1]);
    }

    // --- keyword_search against a real in-memory FTS index ---------------------

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn.execute("INSERT INTO accounts (id, email_address) VALUES (1, 'me@example.com')", []).unwrap();
        conn.execute("INSERT INTO accounts (id, email_address) VALUES (2, 'other@example.com')", []).unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_email(
        conn: &Connection,
        id: i64,
        account_id: i64,
        sender: &str,
        subject: &str,
        body: &str,
        attachment_names: Option<&str>,
        label_ids: &str,
    ) {
        conn.execute(
            "INSERT INTO emails (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, body_text,
                                 received_at, attachment_names, label_ids)
             VALUES (?1, ?2, 'm' || ?1, 't' || ?1, ?3, ?4, ?5, '2026-01-01T00:00:00Z', ?6, ?7)",
            params![id, account_id, sender, subject, body, attachment_names, label_ids],
        )
        .unwrap();
    }

    fn ids(conn: &Connection, query: &str, account_id: Option<i64>, label_id: Option<&str>, danger_only: bool) -> Vec<i64> {
        let expr = sanitize_query(query).unwrap();
        keyword_search(conn, &expr, account_id, label_id, danger_only, 50)
            .unwrap()
            .into_iter()
            .map(|(id, _, _)| id)
            .collect()
    }

    #[test]
    fn finds_by_subject_sender_and_attachment_name() {
        let conn = db();
        insert_email(&conn, 1, 1, "Ann <ann@example.com>", "Invoice 4471 overdue", "please pay", None, "[\"INBOX\"]");
        insert_email(&conn, 2, 1, "Bob <bob@northgate.io>", "Lunch", "tomorrow?", Some("menu.pdf receipts.zip"), "[\"INBOX\"]");
        assert_eq!(ids(&conn, "invoice", None, None, false), vec![1]);
        assert_eq!(ids(&conn, "northgate", None, None, false), vec![2]);
        assert_eq!(ids(&conn, "receipts", None, None, false), vec![2]);
        assert_eq!(ids(&conn, "4471", None, None, false), vec![1]);
    }

    #[test]
    fn prefix_match_on_last_term_finds_partial_words() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Remittance advice", "", None, "[]");
        assert_eq!(ids(&conn, "remit", None, None, false), vec![1]);
    }

    #[test]
    fn snippet_highlights_matched_terms_with_marker_chars() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Invoice 4471", "The invoice is attached.", None, "[]");
        let expr = sanitize_query("invoice").unwrap();
        let hits = keyword_search(&conn, &expr, None, None, false, 50).unwrap();
        assert_eq!(hits.len(), 1);
        let snippet = &hits[0].2;
        assert!(snippet.contains(&format!("{HIGHLIGHT_START}Invoice{HIGHLIGHT_END}")) || snippet.contains(&format!("{HIGHLIGHT_START}invoice{HIGHLIGHT_END}")), "snippet was {snippet:?}");
        assert!(!snippet.contains('<'));
    }

    #[test]
    fn update_reindexes_and_delete_removes() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Old subject", "", None, "[]");
        assert_eq!(ids(&conn, "old", None, None, false), vec![1]);
        conn.execute("UPDATE emails SET subject = 'New subject' WHERE id = 1", []).unwrap();
        assert!(ids(&conn, "old", None, None, false).is_empty());
        assert_eq!(ids(&conn, "new", None, None, false), vec![1]);
        conn.execute("DELETE FROM emails WHERE id = 1", []).unwrap();
        assert!(ids(&conn, "new", None, None, false).is_empty());
    }

    #[test]
    fn attachment_names_update_is_indexed() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Files", "", None, "[]");
        assert!(ids(&conn, "budget", None, None, false).is_empty());
        conn.execute("UPDATE emails SET attachment_names = 'budget.xlsx' WHERE id = 1", []).unwrap();
        assert_eq!(ids(&conn, "budget", None, None, false), vec![1]);
    }

    #[test]
    fn account_and_label_filters_exclude_other_rows() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Invoice one", "", None, "[\"INBOX\",\"Label_1\"]");
        insert_email(&conn, 2, 2, "b@x.io", "Invoice two", "", None, "[\"INBOX\"]");
        assert_eq!(ids(&conn, "invoice", None, None, false).len(), 2);
        assert_eq!(ids(&conn, "invoice", Some(2), None, false), vec![2]);
        assert_eq!(ids(&conn, "invoice", None, Some("Label_1"), false), vec![1]);
        assert!(ids(&conn, "invoice", None, Some("Label_9"), false).is_empty());
    }

    #[test]
    fn danger_only_uses_effective_risk() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Invoice untriaged", "", None, "[]");
        insert_email(&conn, 2, 1, "b@x.io", "Invoice safe", "", None, "[]");
        insert_email(&conn, 3, 1, "c@x.io", "Invoice danger", "", None, "[]");
        insert_email(&conn, 4, 1, "d@x.io", "Invoice user-flagged", "", None, "[]");
        for (email_id, risk, user_risk) in [(2, "safe", None), (3, "danger", None), (4, "safe", Some("danger"))] {
            conn.execute(
                "INSERT INTO triage_results (email_id, type, priority, summary, risk, signals_json, risk_explanation, model_version, user_risk)
                 VALUES (?1, 'other', 'low', 's', ?2, '[]', 'r', 'v', ?3)",
                params![email_id, risk, user_risk],
            )
            .unwrap();
        }
        let mut hits = ids(&conn, "invoice", None, None, true);
        hits.sort();
        assert_eq!(hits, vec![3, 4]);
        assert_eq!(ids(&conn, "invoice", None, None, false).len(), 4);
    }

    #[test]
    fn subject_hits_outrank_body_hits() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Weekly digest", "the invoice is in the body", None, "[]");
        insert_email(&conn, 2, 1, "b@x.io", "Invoice", "nothing here", None, "[]");
        assert_eq!(ids(&conn, "invoice", None, None, false), vec![2, 1]);
    }

    #[test]
    fn garbage_queries_never_error() {
        let conn = db();
        insert_email(&conn, 1, 1, "a@x.io", "Invoice", "", None, "[]");
        for raw in ["invoice AND", "NEAR(", "\"unbalanced", "a*b", "(invoice)", "invoice:subject", "-invoice", "^invoice"] {
            if let Some(expr) = sanitize_query(raw) {
                keyword_search(&conn, &expr, None, None, false, 50).unwrap_or_else(|e| panic!("{raw:?} -> {expr:?}: {e}"));
            }
        }
    }
}
