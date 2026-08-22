# ADR 0013: Sidebar is text-first; folders, counts and sync are plain rows

- Status: accepted
- Date: 2026-08-22

## Context

The sidebar had a large accent "Sync inbox" button, an avatar account switcher, a status
line in uppercase mono, folder rows, and labels carrying EDIT / AUTO / NO DESC tags at
all times. The reference design is text-first: brand, address, a one-line
`synced HH:MM · sync now · light` row, a `New message` entry, four folders with counts,
labels with counts, and a quiet footer.

## Decision

- Brand block at the top; wording decided in ADR 0014.
- The account row shows the selected address (or "All inboxes"); clicking it opens the
  existing switcher (select, remove, add inbox). Multi-account stays one click.
- Under it one mono row: `synced HH:MM` (or the sync progress copy while syncing, or
  `not synced`) · `sync now` · `light`/`dark` (theme toggle, cycling system → light →
  dark). The accent button is gone.
- `New message` opens compose in the reading pane (ADR 0010).
- Folders: **Inbox** (unread count, total as tooltip), **Quarantine**, **Flagged**,
  **Archive**, each with a mono count on the right. Counts come from the backend in one
  call (`folder_counts`), not from the loaded page of rows.
- Labels: dot + name + count. Per-label thread counts are returned by `list_labels`.
  `edit` appears on hover/focus and opens the existing description / auto-apply editor
  inline; AUTO shows as a small mono tag only when set; NO DESC is no longer shown (the
  editor explains it instead).
- Footer: left `on device · analysis on|off|loading|unavailable` (the model status, with
  the pulsing dot while inferring or syncing); right `settings`.

## Consequences

- Backend: `list_labels` gains `thread_count`; new `folder_counts(account_id)` returns
  inbox total/unread, quarantine, flagged, archive in one round trip.
- The Quarantine count becomes exact (today it counts only loaded rows).
- `theme.ts` is unchanged; the toggle just calls `setTheme`.
