# Glossary

Shared vocabulary for Sentry Mail. See `docs/adr/` for the decisions behind these terms.

| Term | Meaning |
|---|---|
| Triage | The on-device classification of one email by the local Gemma model: type, priority, one-line summary, risk level, scam signals, and an optional action (draft reply or warning). Runs explicitly, never as part of sync. |
| Triage model | `gemma.gguf` (Gemma 4 E4B-it, q4_0 GGUF) loaded in-process via llama.cpp. Also used for on-demand drafts, thread summaries, and label suggestions. Not used for search (ADR 0001). |
| Embedding model | `embeddinggemma.gguf` (EmbeddingGemma 300M). Produces 768-dim vectors for semantic search. Independent of the triage model; auto-loaded when the file exists (ADR 0005). |
| Risk | `safe` / `caution` / `danger` as judged by the model. A parse failure is recorded as `caution`, never `safe`. |
| Effective risk | The user's own verdict (`user_risk`) if set, otherwise the model's risk. Drives every risk-dependent UI rule. |
| Quarantine | The client-side folder of emails whose effective risk is `danger`. Links and replies are disabled there. |
| Sync | Pulling mail from Gmail into SQLite: incremental via the history API when possible, otherwise a full list, plus one older-mail backfill batch per run. Triggers background embedding of new mail (ADR 0005). |
| Keyword search | Full-text search over `subject`, `body_text`, `sender`, `to_addrs`, `cc_addrs`, `attachment_names` via an external-content SQLite FTS5 table kept current by triggers (ADR 0002). Always available; needs no model. |
| Semantic search | Ranking emails by cosine similarity between the query's embedding and stored email embeddings. Available only when the embedding model is loaded. Candidates below a minimum similarity are dropped (ADR 0006). |
| Hybrid search | The single search path: keyword and semantic candidate lists merged with Reciprocal Rank Fusion (ADR 0003). With no embedding model it is plain keyword ranking; there is no user-facing mode switch. |
| Reciprocal Rank Fusion (RRF) | `score = sum over sources of 1 / (k + rank)`, k = 60. Compares ranks, not raw scores, so BM25 and cosine need no calibration. |
| Search scope | What a search runs over: the selected account (or all), the selected label if any, and only `danger` emails when the Quarantine folder is open (ADR 0004). Quarantined mail is not hidden from Inbox searches. |
| Snippet | The text shown under a result row: FTS5 `snippet()` with highlighted terms for keyword hits, first ~160 chars for semantic-only hits (ADR 0006). |
| `attachment_names` | Denormalised, space-joined attachment filenames stored on `emails` so they are indexable without joining `attachments` (ADR 0002). |
| Search result | One specific message that matched, shown with its thread's subject and an "n in thread" tag; not collapsed by thread (ADR 0007). |
