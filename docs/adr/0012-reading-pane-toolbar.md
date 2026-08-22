# ADR 0012: Reading-pane toolbar: actions left, verdict right

- Status: accepted
- Date: 2026-08-22

## Context

The old toolbar showed Mark unread, Mark done, Re-analyze and then a row of verdict
buttons (Not a threat / Mark danger / back to model) at all times. The reference design
shows a quieter bar: `Mark unread · Archive · Re-analyze` on the left and
`verdict: clean · Flag` on the right.

## Decision

- Left group: **Mark unread/read · Archive · Done/Undo done · Re-analyze**. Text buttons,
  sentence case.
- Right group: a mono **verdict** readout coloured by effective risk
  (`verdict: clean` / `caution` / `danger`; suffixed `· yours` when `user_risk` is set).
  Clicking it opens a small menu: *Not a threat* (safe), *Caution*, *Danger*, *Use model's
  verdict* (clear). After it, **Flag / Unflag** is the one-click shortcut that sets or
  clears `user_risk = caution` (ADR 0010).
- Before analysis the readout says `verdict: pending` (or `not analyzed` when the model is
  off) and the menu is disabled: `set_user_risk` stores the override on the triage row, so a
  verdict needs an analysis result to attach to. Marking danger before analysis is a
  possible follow-up (insert a stub triage row) and is not in this change.
- "clean" is the UI word for risk `safe`; the data value is unchanged.

## Consequences

- The verdict buttons move out of the permanent toolbar into a menu; `Flag` covers the
  common case.
- Glossary gains *Verdict* and *Flag*.
