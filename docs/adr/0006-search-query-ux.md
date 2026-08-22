# ADR 0006: Search runs as you type and explains its matches

- Status: accepted
- Date: 2026-08-22

## Context

Search previously ran only on Enter because each query needed an embedding round-trip
and the box was disabled without the model. With FTS5 always available and query
embedding costing milliseconds, the cost argument for an explicit submit is gone.

## Decision

- The search runs about 200 ms after the last keystroke (debounced) and on Enter; the
  results banner names the scope (ADR 0004). Clearing the box or pressing Esc returns to
  the normal list.
- User input is never passed to FTS5 raw. It is tokenised into quoted terms (so FTS5
  operators and stray punctuation cannot cause a syntax error), quoted phrases are kept
  as phrases, and the last term gets a prefix match (`remit*`) so partial words work while
  typing.
- Each result row shows sender, subject, time, and risk pill as in the list. Keyword hits
  show FTS5's `snippet()` with matched terms highlighted; semantic-only hits show the
  first ~160 characters of the body. A small tag distinguishes "exact match" from
  "related" using the per-source match info from ADR 0003.
- Semantic candidates below a minimum cosine similarity (initially 0.25, a constant) are
  dropped before fusion so nonsense queries don't surface unrelated mail as "related".
- Results are capped at 50.

## Consequences

- One `search` command replaces `semantic_search`; the frontend debounces and cancels
  stale responses (last request wins).
- `SearchResultDto` gains `matched: ["keyword" | "semantic"]` and a highlighted snippet
  (plain text with marker characters, rendered by the UI; no HTML injection).
