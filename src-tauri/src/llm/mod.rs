pub mod grammar;
mod embed_worker;
mod worker;

use llama_cpp_2::llama_backend::LlamaBackend;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, oneshot};

/// Process-wide, lazily-initialized llama.cpp backend. `LlamaBackend::init()` may only
/// succeed once per process (a second call errors `BackendAlreadyInitialized`), but
/// `LlamaBackend` is `Send + Sync`, so both the triage and embedding worker threads share
/// one instance from here instead of each calling `init()` themselves. `OnceLock::get_or_init`
/// safely handles concurrent first calls from both worker threads - the second blocks until
/// the first's initializer completes.
static BACKEND: OnceLock<Result<Arc<LlamaBackend>, String>> = OnceLock::new();

pub(crate) fn shared_backend() -> Result<Arc<LlamaBackend>, String> {
    BACKEND
        .get_or_init(|| LlamaBackend::init().map(Arc::new).map_err(|e| e.to_string()))
        .clone()
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ModelStatus {
    NotConfigured,
    NotLoaded,
    Loading { progress_pct: Option<u8> },
    Ready { context_size: u32 },
    Failed { message: String },
}

pub(crate) struct GenerateRequest {
    pub prompt: String,
    pub max_tokens: i32,
    /// GBNF grammar (and its root rule) that constrains the output.
    pub grammar: String,
    pub grammar_root: String,
    pub respond_to: oneshot::Sender<Result<String, String>>,
}

/// Cheap-to-clone handle to the model worker thread. Generation requests are
/// serialized through a channel since only one inference can run at a time
/// on the single owned `LlamaContext`.
#[derive(Clone)]
pub struct LlmHandle {
    tx: mpsc::Sender<GenerateRequest>,
}

impl LlmHandle {
    /// Generates triage JSON (the default grammar).
    pub async fn generate(&self, prompt: String, max_tokens: i32) -> Result<String, String> {
        self.generate_with(prompt, max_tokens, grammar::TRIAGE_GBNF, grammar::TRIAGE_GRAMMAR_ROOT)
            .await
    }

    /// Generates output constrained by an arbitrary grammar (e.g. a reply-only draft).
    pub async fn generate_with(
        &self,
        prompt: String,
        max_tokens: i32,
        grammar: impl Into<String>,
        grammar_root: impl Into<String>,
    ) -> Result<String, String> {
        let (respond_to, rx) = oneshot::channel();
        self.tx
            .send(GenerateRequest {
                prompt,
                max_tokens,
                grammar: grammar.into(),
                grammar_root: grammar_root.into(),
                respond_to,
            })
            .await
            .map_err(|_| "llm worker is not running".to_string())?;
        rx.await
            .map_err(|_| "llm worker dropped the response channel".to_string())?
    }
}

pub fn triage_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join("gemma.gguf"))
}

/// Spawns a dedicated OS thread that owns the llama.cpp model/context for the process
/// lifetime (these types are not Send/Sync-safe to move across the tokio runtime),
/// loads the model, and then services one `GenerateRequest` at a time from `rx`.
pub fn spawn_worker(app: AppHandle, model_file: PathBuf) -> LlmHandle {
    let (tx, rx) = mpsc::channel::<GenerateRequest>(8);
    std::thread::spawn(move || worker::run(app, model_file, rx));
    LlmHandle { tx }
}

pub(crate) struct EmbedRequest {
    pub text: String, // already prefixed as document- or query-form by the caller
    pub respond_to: oneshot::Sender<Result<Vec<f32>, String>>,
}

/// Cheap-to-clone handle to the embedding worker thread. Mirrors `LlmHandle` exactly,
/// but requests/returns a pooled embedding vector instead of generated text - there is
/// no sampler/grammar/token-generation loop involved on that side at all.
#[derive(Clone)]
pub struct EmbedHandle {
    tx: mpsc::Sender<EmbedRequest>,
}

impl EmbedHandle {
    pub async fn embed(&self, prefixed_text: String) -> Result<Vec<f32>, String> {
        let (respond_to, rx) = oneshot::channel();
        self.tx
            .send(EmbedRequest {
                text: prefixed_text,
                respond_to,
            })
            .await
            .map_err(|_| "embedding worker is not running".to_string())?;
        rx.await
            .map_err(|_| "embedding worker dropped the response channel".to_string())?
    }
}

pub fn embedding_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join("embeddinggemma.gguf"))
}

pub fn spawn_embed_worker(app: AppHandle, model_file: PathBuf) -> EmbedHandle {
    let (tx, rx) = mpsc::channel::<EmbedRequest>(8);
    std::thread::spawn(move || embed_worker::run(app, model_file, rx));
    EmbedHandle { tx }
}
