# email-client

A desktop email client (Tauri + React + Rust) that consolidates multiple Gmail accounts
into one inbox and triages every email on-device with a local Gemma model: a plain-language
classification, a scam/fraud risk check, and (where appropriate) a draft reply - all
without any email content ever leaving your machine.

See [SETUP.md](./SETUP.md) for build prerequisites, the Google OAuth client file, and the
local Gemma model file you need to provide before running the app.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
