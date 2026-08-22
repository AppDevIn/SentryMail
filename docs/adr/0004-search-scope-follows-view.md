# ADR 0004: Search scope follows the current view

- Status: accepted
- Date: 2026-08-22

## Context

`semantic_search` scoped results only by the selected account. The UI also has label
views and a Quarantine folder (effective risk = danger); searching inside a label and
receiving results from elsewhere is surprising, and the Quarantine folder raises the
question of whether flagged mail should be findable from the Inbox at all.

## Decision

A search runs over what the user is currently looking at:

- the selected account, or all accounts when none is selected (as before);
- the selected label, when one is open;
- the Quarantine folder restricts results to emails whose effective risk is `danger`.

Quarantined emails are not hidden from Inbox searches. They appear in results with their
risk pill, because making a scam the user remembers seeing unfindable is worse than
showing it clearly flagged. The same DANGER rendering rules apply when the result is
opened.

## Consequences

- The search command takes `account_id`, `label_id`, and a `danger_only` flag; both the
  FTS5 and embedding candidate queries apply the same filters before ranking.
- The UI passes the current view's scope and names it in the results banner
  ("12 results for 'invoice' in Receipts").
