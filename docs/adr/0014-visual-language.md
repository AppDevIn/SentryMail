# ADR 0014: Visual language: sentence case, mono for metadata, orange accent, no brand block

- Status: accepted
- Date: 2026-08-22

## Context

The UI used IBM Plex Sans for text and Plex Mono in UPPERCASE for chips, tags, status
lines and buttons, with a blue accent. The reference design is quieter: sentence case
everywhere, a neutral sans for content, mono reserved for metadata (counts, times,
verdict, addresses), a warm orange accent on a near-black ground, and a light theme.

## Decision

- Keep IBM Plex Sans / Plex Mono (already bundled; close enough to the reference).
- Sentence case for every label, button and tab. Mono is used only for metadata: counts,
  times, email addresses, the verdict readout, the sync row, small tags (CC, VIA LIST,
  DONE, HIGH, AUTO, n in thread, exact/related).
- Accent is warm orange (`#e0893a` on dark, `#c2661a` on light) for: active folder rail,
  selected-row rail, unread count, label dots without a Gmail colour, primary links
  (Reply, Send, New message). Risk colours stay separate: danger red, caution amber;
  "clean" has no colour.
- Dark palette follows the reference (ground `#0f0f10`, panels `#141415`, hairlines at
  ~8% white); a light palette is derived from it (ground `#f7f6f3`, panels white,
  hairlines ~8% black). The theme toggle sits in the sidebar sync row (ADR 0013).
- **No brand block** in the sidebar. The first row is the account address; the product
  name lives in the window title and Settings only.
- Chips (filters) become text tabs with an accent underline on the active one; the search
  field is a plain underlined input directly under the list title.

## Consequences

- `App.css` is rewritten around a small token set; the uppercase `.mono` convention is
  retired (mono no longer implies uppercase).
- Badges (`RiskPill`) keep their colours but drop uppercase.
