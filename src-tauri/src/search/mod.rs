pub mod fusion;
pub mod keyword;
pub mod prefix;
pub mod similarity;

use crate::llm::EmbedHandle;
use rusqlite::{params, Connection};
use std::sync::Mutex;

pub const MODEL_VERSION: &str = "embeddinggemma-300m-v1";

/// Reciprocal Rank Fusion constant (ADR 0003).
pub const RRF_K: u32 = 60;
/// How many candidates each ranking source contributes to fusion (ADR 0003).
pub const CANDIDATES_PER_SOURCE: u32 = 50;
/// Semantic candidates below this cosine similarity are dropped before fusion (ADR 0006).
pub const MIN_COSINE: f32 = 0.25;
/// Hard cap on results returned by the `search` command (ADR 0006).
pub const RESULT_CAP: u32 = 50;

/// Embeds one email (subject + body, document-side prompt) and persists the vector.
pub async fn embed_email(db: &Mutex<Connection>, embed: &EmbedHandle, email_id: i64) -> Result<(), String> {
    let (subject, body) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT subject, body_text FROM emails WHERE id = ?1",
            params![email_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            },
        )
        .map_err(|e| e.to_string())?
    };

    let vector = embed.embed(prefix::document_text(Some(&subject), &body)).await?;
    persist_embedding(db, email_id, &vector)
}

fn persist_embedding(db: &Mutex<Connection>, email_id: i64, vector: &[f32]) -> Result<(), String> {
    let bytes = f32_vec_to_bytes(vector);
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO email_embeddings (email_id, embedding, dims, model_version, embedded_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(email_id) DO UPDATE SET
            embedding=excluded.embedding, dims=excluded.dims,
            model_version=excluded.model_version, embedded_at=datetime('now')",
        params![email_id, bytes, vector.len() as i64, MODEL_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub struct Candidate {
    pub email_id: i64,
    pub vector: Vec<f32>,
}

/// Loads stored embeddings (current `MODEL_VERSION` only) within the search scope
/// (ADR 0004: account, label, danger-only), for a brute-force similarity scan.
/// Reasonable at this app's realistic scale (hundreds to low thousands of emails) -
/// no vector index needed.
pub fn load_candidates(
    conn: &Connection,
    account_id: Option<i64>,
    label_id: Option<&str>,
    danger_only: bool,
) -> Result<Vec<Candidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ee.email_id, ee.embedding FROM email_embeddings ee
             JOIN emails e ON e.id = ee.email_id
             LEFT JOIN triage_results t ON t.email_id = e.id
             WHERE ee.model_version = ?1
               AND (?2 IS NULL OR e.account_id = ?2)
               AND (?3 IS NULL OR e.label_ids LIKE '%\"' || ?3 || '\"%')
               AND (?4 = 0 OR COALESCE(t.user_risk, t.risk) = 'danger')",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![MODEL_VERSION, account_id, label_id, danger_only], |row| {
            let email_id: i64 = row.get(0)?;
            let bytes: Vec<u8> = row.get(1)?;
            Ok(Candidate {
                email_id,
                vector: bytes_to_f32_vec(&bytes),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Scores candidates against the query vector, drops anything under `MIN_COSINE`, and
/// returns the best `limit` as `(email_id, cosine)` descending.
pub fn rank_semantic(candidates: &[Candidate], query_vec: &[f32], limit: u32) -> Vec<(i64, f32)> {
    let mut scored: Vec<(i64, f32)> = candidates
        .iter()
        .map(|c| (c.email_id, similarity::cosine_similarity(query_vec, &c.vector)))
        .filter(|(_, score)| *score >= MIN_COSINE)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit as usize);
    scored
}

fn f32_vec_to_bytes(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_bytes_round_trip() {
        let original = vec![0.0_f32, 1.5, -2.25, f32::MIN, f32::MAX];
        let bytes = f32_vec_to_bytes(&original);
        assert_eq!(bytes_to_f32_vec(&bytes), original);
    }

    #[test]
    fn rank_semantic_applies_floor_order_and_limit() {
        let candidates = vec![
            Candidate { email_id: 1, vector: vec![1.0, 0.0] },   // cosine 1.0
            Candidate { email_id: 2, vector: vec![0.0, 1.0] },   // cosine 0.0 -> dropped
            Candidate { email_id: 3, vector: vec![1.0, 1.0] },   // cosine ~0.71
            Candidate { email_id: 4, vector: vec![1.0, 0.5] },   // cosine ~0.89
        ];
        let ranked = rank_semantic(&candidates, &[1.0, 0.0], 10);
        assert_eq!(ranked.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 4, 3]);
        assert_eq!(rank_semantic(&candidates, &[1.0, 0.0], 2).len(), 2);
    }

    #[test]
    fn load_candidates_scopes_by_model_version_account_label_and_danger() {
        use crate::db::schema::run_migrations;
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn.execute("INSERT INTO accounts (id, email_address) VALUES (1, 'a@x.io')", []).unwrap();
        conn.execute("INSERT INTO accounts (id, email_address) VALUES (2, 'b@x.io')", []).unwrap();
        for (id, account, labels) in [(1, 1, "[\"Label_1\"]"), (2, 2, "[]"), (3, 1, "[]")] {
            conn.execute(
                "INSERT INTO emails (id, account_id, gmail_message_id, gmail_thread_id, sender, received_at, label_ids)
                 VALUES (?1, ?2, 'm' || ?1, 't' || ?1, 's@x.io', '2026-01-01T00:00:00Z', ?3)",
                params![id, account, labels],
            )
            .unwrap();
        }
        let bytes = f32_vec_to_bytes(&[1.0, 0.0]);
        for (id, version) in [(1, MODEL_VERSION), (2, MODEL_VERSION), (3, "old-model")] {
            conn.execute(
                "INSERT INTO email_embeddings (email_id, embedding, dims, model_version) VALUES (?1, ?2, 2, ?3)",
                params![id, bytes, version],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO triage_results (email_id, type, priority, summary, risk, signals_json, risk_explanation, model_version)
             VALUES (2, 'other', 'low', 's', 'danger', '[]', 'r', 'v')",
            [],
        )
        .unwrap();
        let ids = |account: Option<i64>, label: Option<&str>, danger: bool| -> Vec<i64> {
            let mut v: Vec<i64> = load_candidates(&conn, account, label, danger).unwrap().iter().map(|c| c.email_id).collect();
            v.sort();
            v
        };
        assert_eq!(ids(None, None, false), vec![1, 2]); // 3 is an old model version
        assert_eq!(ids(Some(1), None, false), vec![1]);
        assert_eq!(ids(None, Some("Label_1"), false), vec![1]);
        assert_eq!(ids(None, None, true), vec![2]);
    }
}
