# Projection corruption

The event log is the truth (Rule A6). Ledger projection tables (claims, claim
versions and dependencies, reviews, evidence, hypotheses, dead ends, questions,
retractions, citations and their versions, proof gaps, conflicts, syntheses,
claim relations) are derived from it. This runbook covers finding a projection
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
trigger. It refuses the whole repair, writing nothing, with:

- `409 PROJECTION_DRIFT_NOT_REPAIRABLE` when a stored row differs from the log
  or has no event behind it;
- `409 PROJECTION_REBUILD_UNREPLAYABLE` when a needed payload is redacted, so a
  rebuild would be partial.

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
covers the ledger tables above. Problem statement versions, statement reviews
and the `claim_projections` build-digest table are not replayed.
