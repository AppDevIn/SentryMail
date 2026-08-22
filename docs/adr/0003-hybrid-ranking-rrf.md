# ADR 0003: Hybrid ranking via Reciprocal Rank Fusion

- Status: accepted
- Date: 2026-08-22

## Context

With ADR 0001 there are two independent ranking sources: FTS5 BM25 (always) and
EmbeddingGemma cosine similarity (when loaded). Their raw scores live on different,
uncalibrated scales: BM25 is unbounded and query-length dependent, cosine distributions
depend on the embedding model.

## Decision

Merge the two result lists with Reciprocal Rank Fusion: for each email,
`score = sum over sources of 1 / (k + rank_in_source)`, with `k = 60`, then sort by score
descending. Each source contributes its top-N candidates (N is a constant, initially 50).
When the embedding model is not loaded, only the BM25 list exists and the same code path
yields pure keyword ranking; there is no separate mode.

## Consequences

- No score normalisation or per-model tuning; ranks are all that is compared.
- Emails found by both sources rise naturally above single-source hits.
- The user sees one ranked list; the UI does not expose a keyword/meaning switch.
- A result DTO can still carry which sources matched (for a small "exact match" /
  "related" hint in the row) without affecting ranking.
