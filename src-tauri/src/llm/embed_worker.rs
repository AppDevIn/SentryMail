use super::{EmbedRequest, ModelStatus};
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use std::num::NonZeroU32;
use tauri::{AppHandle, Emitter, Manager};

const EMBED_CONTEXT_SIZE: u32 = 2048;
/// Longest token sequence ever handed to `decode` in one batch. Derived from the context
/// size so the context's n_batch/n_ubatch and the guard in `embed_one` cannot drift apart.
const BATCH_CAPACITY: usize = EMBED_CONTEXT_SIZE as usize;

/// Context parameters for the embedding model, shared by `run` and the real-model test.
///
/// EmbeddingGemma is an encoder model, so llama.cpp routes `decode` to `encode()`, which
/// requires `n_ubatch >= n_tokens` for the whole batch. Exceeding it is a `GGML_ASSERT`
/// that aborts the entire process (not a catchable error), and the defaults (512) are far
/// below `BATCH_CAPACITY`. Setting both to the context size, plus the token cap in
/// `embed_one`, guarantees no batch can ever be larger than n_ubatch.
fn embed_context_params() -> LlamaContextParams {
    let ctx_size = NonZeroU32::new(EMBED_CONTEXT_SIZE).expect("EMBED_CONTEXT_SIZE is nonzero");
    LlamaContextParams::default()
        .with_embeddings(true)
        .with_pooling_type(LlamaPoolingType::Mean)
        .with_n_ctx(Some(ctx_size))
        .with_n_batch(EMBED_CONTEXT_SIZE)
        .with_n_ubatch(EMBED_CONTEXT_SIZE)
}

/// Runs on a dedicated OS thread, mirroring `worker.rs`'s pattern exactly - but this is a
/// fundamentally different decode path: no `LlamaSampler`, no grammar, no token-generation
/// loop. A single decode produces a pooled embedding vector directly.
pub(crate) fn run(
    app: AppHandle,
    model_file: std::path::PathBuf,
    mut rx: tokio::sync::mpsc::Receiver<EmbedRequest>,
) {
    set_status(&app, ModelStatus::Loading { progress_pct: None });

    let backend = match super::shared_backend() {
        Ok(b) => b,
        Err(e) => {
            set_status(&app, ModelStatus::Failed { message: e });
            return;
        }
    };

    let model = match LlamaModel::load_from_file(&backend, &model_file, &LlamaModelParams::default()) {
        Ok(m) => m,
        Err(e) => {
            set_status(
                &app,
                ModelStatus::Failed {
                    message: format!("failed to load {}: {e}", model_file.display()),
                },
            );
            return;
        }
    };

    let mut ctx = match model.new_context(&backend, embed_context_params()) {
        Ok(c) => c,
        Err(e) => {
            set_status(
                &app,
                ModelStatus::Failed {
                    message: e.to_string(),
                },
            );
            return;
        }
    };

    set_status(
        &app,
        ModelStatus::Ready {
            context_size: EMBED_CONTEXT_SIZE,
        },
    );

    while let Some(req) = rx.blocking_recv() {
        let result = embed_one(&model, &mut ctx, &req.text);
        let _ = req.respond_to.send(result);
    }
}

fn embed_one(model: &LlamaModel, ctx: &mut LlamaContext, text: &str) -> Result<Vec<f32>, String> {
    // Same reuse pattern as the triage worker: reset the KV cache so this text's
    // tokens (positioned from 0) don't collide with the previous request's.
    ctx.clear_kv_cache();
    let mut tokens = model
        .str_to_token(text, AddBos::Always)
        .map_err(|e| e.to_string())?;
    if tokens.is_empty() {
        return Err("text tokenized to zero tokens".to_string());
    }
    // `prefix::MAX_EMBED_CHARS` bounds the text, but worst-case tokenisation (CJK, URLs,
    // base64-ish runs) can still exceed the batch. Embed the prefix rather than fail:
    // a truncated embedding is far more useful than no embedding, and going past
    // n_ubatch would abort the process (see `embed_context_params`).
    tokens.truncate(BATCH_CAPACITY);
    if tokens.len() > BATCH_CAPACITY {
        return Err(format!(
            "text too long for embedding context ({} tokens > {BATCH_CAPACITY})",
            tokens.len()
        ));
    }

    let mut batch = LlamaBatch::new(BATCH_CAPACITY, 1);
    for (i, token) in tokens.into_iter().enumerate() {
        // logits requested at every position (not just the last), matching llama.cpp's
        // own embedding example convention for mean-pooled output.
        batch
            .add(token, i as i32, &[0], true)
            .map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| e.to_string())?;

    Ok(ctx.embeddings_seq_ith(0).map_err(|e| e.to_string())?.to_vec())
}

fn set_status(app: &AppHandle, status: ModelStatus) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        *state.embed_model_status.lock().unwrap() = status.clone();
    }
    let _ = app.emit("embed-model-status", status);
}

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::search::{prefix, similarity::cosine_similarity};

    /// End-to-end check against the real EmbeddingGemma GGUF. Ignored by default because
    /// it needs the model file; run it by hand with:
    ///
    /// ```sh
    /// EMAIL_CLIENT_EMBED_MODEL="$HOME/Library/Application Support/com.emailclient.app/models/embeddinggemma.gguf" \
    ///   cargo test --lib real_embedding -- --ignored --nocapture
    /// ```
    ///
    /// Embeds three texts consecutively on the *same* context, exactly as the worker does
    /// in production (KV reset between requests), and checks the vectors are sane and
    /// that a query about unpaid invoices lands closer to the invoice email than to the
    /// pizza one.
    #[test]
    #[ignore]
    fn real_embedding_model_ranks_related_document_higher_for_consecutive_requests() {
        let path = std::env::var("EMAIL_CLIENT_EMBED_MODEL")
            .expect("set EMAIL_CLIENT_EMBED_MODEL to the path of an EmbeddingGemma GGUF file");
        let backend = super::super::shared_backend().expect("backend");
        let model = LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default())
            .expect("model load");
        let mut ctx = model.new_context(&backend, embed_context_params()).expect("context");
        println!("context: n_ctx = {}, n_batch = {}, n_ubatch = {}", ctx.n_ctx(), ctx.n_batch(), ctx.n_ubatch());
        assert_eq!(ctx.n_ubatch() as usize, BATCH_CAPACITY, "encoder needs n_ubatch >= batch capacity");
        assert!(ctx.n_batch() >= ctx.n_ubatch());

        let doc_a = prefix::document_text(
            Some("Invoice 4471 remittance"),
            "Please pay invoice 4471 using the new bank account by Friday.",
        );
        let doc_b = prefix::document_text(
            Some("Tech talk pizza"),
            "Should we order pizza or sandwiches for Thursday's talk?",
        );
        let query = prefix::query_text("unpaid invoice bank details");

        let mut vectors = Vec::new();
        for (name, text) in [("doc A", &doc_a), ("doc B", &doc_b), ("query", &query)] {
            let started = std::time::Instant::now();
            let v = embed_one(&model, &mut ctx, text).unwrap_or_else(|e| panic!("{name} failed: {e}"));
            println!("{name}: {} dims in {:.2}s", v.len(), started.elapsed().as_secs_f32());
            assert_eq!(v.len(), 768, "{name}: expected 768 dims");
            assert!(v.iter().all(|x| x.is_finite()), "{name}: non-finite value in embedding");
            vectors.push(v);
        }

        let cos_a = cosine_similarity(&vectors[2], &vectors[0]);
        let cos_b = cosine_similarity(&vectors[2], &vectors[1]);
        println!("cosine(query, doc A invoice) = {cos_a:.4}");
        println!("cosine(query, doc B pizza)   = {cos_b:.4}");
        assert!(cos_a > cos_b, "invoice query should be closer to the invoice email ({cos_a} vs {cos_b})");

        // Long documents: one between the old default n_ubatch (512 tokens) and the batch
        // capacity (must not abort the process), and one past the capacity (must still
        // embed, from its prefix, via token truncation).
        let sentence = "Please pay the invoice by Friday using the new bank account. ";
        let long_body = sentence.repeat(110); // ~1200 words
        let very_long_body: String = (0..4000).map(|i| format!("remittance{i}")).collect::<Vec<_>>().join(" ");
        let token_count = |body: &str| model.str_to_token(body, AddBos::Always).expect("tokenize").len();
        let long_tokens = token_count(&long_body);
        let very_long_tokens = token_count(&very_long_body);
        assert!(
            long_tokens > 512 && long_tokens <= BATCH_CAPACITY,
            "long doc should sit between the default n_ubatch and the cap, got {long_tokens}"
        );
        assert!(very_long_tokens > BATCH_CAPACITY, "very long doc should exceed the cap, got {very_long_tokens}");
        for (name, body, raw_tokens) in [("long doc (1200 words)", &long_body, long_tokens), ("very long doc (4000 words)", &very_long_body, very_long_tokens)] {
            let text = prefix::document_text(Some("Long invoice thread"), body);
            let started = std::time::Instant::now();
            let v = embed_one(&model, &mut ctx, &text).unwrap_or_else(|e| panic!("{name} failed: {e}"));
            println!(
                "{name}: {raw_tokens} raw tokens (cap {BATCH_CAPACITY}) -> {} dims in {:.2}s",
                v.len(),
                started.elapsed().as_secs_f32()
            );
            assert_eq!(v.len(), 768, "{name}: expected 768 dims");
            assert!(v.iter().all(|x| x.is_finite()), "{name}: non-finite value in embedding");
        }
    }
}
