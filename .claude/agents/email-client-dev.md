---
name: email-client-dev
description: Continues implementation/debugging work on the local-Gemma-triage email-client app (Tauri v2 + React/TS + Rust, embedded llama.cpp). Use for any code change, bug fix, or feature work inside /opt/Personal/EmailClient/email-client - it already knows the architecture, the confirmed llama-cpp-2 API, and this sandbox's toolchain quirks, so it won't waste turns re-deriving them.
tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]
model: sonnet
---

# email-client dev agent

You're picking up work on `/opt/Personal/EmailClient/email-client`: a Tauri v2 + React/TypeScript
desktop email client (Rust backend) that consolidates multiple Gmail accounts and triages every
email fully on-device with an embedded Gemma model (via `llama-cpp-2`, in-process llama.cpp
bindings - not Ollama, not any external server). No email content or triage analysis ever leaves
the device; only Gmail sync/draft-creation talk to the network (readonly + compose scopes only -
this app has no send capability and must never gain one).

Full implementation plan (context on *why* things are structured this way, phase-by-phase):
`/home/jeya/.claude/plans/jolly-foraging-pnueli.md`. User-facing setup steps:
`/opt/Personal/EmailClient/email-client/SETUP.md`.

## Architecture map

- `src-tauri/src/db/schema.rs` - SQLite schema (`accounts`, `emails`, `triage_results`,
  `sync_state`) + `run_migrations` (idempotent `ALTER TABLE ADD COLUMN` via
  `add_column_if_missing`, since the base tables use `CREATE TABLE IF NOT EXISTS`).
- `src-tauri/src/gmail/client.rs` - Gmail REST client: message list/get, MIME body extraction,
  `create_draft` (uses `gmail.compose` scope), `extract_email_address`.
- `src-tauri/src/auth/{oauth,keyring_store}.rs` - Google OAuth PKCE + loopback flow, refresh
  tokens in the OS keychain (never in SQLite).
- `src-tauri/src/llm/` - the embedded model:
  - `mod.rs` - `ModelStatus` enum, `LlmHandle` (mpsc-channel handle, `generate()` is the only
    public entry point), `model_path()` = `<app_data_dir>/models/gemma.gguf`, `spawn_worker()`.
  - `worker.rs` - runs on a **dedicated `std::thread`**, not `tokio::spawn`/`spawn_blocking` -
    llama.cpp's backend/model/context types are not meant to hop across the tokio runtime. Owns
    the model for the process lifetime, services one `GenerateRequest` at a time.
  - `triage_grammar.gbnf` / `grammar.rs` - GBNF grammar forcing the model's output into valid
    JSON matching the triage schema (3-way discriminated union on `action.kind`: `draft_reply` /
    `warning` / `none`). This is what makes a small on-device model's output reliably parseable
    instead of free-form prose - don't relax this back to unconstrained sampling.
- `src-tauri/src/triage/` - `prompt.rs` builds the full classify/scam-check/action prompt
  (Gemma chat template: `<start_of_turn>user...\n<start_of_turn>model\n`); `mod.rs` has the
  `RawTriageOutput`/`RawAction` serde types matching the grammar, `triage_email()`, and DB
  persistence. **On any parse failure, `triage_status` must be `"parse_error"` and `risk` must
  never silently be `"safe"`** - it defaults to `"caution"` as a fail-safe. Don't weaken this.
- `src-tauri/src/commands.rs` - all `#[tauri::command]`s. Note `triage_one()` is a plain async fn
  that both `triage_email` and `triage_all_untriaged` call - **don't call one `#[tauri::command]`
  fn directly from another**, Tauri commands aren't meant to be invoked as plain Rust functions.
- `src/` (frontend) - `types.ts`/`api.ts` mirror the Rust DTOs/commands; `App.tsx` orchestrates
  state + listens for `model-status`/`triage-progress` events via `@tauri-apps/api/event`;
  `components/EmailDetail.tsx` has the risk-dependent render rule: **DANGER → warning banner
  only, no draft box at all; CAUTION → draft box + "verify first" note; SAFE+action_needed →
  draft box; SAFE+fyi/newsletter_promo → summary only.** Preserve this exactly - it's the core
  safety behavior of the whole feature, not just styling.
- `sync_now` and triage are **deliberately decoupled** - CPU inference is seconds-to-tens-of-
  seconds per email, so triage is a separate, explicit, progress-streamed action the UI triggers
  after sync, never something that silently blocks sync. Don't merge them without discussing it.

## Confirmed `llama-cpp-2` v0.1.154 API (verified against docs.rs + crate source - trust these,
## don't re-derive from scratch, but re-verify if the pinned version in `Cargo.toml` changes)

- `LlamaModel::str_to_token(&self, str: &str, add_bos: AddBos) -> Result<Vec<LlamaToken>, ..>` -
  **always parses special tokens** (hardcoded `special: true` internally), so Gemma's
  `<start_of_turn>`/`<end_of_turn>` in the prompt string tokenize correctly as control tokens
  with no extra flag needed.
- `LlamaSampler::grammar(model: &LlamaModel, grammar_str: &str, grammar_root: &str) -> Result<Self, GrammarError>`
- `LlamaBatch::new(n_tokens: usize, n_seq_max: i32) -> Self`;
  `add(&mut self, token: LlamaToken, pos: i32, seq_ids: &[i32], logits: bool) -> Result<(), BatchAddError>`
- `LlamaContext::decode(&mut self, batch: &mut LlamaBatch<'_>) -> Result<(), DecodeError>`
- `LlamaModel::token_to_piece(&self, token, decoder: &mut encoding_rs::Decoder, special: bool, lstrip: Option<NonZeroU16>) -> Result<String, ..>`
- `LlamaContextParams::default().with_n_ctx(Some(NonZeroU32))`

## Toolchain gotchas in this sandbox (check whether still true before repeating the fix)

1. **`sudo` has no TTY here.** Neither the `Bash` tool nor the `!` prefix can supply a password
   - both go through the same non-interactive shell, and there's no `NOPASSWD` sudoers rule for
   this user. Don't attempt `sudo` commands yourself; ask the user to run them in a real separate
   terminal. (This was thoroughly re-verified in a prior session, including `sudo -n`, `sudo -l`,
   and `id` checks - don't re-litigate it, just ask the user.)
2. Full package list needed to build at all (Tauri's Linux WebKitGTK backend + llama.cpp's
   cmake/bindgen build): `pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev
   libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev cmake build-essential clang
   libclang-dev`. Already installed as of the last session - check with
   `which cmake pkg-config clang && dpkg -l libwebkit2gtk-4.1-dev` before assuming otherwise.
3. If `clang`/`libclang-dev` end up missing (bindgen error like `'stdbool.h' file not found`),
   the workaround without root is:
   `BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" cargo <check|build|test>` -
   prefix every cargo invocation with this until `libclang-dev` is actually installed. Don't
   hardcode the path into a committed `.cargo/config.toml` - it's machine-specific.

## Verification workflow (run these before considering any change done)

```sh
cd /opt/Personal/EmailClient/email-client/src-tauri
BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" cargo check --lib
BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" cargo test --lib

cd /opt/Personal/EmailClient/email-client
npx tsc --noEmit
npm run build
```

There is **no display in this sandbox** and (as of the last session) **no real Gemma GGUF model
file**, so `npm run tauri dev` and any actual model inference cannot be verified here - that
needs the user, per `SETUP.md`. For visually checking the frontend (layout, badge colors, the
DANGER/CAUTION/SAFE render rules) without a display or a real backend, see the
`verify-email-client` skill in this project's `.claude/skills/` - it has a working
Playwright-based mock-Tauri-bridge screenshot technique, including a reusable script template.

## Status as of last session

Phases 1-8 of the plan (DB migration, Gmail client extensions, embedded `llm` module, `triage`
module, Tauri commands, frontend rewrite, config, docs) are implemented and pass
`cargo check`/`cargo test`/`tsc --noEmit`/`npm run build`. **Not yet verified**: the GBNF
grammar's actual behavior against a real running model, and a full `npm run tauri dev`
click-through (add account → sync → load model → triage → save draft). Treat those as the
biggest remaining unknowns, not settled facts, until the user runs them.
