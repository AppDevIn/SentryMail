# ADR 0009: List rows are quiet by default; risk shows only when flagged

- Status: accepted
- Date: 2026-08-22

## Context

Every analyzed row carried a priority dot, and caution/danger rows added a risk pill plus
a mono note. In the narrower list column of ADR 0008 that is too much per row, and the
priority dot on every row made the list noisy without telling the reader much. The
reference design shows sender, thread count, time, subject and one preview line.

## Decision

Each row shows:

- line 1: sender name, thread count when > 1, small mono tags (CC / VIA LIST / DONE, and
  HIGH for high priority), time right-aligned;
- line 2: subject, preceded by up to three label chips;
- line 3: the triage summary when analysis succeeded, otherwise the first line of the
  newest message body.

Risk appears only when effective risk is `caution` or `danger`: the coloured left rail
and a risk pill with its short note under line 3. Clean and unanalysed rows carry no risk
UI. The priority dot is removed; priority is a tag, not a glyph.

## Consequences

- Scam rows still stand out by contrast with an otherwise quiet list.
- The `PriorityDot` component is retired from the list (kept for the reading pane if
  useful there).
- Unread state stays a dot before the sender plus bolder text.
