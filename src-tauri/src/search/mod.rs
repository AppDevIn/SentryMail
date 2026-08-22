pub mod prefix;
pub mod similarity;

use crate::llm::EmbedHandle;
use rusqlite::{params, Connection};
use std::sync::Mutex;

pub const MODEL_VERSION: &str = "embeddinggemma-300m-v1";

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

/// Loads all stored embeddings for the given account (or every account if `None`), for
/// a brute-force similarity scan in `semantic_search`. Reasonable at this app's realistic
/// scale (hundreds to low thousands of emails) - no vector index needed.
pub fn load_candidates(conn: &Connection, account_id: Option<i64>) -> Result<Vec<Candidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ee.email_id, ee.embedding FROM email_embeddings ee
             JOIN emails e ON e.id = ee.email_id
             WHERE (?1 IS NULL OR e.account_id = ?1)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], |row| {
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
}
