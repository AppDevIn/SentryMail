# ADR 0005: Embedding model auto-loads and embeddings follow sync

- Status: accepted
- Date: 2026-08-22

## Context

Semantic search required two manual steps per launch: "Load search model" then "Index new
emails". Between clicks the embedding index went stale, so hybrid ranking (ADR 0003) would
silently degrade to keyword-only for recent mail. The embedding model is small (about 0.5
GB resident, loads in seconds), unlike the triage model (about 6 GB).

## Decision

- On launch, if `<app_data_dir>/models/embeddinggemma.gguf` exists, the embedding worker
  is spawned automatically in the background. Status is still surfaced via the existing
  `embed-model-status` event.
- After every sync (manual or the 5-minute auto-sync), any emails in the synced accounts
  without an embedding for the current `search::MODEL_VERSION` are embedded in the
  background, reporting through the existing `embed-progress` event. Sync itself does not
  wait on embedding.
- The Settings buttons ("Load search model", "Index new emails") remain as a manual
  fallback and for re-indexing after a model-version bump.
- The triage model keeps explicit loading; its memory cost is a deliberate user choice.

## Consequences

- New mail is searchable by meaning within seconds of arriving, with no clicks.
- Startup does slightly more work when the file is present; absent file means no change.
- `sync_now` gains a post-sync hook; embedding runs on its own worker so it never blocks
  triage or the UI.
