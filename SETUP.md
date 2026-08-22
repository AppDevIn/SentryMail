# Setup

This app never sends your email content anywhere for analysis. Gmail sync and draft
creation talk to Google's API using the `gmail.modify` scope (read, mark read/unread, drafts -
never permanent deletion). Email triage (classification,
scam/fraud check, draft suggestions) and semantic search both run entirely on-device via
embedded local Gemma models - nothing about the content or analysis of your email leaves
your machine. The one deliberate exception is one-click unsubscribe: when a newsletter
only offers a `mailto:` unsubscribe address (no safe HTTP link), the app sends a short,
explicit unsubscribe email on your behalf - only after you confirm, and only for that one
purpose. See `src-tauri/src/auth/oauth.rs` for details.

## 1. Build toolchain (Linux)

Tauri's Linux backend links against system WebKitGTK, and the embedded Gemma model
(via `llama-cpp-2`) compiles llama.cpp's C++ sources with `cmake`. On Debian/Ubuntu:

```sh
sudo apt update
sudo apt install -y pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
  cmake build-essential clang libclang-dev
```

`clang`/`libclang-dev` are needed by `bindgen` (used by the `llama-cpp-sys-2` crate) to
generate FFI bindings against llama.cpp's C headers. Without the full `clang` package,
`libclang` may fail to find your compiler's builtin headers (e.g. a `'stdbool.h' file not
found` error from bindgen) - if that happens, either install `clang`/`libclang-dev`, or
work around it for one build via:
`BINDGEN_EXTRA_CLANG_ARGS="-I/usr/lib/gcc/<arch>/<version>/include" cargo build` (path
varies by machine - find yours with `gcc -print-file-name=include`).

(macOS/Windows: see the [Tauri prerequisites docs](https://tauri.app/start/prerequisites/)
for the equivalent toolchain; `cmake` is still required everywhere for the embedded model.)

## 2. Google OAuth client (for Gmail sync)

Create a Google Cloud OAuth 2.0 **Desktop app** client (or get the team's existing one -
your Google account must be listed as a **Test user** on its consent screen while it is in
Testing mode). The app reads the credentials from, in order:

1. `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` environment variables
2. `<app_config_dir>/google_oauth_client.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```

**Recommended: 1Password + direnv** (no secret files on disk, shareable via a team vault):

```sh
brew install --cask 1password-cli   # then 1Password app > Settings > Developer > Integrate with 1Password CLI
brew install direnv jq              # add `eval "$(direnv hook zsh)"` to ~/.zshrc if not present
scripts/op-store-google-oauth.sh ~/Downloads/client_secret_*.json [vault]   # one-time, creates the item
direnv allow                        # in the repo root; .envrc reads the item via op://
npm run tauri dev
```

The 1Password item is `SentryMail Google OAuth` in vault `Private` by default; override with
`SENTRYMAIL_OP_VAULT` / `SENTRYMAIL_OP_ITEM` (e.g. in `~/.zshrc` or a gitignored
`.envrc.local`). If a teammate already created the item in a shared vault, skip the
script and just set `SENTRYMAIL_OP_VAULT` to that vault.

## 3. Local Gemma model file

Download a Gemma instruction-tuned model in **GGUF** format, quantized for CPU inference,
and place it at `<app_data_dir>/models/gemma.gguf`.

- Recommended: **Gemma 4 E4B-it**, QAT q4_0 quantization - Google publishes this directly:
  [`google/gemma-4-E4B-it-qat-q4_0-gguf`](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf)
  on Hugging Face. The "E" (elastic/efficient) sizes are what Google specifically describes
  as built for on-device use, unlike the 12B/26B/31B tier aimed at full workstations.
- Slower machine or less RAM: **Gemma 4 E2B-it** (~5B), quantized GGUF from a community
  conversion (e.g. an `unsloth/gemma-4-E2B-it-*-GGUF` repo, if/when published) if Google
  hasn't shipped an official GGUF for that size yet - check Hugging Face for the current
  state, since GGUF conversions for new releases show up quickly but aren't always
  simultaneous with the model announcement.
- Note: this is Gemma's **current (4th) generation** as of this writing - Gemma 2/3 GGUF
  files still work with this app (same `llama-cpp-2` backend) if you already have one, but
  prefer Gemma 4 for a new setup. Double check the model card for the exact chat template
  before assuming it's unchanged from earlier Gemma generations.
  This already bit us once: **Gemma 4 uses `<|turn>` / `<turn|>`**, while Gemma 2/3 used
  `<start_of_turn>` / `<end_of_turn>`. The markers are the `TURN_START`/`TURN_END` consts at
  the top of `src-tauri/src/triage/prompt.rs` - switch them if you use a Gemma 2/3 GGUF.
  Check the model's own `chat_template.jinja`/`tokenizer.json`, not the docs.

`<app_data_dir>` on Linux is typically `~/.local/share/com.emailclient.app/`; on macOS,
`~/Library/Application Support/com.emailclient.app/`; on Windows,
`%APPDATA%\com.emailclient.app\`. The `models/` folder isn't created automatically until
you place the file there.

The app never downloads a model automatically - this is a deliberate one-time manual step,
same as the OAuth client file above.

## 3b. Local EmbeddingGemma model file (optional, for semantic search)

Semantic search is independent of triage - either feature works without the other's model
file present. Download the EmbeddingGemma GGUF conversion and place it at
`<app_data_dir>/models/embeddinggemma.gguf`:

- [`ggml-org/embeddinggemma-300M-GGUF`](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF)
  on Hugging Face - the llama.cpp maintainers' own conversion. Google has published
  EmbeddingGemma only as safetensors, not an official GGUF, so this community conversion
  from the closest-to-canonical org is the recommended source.
- 308M params, 768-dimensional mean-pooled embeddings. No Matryoshka truncation is used -
  at this app's realistic scale (hundreds to low thousands of emails), full 768-dim
  brute-force cosine search in Rust is sub-millisecond, so no vector index is needed.
- Any GGUF quantization in that repo is fine; the model is small enough that quant choice
  matters far less here than for the triage model.

## 4. Run it

```sh
npm install
npm run tauri dev
```

In the app: **Add account** (opens your browser for Google sign-in) → **Sync now** →
**Load model** (first load can take a while) → **Triage new emails**. Optionally, also
**Load search model** → **Index new emails** → use the search box to search your inbox by
meaning rather than exact keywords. Emails with a `List-Unsubscribe` header show an
**Unsubscribe** control in the detail pane.
