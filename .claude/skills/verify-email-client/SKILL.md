---
name: verify-email-client
description: Verify changes to the email-client app (Tauri v2 + React/TS + Rust) in a sandbox with no display and no real Gmail/Gemma model - runs Rust check/test and frontend type-check/build, and can screenshot the UI headlessly against mocked Tauri backend data. Use after editing anything under /opt/Personal/EmailClient/email-client.
---

# Verify email-client changes

This project (`/opt/Personal/EmailClient/email-client`) is a Tauri v2 desktop app. Most dev
sandboxes have no display and no real Gmail account/Gemma model file, so "run the app and look
at it" isn't available. This skill covers what actually can be verified, and how to still get a
real look at the UI when needed.

## 1. Rust backend

The embedded `llm` module depends on `llama-cpp-2`, which needs `cmake`/`clang`/`libclang-dev`
to build (see the `email-client-dev` agent in this project for the full toolchain list and the
`sudo`-has-no-TTY caveat in this sandbox). If those aren't installed yet, `cargo check` will fail
on the whole crate, not just `llm`/`triage` - that's expected, not a bug in unrelated code.

If `clang`/`libclang-dev` are missing, bindgen may fail with `'stdbool.h' file not found`. Work
around it without root:

```sh
cd /opt/Personal/EmailClient/email-client/src-tauri
BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" cargo check --lib
BINDGEN_EXTRA_CLANG_ARGS="-I$(gcc -print-file-name=include)" cargo test --lib
```

Once `clang libclang-dev` are actually installed, the env var is unnecessary but harmless to keep.

## 2. Frontend

```sh
cd /opt/Personal/EmailClient/email-client
npx tsc --noEmit
npm run build
```

## 3. Visual check of the UI (no display, no real backend)

The frontend is plain React/CSS underneath the Tauri webview, so you don't need the actual
desktop shell to see it render - a headless browser pointed at the Vite dev server works, as
long as you stub out the Tauri JS bridge (`window.__TAURI_INTERNALS__`) that
`@tauri-apps/api/core`'s `invoke()` and `@tauri-apps/api/event`'s `listen()` call into. Without
the stub, every `invoke()` call rejects and the UI shows nothing useful.

Steps:

1. Ensure a headless browser is available: `npx playwright install chromium` (downloads to
   `~/.cache/ms-playwright` if not already present; if `playwright` itself isn't an installed
   npm package anywhere reachable, `npm install playwright` in a scratch directory - don't add it
   to `email-client/package.json`, it's a dev-only verification tool, not an app dependency).
2. Start the Vite dev server in the background:
   `cd /opt/Personal/EmailClient/email-client && nohup npm run dev -- --port 1420 --strictPort > /tmp/vite-dev.log 2>&1 &`
   then poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:1420` until it's `200`.
3. Copy `screenshot-template.mjs` (next to this file) somewhere writable, edit the `accounts` /
   `emails` / `triage` fixture objects at the top to fit what you need to demonstrate, and run it
   with `node screenshot-template.mjs` (needs `playwright` resolvable from that directory).
4. **Always tell whoever you show these screenshots to that the data is fabricated fixture
   data, not real model output or a real inbox** - this technique proves the UI renders and
   behaves correctly (badge colors, the DANGER/CAUTION/SAFE layout rules), nothing more. It does
   not verify the Rust triage pipeline, a real Gmail account, or actual Gemma inference.
5. Kill the dev server when done: `pkill -f "vite --port 1420"`.

The mock only needs to answer whatever commands the screen you're testing actually calls -
extend the `switch` in `screenshot-template.mjs`'s `invoke` mock (e.g. add a case for
`sync_now` or `create_gmail_draft`) rather than writing a new harness from scratch.
