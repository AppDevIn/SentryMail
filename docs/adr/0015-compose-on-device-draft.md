# ADR 0015: Compose gets the on-device model too

- Status: accepted
- Date: 2026-08-22

## Context

Replies in the reading pane can be drafted and redrafted by the on-device Gemma model
(`draft_reply`, grammar-constrained to `{"draft_reply": ...}`), with an Instructions row for
guidance. The New message pane (ADR 0010) had no model integration at all: a user starting
a fresh email had to write every word, even though the same loaded model was idle.

## Decision

- **Compose gains the same Instructions row** as the reply panel, placed between Subject and
  the body: type what the email should say, press Enter (or "Write a draft") and the model
  writes the body. With text already in the body the action reads "Redraft" and the current
  body is sent along so "shorter" / "more formal" revise rather than restart.
- **A new command, `draft_message`**, takes the account, To/Cc, subject, instructions and the
  current body; there is no stored email and no risk verdict involved, so no DANGER check.
  It uses its own prompt (`build_compose_prompt`) and grammar (`COMPOSE_GBNF`) that return
  `{"subject", "body"}`.
- **The model may suggest a subject, never replace one.** A blank Subject is filled from the
  draft; a subject the user typed is kept verbatim (the prompt asks the model to repeat it and
  the Rust side ignores the model's value anyway).
- **Nothing the model writes is persisted.** The draft lands in the editor; the user edits
  and sends as before. Enter in the Instructions input is intercepted so it never submits
  the surrounding compose form (which would send).
- When the model is not loaded the row is disabled with an "Open settings" link, matching the
  reading pane's "Analysis is off" note.

## Consequences

- New Tauri command `draft_message(account_id, to, cc, subject, instructions, previous_body)`
  returning `ComposeDraft { subject, body }`; `api.draftMessage` on the frontend; `Compose`
  takes `modelReady`, `onOpenSettings` and `onDraftWithAi` props.
- The model needs at least one of instructions, subject or an existing body; with none it
  returns an error rather than inventing a topic.
- Prompt guidance asks the model to leave `[placeholders]` for facts it was not given rather
  than guessing dates, amounts or commitments.
