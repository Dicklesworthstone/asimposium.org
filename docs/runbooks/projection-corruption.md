# Projection corruption

The event log is the truth (Rule A6). Ledger projection tables (claims, claim
build state, versions and dependencies, reviews, evidence, hypotheses, dead
ends, questions, retractions, citations and their versions, proof gaps,
conflicts, syntheses, claim relations, statement reviews, published statement
versions, stewards) and the problem head (title, status, unlisted, current
statement version, creation time, owner sponsor, creating Fellow, areas, famous
guardrail, admission mode, writer cap, resolution summary) are derived from it.
Statement versions written while the problem was a private draft never entered
the ledger and are not compared. Stewards and the governance columns are
compared only when the publish event carries its governance state (events
written before that existed do not). This runbook covers finding a projection
that disagrees with the log and restoring the rows the log proves are missing.

## Dry run

`GET /v1/operators/problems/:problemId/projections`, signed as an allowlisted
operator (service envelope, action `operator.projections.read`). It replays the
problem's log and compares every column of every replayed table. It changes
nothing.

The report (`ProjectionDoctorReportSchema` in `@asimposium/contracts`) names:

- `status`: `consistent`, `drift` or `unreplayable`;
- `source_cursor`: the last event sequence replayed;
- per table, rows rebuilt from the log and rows stored;
- up to 200 drift items: table, primary key and, for a changed value, the
  column name. It never includes row content or event payloads;
- `unreplayable_events`: events the tables need whose payload is lawfully
  redacted;
- `repairable`: true only when every drift item is a missing row and nothing is
  unreplayable.

## Repair

`POST /v1/operators/problems/:problemId/projections/repair` (action
`operator.projections.repair`, body `{}`) inserts the missing rows from the
replay and then re-runs the comparison. It answers `200` with the number of
rows inserted only when the problem is then consistent. Running it again
inserts nothing.

It never updates or deletes a stored row: the ledger tables are append-only by
trigger. It refuses with:

- `409 PROJECTION_DRIFT_NOT_REPAIRABLE` when a stored row differs from the log
  or has no event behind it (no projection row is changed);
- `409 PROJECTION_REBUILD_UNREPLAYABLE` when a needed payload is redacted, so a
  rebuild would be partial (no projection row is changed);
- `409 PROJECTION_REPAIR_INCOMPLETE` when missing rows were inserted but the
  re-check still found drift, for example because a write landed in between.

## What readers see

A refusal for drift (the first and third above) records the problem as
drifted in `projection_health` (migration 0084). While that record stands, the
problem's public faces (`/p/:id` in every format and its full pack) keep
serving their boards with a `degraded` notice that the stored projections
disagree with the event log. Nothing is hidden and nothing is emptied. A later
repair that ends consistent clears the notice. An unreplayable log does not
set it, because it is not known drift.

## When repair refuses

A changed or orphan row means something wrote outside the ledger write path.
Treat it as an incident:

1. Keep the dry-run report. It lists keys and columns only.
2. Find the writer before touching data: recent migrations, operator SQL,
   restore runs.
3. Correct the table by restoring the problem from its verified export into a
   scratch database (the deletion-safe restore rebuilds these tables from the
   log), comparing, and replacing under a reviewed change. Do not hand-edit
   ledger rows.

Every run emits one OPS.2a `projection-doctor` record: mode, problem id,
status, source cursor, drift count, unreplayable count, rows inserted and
duration.

## Limits

Each call replays the whole problem log in one Worker request. There is no
chunking yet, so a very large problem can exceed Worker limits. The doctor
covers the tables and head columns above. Not replayed: problem memberships
(most come from opening a session, which is not a ledger event), merge and fork
links (`canonical_problem_id`, `forked_from_*`: they name other problems), and
the resolution direction and no-claim boundary.
