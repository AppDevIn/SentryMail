# ADR 0002: FTS5 index shape and upkeep

- Status: accepted
- Date: 2026-08-22

## Context

ADR 0001 adds SQLite FTS5 keyword search. The index has to cover the fields people
actually search on in a mail client and has to stay consistent across every write path
(full sync, backfill, incremental history re-fetch, one-time recipient/attachment
backfills, account removal via cascade).

## Decision

- Indexed columns: `subject`, `body_text` (in full, including quoted history so old thread
  content is findable), `sender`, `to_addrs`, `cc_addrs`, and `attachment_names`.
- `attachment_names` is a new denormalised TEXT column on `emails` (space-joined
  filenames), written by `upsert_message` when attachment metadata is recorded, so the
  index does not need to join the `attachments` table.
- The FTS table is an external-content FTS5 table over `emails` (`content='emails'`,
  `content_rowid='id'`), kept in step by `AFTER INSERT / UPDATE / DELETE` triggers. No
  Rust write path has to know the index exists.
- The migration that creates the table runs a one-time `rebuild` so existing rows are
  indexed.
- Tokenizer: `unicode61` with `remove_diacritics 2`; queries use prefix matching on the
  last term so typing "remit" finds "remittance". Columns are weighted in `bm25()` so
  subject and sender outrank body hits.

## Consequences

- Schema migration adds one column, one virtual table, three triggers, one rebuild.
- Index size is roughly the size of the indexed text; acceptable at this app's scale.
- Requires the bundled SQLite to be built with FTS5 (verified against rusqlite's
  `bundled` feature).
