# ADR 0008: Three-pane layout with a persistent reading pane

- Status: accepted
- Date: 2026-08-22

## Context

The app rendered two panes: sidebar plus a content area that swapped between the thread
list and the open thread. Going back to the list meant a full view change and a scroll
restore. The reference design the rebuild targets keeps the list visible beside a reading
pane, so context (position in the inbox, what is unread around you) is never lost while
reading, and moving between threads is one click.

## Decision

- Layout is sidebar | thread list | reading pane. Selecting a row opens it in the reading
  pane; the list keeps its scroll position and shows the selected row with an accent rail.
- With nothing selected the reading pane shows a quiet empty state, not the list stretched.
- Below about 1100 px of window width the app falls back to the previous swap behaviour
  (list or reading pane, with a back control), so narrow Tauri windows stay usable.
- Search results render in the list pane and open in the reading pane the same way.

## Consequences

- The thread list becomes a narrower, denser column; what each row carries is decided in
  ADR 0009.
- `EmailList` no longer unmounts while a thread is open, so the module-level scroll save
  can go.
- Keyboard up/down across rows becomes natural to add later; not part of this ADR.
