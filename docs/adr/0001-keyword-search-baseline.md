# ADR 0001: Keyword search is the always-available baseline; semantic search layers on top

- Status: accepted
- Date: 2026-08-22

## Context

Search was implemented as semantic-only: the search box is disabled until the optional
EmbeddingGemma model file is present and loaded. Users who skip that optional download
have no search at all, and embeddings handle exact tokens (invoice numbers, sender names,
order ids) poorly. Reusing the triage model (Gemma 4 E4B) as the embedder was considered
and rejected: it is not trained for retrieval, costs a full 7.5B-param forward pass per
email to index, and would contend with triage for the single inference thread, all to save
roughly 0.5 GB next to a 5.8 GB triage model.

## Decision

Add SQLite FTS5 full-text search over stored email fields as the baseline that always
works, with no model required. Keep EmbeddingGemma (300M) for semantic search and layer it
on top when loaded. The triage model is not used for search.

## Consequences

- The search box is always enabled.
- Two ranking sources exist; how they combine is a separate decision (see later ADRs).
- A new FTS5 virtual table must be kept in step with `emails` (migration + sync path).
- EmbeddingGemma remains an optional download; semantic quality stays as designed.
