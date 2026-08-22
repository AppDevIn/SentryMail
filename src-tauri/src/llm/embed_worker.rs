use super::{EmbedRequest, ModelStatus};
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use std::num::NonZeroU32;
use tauri::{AppHandle, Emitter, Manager};

const EMBED_CONTEXT_SIZE: u32 = 2048;
const BATCH_CAPACITY: usize = 2048;

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

    let ctx_size = NonZeroU32::new(EMBED_CONTEXT_SIZE).expect("EMBED_CONTEXT_SIZE is nonzero");
    let ctx_params = LlamaContextParams::default()
        .with_embeddings(true)
        .with_pooling_type(LlamaPoolingType::Mean)
        .with_n_ctx(Some(ctx_size));
    let mut ctx = match model.new_context(&backend, ctx_params) {
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
            context_size: ctx_size.get(),
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
    let tokens = model
        .str_to_token(text, AddBos::Always)
        .map_err(|e| e.to_string())?;
    if tokens.is_empty() {
        return Err("text tokenized to zero tokens".to_string());
    }
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
