# ADR 0010: Archive, Flag and Compose join the action set; Forward does not (yet)

- Status: accepted
- Date: 2026-08-22

## Context

The reference design shows Archive, an Archive folder, a Flag action, a Flagged folder,
New message and Forward. The backend had none of these: mail could only be read, labelled,
marked read/done, given a user risk verdict, and replied to via a Gmail draft. The OAuth
scope (`gmail.modify`) already allows label changes, drafts and sending; `create_draft`
and `drafts/send` exist in the Gmail client (used for reply drafts and mailto unsubscribe).

## Decision

- **Archive** removes the `INBOX` label on the message's thread through Gmail modify and
  mirrors it locally. The sidebar gains an **Archive** folder (threads with no `INBOX`
  label). Inbox and label views exclude archived mail; search does not.
- **Flag** is not a new field. The reading-pane Flag action sets `user_risk = caution`
  (un-flag clears it back to null). The **Flagged** folder lists threads whose effective
  risk is `caution` or `danger`, the same predicate as the existing Flagged filter. The
  filter stays in the list header; the folder is the same view one click from the sidebar.
- **New message** opens a compose form in the reading pane (To, Cc, Subject, body).
  **Send** creates the draft and sends it via the existing `drafts/send` path. Replies get
  the same Send button; "save as Gmail draft" is no longer the primary reply action.
- **Forward** is deferred. The reference footer shows it, but shipping a dead control is
  worse than omitting it; the footer is Reply · Reply all until forward drafts exist.

## Consequences

- New commands: `archive_thread(email_id, archived)`, `send_message(account_id, to, cc,
  subject, body)`; `create_gmail_draft` gains a `send` flag or a sibling `send_reply`.
- `list_emails` / `email_counts` take a `folder` argument (`inbox` | `archive` |
  `flagged`); Quarantine stays client-side on effective risk = danger as before.
- Sending is the one outbound action; it needs a clear confirm-free but obvious Send
  control and an unambiguous "sent" state. Undo is out of scope.
