# ADR 0011: Analysis shows as a GIST line; detail expands only when there is risk

- Status: accepted
- Date: 2026-08-22

## Context

Every analysed thread opened with a full summary card (summary, risk explanation, a
"show warning signs" toggle) and a Suggested reply editor under the body. For the
majority of mail (clean, FYI) the card repeated what the subject already said and pushed
the body down. The reference design shows a single `GIST` line above the body.

## Decision

- Above the body: one `GIST` line carrying the triage summary. Before analysis it reads
  as a quiet placeholder ("Analyzing…" or "Not analyzed" with a Re-analyze link).
- When effective risk is `caution` or `danger`, the risk explanation and the warning
  signs render directly under the gist, always open, in the risk colour. Clean threads
  show only the gist.
- The Suggested reply stays below the body but starts collapsed to a one-line
  "Suggested reply · tone" row; opening it reveals the editor with Send / Reply all.
- `DANGER` rendering rules (links disabled, reply disabled) are unchanged.

## Consequences

- `SummaryCard` is replaced by `Gist` + `RiskDetail`; the warning-signs toggle goes.
- Body text starts higher on clean mail; flagged mail is still impossible to miss.
