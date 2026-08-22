#[cfg(test)]
use super::grammar::{REPLY_GBNF, REPLY_GRAMMAR_ROOT, SUMMARY_GBNF, SUMMARY_GRAMMAR_ROOT, TRIAGE_GBNF, TRIAGE_GRAMMAR_ROOT};
use super::{GenerateRequest, ModelStatus};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use std::num::NonZeroU32;
use tauri::{AppHandle, Emitter, Manager};

const CONTEXT_SIZE: u32 = 4096;
const BATCH_CAPACITY: usize = 4096;

/// Runs entirely on its own OS thread for the process lifetime: loads the
/// model once, then services generation requests one at a time. llama.cpp's
/// backend/model/context types are not meant to hop across the tokio runtime,
/// so this deliberately uses `std::thread` + `blocking_recv`, not
/// `tokio::task::spawn_blocking`.
pub(crate) fn run(
    app: AppHandle,
    model_file: std::path::PathBuf,
    mut rx: tokio::sync::mpsc::Receiver<GenerateRequest>,
) {
    set_status(&app, ModelStatus::Loading { progress_pct: None });

    let backend = match super::shared_backend() {
        Ok(b) => b,
        Err(e) => {
            set_status(&app, ModelStatus::Failed { message: e });
            return;
        }
    };

    let model_params = LlamaModelParams::default();
    let model = match LlamaModel::load_from_file(&backend, &model_file, &model_params) {
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

    let ctx_size = NonZeroU32::new(CONTEXT_SIZE).expect("CONTEXT_SIZE is nonzero");
    // n_batch must cover the longest prompt we ever submit in one decode call: llama.cpp
    // aborts the whole process (GGML_ASSERT) if a batch exceeds it, so it is set to the
    // full context size and `generate_one` additionally refuses over-long prompts.
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(Some(ctx_size))
        .with_n_batch(CONTEXT_SIZE);
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
        let result = generate_one(
            &model,
            &mut ctx,
            &req.prompt,
            req.max_tokens,
            &req.grammar,
            &req.grammar_root,
        );
        let _ = req.respond_to.send(result);
    }
}

fn generate_one(
    model: &LlamaModel,
    ctx: &mut LlamaContext,
    prompt: &str,
    max_tokens: i32,
    grammar: &str,
    grammar_root: &str,
) -> Result<String, String> {
    // The context (and its KV cache) is reused across requests. Each prompt is
    // positioned from 0, so stale entries from the previous request must be dropped
    // first or llama_decode rejects the batch ("inconsistent sequence positions").
    ctx.clear_kv_cache();
    let tokens = model
        .str_to_token(prompt, AddBos::Always)
        .map_err(|e| e.to_string())?;
    if tokens.is_empty() {
        return Err("prompt tokenized to zero tokens".to_string());
    }
    let reply_budget = max_tokens.max(0) as usize;
    if tokens.len() > BATCH_CAPACITY || tokens.len() + reply_budget > CONTEXT_SIZE as usize {
        // Returning an error here is essential: submitting this batch would trip a GGML
        // assertion inside llama.cpp and take the entire app down.
        return Err(format!(
            "email is too long for the on-device model ({} prompt tokens + {} reply tokens exceeds the {}-token context)",
            tokens.len(),
            reply_budget,
            CONTEXT_SIZE
        ));
    }

    let mut batch = LlamaBatch::new(BATCH_CAPACITY, 1);
    let last_index = tokens.len() - 1;
    for (i, token) in tokens.into_iter().enumerate() {
        let is_last = i == last_index;
        batch
            .add(token, i as i32, &[0], is_last)
            .map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| e.to_string())?;

    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::grammar(model, grammar, grammar_root).map_err(|e| e.to_string())?,
        LlamaSampler::dist(1234),
        LlamaSampler::greedy(),
    ]);

    let mut n_cur = batch.n_tokens();
    let mut output = String::new();
    let mut decoder = encoding_rs::UTF_8.new_decoder();

    for _ in 0..max_tokens {
        // `LlamaSampler::sample` already accepts the token into the chain (advancing the
        // grammar state). Accepting it a second time here would advance the grammar twice
        // per token and abort llama.cpp with `GGML_ASSERT(!stacks.empty())`.
        let token = sampler.sample(ctx, batch.n_tokens() - 1);
        if model.is_eog_token(token) {
            break;
        }
        let piece = model
            .token_to_piece(token, &mut decoder, true, None)
            .map_err(|e| e.to_string())?;
        output.push_str(&piece);

        if n_cur as u32 >= CONTEXT_SIZE - 1 {
            break; // context full - stop rather than overflow the KV cache
        }
        batch.clear();
        batch.add(token, n_cur, &[0], true).map_err(|e| e.to_string())?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;
    }

    Ok(output)
}

fn set_status(app: &AppHandle, status: ModelStatus) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        *state.triage_model_status.lock().unwrap() = status.clone();
    }
    let _ = app.emit("triage-model-status", status);
}

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::triage::{build_reply_prompt, build_triage_prompt, PromptInput};

    /// End-to-end check against the real on-device model. Ignored by default because it
    /// needs the multi-GB GGUF file; run it by hand with:
    ///
    /// ```sh
    /// EMAIL_CLIENT_MODEL="$HOME/Library/Application Support/com.emailclient.app/models/gemma.gguf" \
    ///   cargo test --lib real_model -- --ignored --nocapture
    /// ```
    ///
    /// It generates for two *different* prompts on the *same* context, which is exactly
    /// what the worker does in production: this catches grammar-parse failures, the
    /// double-accept grammar abort, and stale-KV-cache decode failures in one go.
    #[test]
    #[ignore]
    fn real_model_generates_schema_json_for_consecutive_requests() {
        let path = std::env::var("EMAIL_CLIENT_MODEL")
            .expect("set EMAIL_CLIENT_MODEL to the path of a Gemma GGUF file");
        let backend = super::super::shared_backend().expect("backend");
        let model = LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default())
            .expect("model load");
        let ctx_size = NonZeroU32::new(CONTEXT_SIZE).unwrap();
        let mut ctx = model
            .new_context(&backend, LlamaContextParams::default().with_n_ctx(Some(ctx_size)))
            .expect("context");

        let inputs = [
            PromptInput {
                sender: "ZhengHao Fang <zhenghao@example.org>",
                to: "jeya@example.org",
                cc: "",
                subject: "Re: Tech Talk planning",
                body_text: "Hi Jeya, can you confirm whether the room is booked for Thursday 6pm? \
                            Also, do you want me to order pizza or should we do sandwiches? Thanks!",
                user_email: "jeya@example.org",
            },
            PromptInput {
                sender: "Security Team <support@paypa1-secure.com>",
                to: "jeya@example.org",
                cc: "",
                subject: "URGENT: your account will be suspended",
                body_text: "We detected unusual activity. Verify your identity within 24 hours by \
                            entering your password and card number at http://paypa1-secure.com/verify \
                            or your account will be permanently closed. Do not share this email.",
                user_email: "jeya@example.org",
            },
            // User is only CC'd on a reply addressed to someone else, with a long quoted
            // thread below - the model should call this fyi with no draft.
            PromptInput {
                sender: "ZhengHao Fang <zhenghao@example.org>",
                to: "James Li <james@partner.example>",
                cc: "jeya@example.org, active@example.org",
                subject: "Re: Tech Talk planning",
                body_text: "Hey James!\n\nA huge thank you to you and your team for the presentation. \
                            Would you be open to returning as a judge for Hack&Roll?\n\nBest regards,\nZhengHao\n\n\
                            On Thu, Aug 20, 2026 at 1:07 PM ZhengHao Fang <zhenghao@example.org>\nwrote:\n\n\
                            > Hi James,\n>\n> Sure! We've included them in our publicity message.\n>\n\
                            >> Two members from my team will also join me. Could you add their bio as well?\n\
                            >> We are also ok to be recorded.\n>>\n>> Bio: Weikun is an AI Engineer...\n>>\n\
                            >>> The event will be held at COM3 Seminar Room 12. Please arrive at around 6:50 PM.",
                user_email: "jeya@example.org",
            },
        ];

        for (i, input) in inputs.iter().enumerate() {
            let prompt = build_triage_prompt(input);
            let started = std::time::Instant::now();
            let out = generate_one(&model, &mut ctx, &prompt, 700, TRIAGE_GBNF, TRIAGE_GRAMMAR_ROOT)
                .unwrap_or_else(|e| panic!("request {i} failed: {e}"));
            eprintln!("--- request {i} ({:.1}s) ---\n{out}", started.elapsed().as_secs_f32());
            let v: serde_json::Value =
                serde_json::from_str(&out).unwrap_or_else(|e| panic!("request {i}: not JSON: {e}\n{out}"));
            for key in ["type", "priority", "summary", "risk", "signals", "risk_explanation", "action"] {
                assert!(v.get(key).is_some(), "request {i}: missing key {key}");
            }
        }

        // On-demand reply draft with the reply-only grammar (user was CC'd but wants to answer).
        let prompt = build_reply_prompt(&inputs[2]);
        let started = std::time::Instant::now();
        let out = generate_one(&model, &mut ctx, &prompt, 400, REPLY_GBNF, REPLY_GRAMMAR_ROOT)
            .expect("reply draft");
        eprintln!("--- reply draft ({:.1}s) ---\n{out}", started.elapsed().as_secs_f32());
        let v: serde_json::Value = serde_json::from_str(&out).expect("reply draft is JSON");
        let draft = v.get("draft_reply").and_then(|d| d.as_str()).expect("draft_reply string");
        assert!(!draft.trim().is_empty());
        eprintln!("--- normalized ---\n{}", crate::triage::normalize_draft(draft));

        // One-line summary of an earlier message (thread cards).
        let prompt = crate::triage::build_summary_prompt(
            "ZhengHao Fang <zhenghao@example.org>",
            "Hi James,\n\nThe event will be held at COM3 Seminar Room 12. Please arrive at around 6:50 PM. \
             If you need help navigating on the day, call me.\n\nSee you on Friday!\n\nBest regards,\nZhengHao",
        );
        let started = std::time::Instant::now();
        let out = generate_one(&model, &mut ctx, &prompt, 60, SUMMARY_GBNF, SUMMARY_GRAMMAR_ROOT).expect("summary");
        eprintln!("--- summary ({:.1}s) ---\n{out}", started.elapsed().as_secs_f32());
        let v: serde_json::Value = serde_json::from_str(&out).expect("summary is JSON");
        assert!(!v.get("summary").and_then(|s| s.as_str()).unwrap_or("").trim().is_empty());

        // Label suggestion constrained to the user's described labels (dynamic grammar).
        let labels = vec![
            ("Finance".to_string(), "Invoices, payments, bank details, anything about money owed or paid.".to_string()),
            ("Friday Hacks".to_string(), "Speaker outreach, venue bookings and logistics for the Friday Hacks talk series.".to_string()),
            ("Recruiting".to_string(), "Job applications, interviews, hiring.".to_string()),
        ];
        let prompt = crate::triage::build_label_prompt(&labels, &inputs[2]);
        let names: Vec<String> = labels.iter().map(|(n, _)| n.clone()).collect();
        let grammar = crate::triage::label_grammar(&names);
        let started = std::time::Instant::now();
        let out = generate_one(&model, &mut ctx, &prompt, 120, &grammar, "root").expect("labels");
        eprintln!("--- labels ({:.1}s) ---\n{out}", started.elapsed().as_secs_f32());
        let v: serde_json::Value = serde_json::from_str(&out).expect("labels is JSON");
        let chosen: Vec<String> = v["labels"].as_array().unwrap().iter().filter_map(|x| x.as_str().map(String::from)).collect();
        assert!(chosen.iter().all(|c| names.contains(c)), "grammar must restrict to known names: {chosen:?}");
    }
}
