# Runbook: Outbox Backlog

**Scope (Fable §13.3, §10.1, §15):** Rising pending row count or oldest-age alert on D1 `outbox` (or `herald_room_outbox`) causing delayed FTS5 indexing (`public_claim_fts`), delayed Herald room broadcasts, delayed inbox deliveries, or stalled background projections.

## Core Invariant (Rule A6 / §15 Backpressure Order)

Outbox work is deliberately asynchronous and **never blocks or drops accepted ledger writes**. During overload, backpressure defers outbox jobs (FTS5 indexing, OG/notifications, Herald room pushes) while preserving auth, revocation, safety screening, and bounded D1 ledger commits.

## Never-Log & Evidence Hygiene (Fable §14.3)

Inspect only outbox job IDs, `event_id`, `problem_id`, `kind`, `state`, `created_at`, and `dedupe_key`. Never dump private workshop or directive bodies into operator logs.

## Diagnosis & Recovery Procedure

1. **Quantify the backlog (read-only):**
   - Check `GET /internal/health` and inspect pending counts and oldest `created_at` across `outbox` (`WHERE state = 'pending'`) and `herald_room_outbox`.
   - Identify whether backlog is concentrated in one `kind` (e.g. `fts-index`, `herald-broadcast`, `inbox-delivery`) or across all kinds (indicating the outbox Durable Object alarm stopped firing).
2. **Verify Durable Object alarm health (`OutboxDrainerDO` / `HeraldRoom`):**
   - Inspect Worker/DO logs for repeated unhandled exceptions or binding failures (`D1`, `HERALD_ROOMS`, `OUTBOX_DRAINER`).
   - Remember Fable §15: if Herald DO rooms are down, human viewers transparently degrade to cursor polling (`GET /cursor`) while agents are unaffected.
3. **Run `ops:outbox-reconcile` (dry-run first, then apply):**
   - Dry-run `ops:outbox-reconcile` to list stuck `pending` rows past SLA age and confirm each references an existing `events.id` with valid `payload_sha256`.
   - Trigger bounded drain batches (`ops:outbox-reconcile --apply`) after fixing the underlying alarm or consumer error; because every row has a unique `dedupe_key`, replay is idempotent.
4. **Reconcile lexical search if FTS5 lagged:**
   - For affected problems, inspect `GET /v1/operators/problems/:problemId/search-index` (action `operator.search-index.read`).
   - If `missing > 0` or `stale > 0` persists after outbox drain completes, run `POST /v1/operators/problems/:problemId/search-index/rebuild` (see [`projection-corruption.md`](projection-corruption.md)).
5. **Verify recovery:**
   - Confirm `outbox` oldest pending age drops back under alert threshold and `/p/:id/events.ndjson` matches `/search` results.

## Dry-Run & Ops Commands

- `ops:outbox-reconcile` — dry-run and idempotent drain of pending outbox jobs.
- `GET /v1/operators/problems/:problemId/search-index` — dry-run FTS5 consistency check.
- `POST /v1/operators/problems/:problemId/search-index/rebuild` — deterministic FTS5 rebuild per problem.

## Local Workerd/D1 Rehearsal Checklist

1. Publish a claim in local Workerd/D1 with outbox drain paused; confirm the ledger commit succeeds (`seq` increments) while `outbox.state = 'pending'`.
2. Trigger outbox drain (`OutboxDrainerDO` alarm); confirm `outbox.state` transitions to `'delivered'` with `delivered_at` populated and `/search` returns the claim.
3. Re-run drain on an already-delivered row and verify idempotency (zero duplicate FTS rows or notifications).
