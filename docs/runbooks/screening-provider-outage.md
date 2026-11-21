# Runbook: Screening Provider Outage

**Scope (Fable §13.3, §15 Degradation Table, ADR-18):** Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8` binding `env.AI`) experiencing timeouts, 5xx errors, quota exhaustion, or malformed JSON responses on promotion-time screening.

## Core Safety Invariant (ADR-18 — Fail Closed, Never Fail Open)

A screening provider timeout or error **NEVER** silently converts into `decision: "pass"`. Every affected promotion fails closed into a private quarantine hold (`screening_cases` with `outcome = 'provider-unavailable'`, `decision_path = 'provider-timeout-fail-closed'` or `'provider-error-fail-closed'`) so legitimate scientific work waits safely instead of vanishing OR bypassing the safety floor.

## Detection Signals

- Operator alert fires on `quarantine backlog > 20` or rising `provider_status IN ('timeout', 'error')` in `screening_cases`.
- `/stats.json` shows `safety.quarantine_cases_open` climbing rapidly while `GET /v1/operators/quarantine` fills with `provider-unavailable` cases.
- `GET /internal/health` or Cloudflare Workers AI dashboard reports elevated latency/errors.

## Never-Log & Evidence Hygiene (Fable §14.3)

Never log `screening_cases.candidate_json`, submitted claim/review text, detector prompts, or raw model score bands in operator logs or status updates. Cite only `case_id` (`QC-*`), `input_digest`, `provider_status`, `decision_path`, and backlog counts.

## Containment & Recovery Procedure

1. **Assess outage scope (read-only):**
   - Inspect `GET /v1/operators/quarantine` (signed operator envelope, action `operator.quarantine.list`) and `/stats.json` to separate `provider-unavailable` holds from genuine policy-flagged holds.
   - Verify Cloudflare Workers AI status and Worker binding limits.
2. **Protect write and review paths during extended outage:**
   - Do **NOT** bypass or disable screening globally to "unblock" traffic (violates ADR-18).
   - Deterministic L0 checks (P7 credential scan, schema validation, structural rules P1–P13) continue running normally before L1 model screening.
   - Engage problem slow-mode (`POST /v1/operators/problems/:problemId/slow-mode`) on high-traffic problems if needed to bound quarantine queue growth.
   - Communicate honestly on `/status` that new public promotions are queuing in safety review due to an upstream screening outage; reads, packs, and private workshop pushes remain unaffected.
3. **Verify provider recovery before draining backlog:**
   - Confirm fresh promotions complete with `provider_status = 'ok'` and normal p95 latency (`< 900ms` total write commit budget, Fable §15).
   - Optionally verify staging accuracy with `bash scripts/e2e-s4-screening-oauth.sh` (see [`s4-sealed-corpus.md`](s4-sealed-corpus.md)).
4. **Drain the `provider-unavailable` quarantine backlog safely:**
   - Process pending `QC-*` cases in FIFO order via `GET /v1/operators/quarantine/:caseId` and `POST /v1/operators/quarantine/decision` (`release` or `reject`, mandatory `reason` string logged to `operator_audit`).
   - Every release re-verifies the exact `input_digest` and `context_digest` binding (migration `0091_moderation_plane.sql`), ensuring tampered or superseded candidates cannot slip through.
   - Process any sponsor appeals queued via `GET /v1/operators/screening-appeals` and `POST /v1/operators/screening-appeals/decision`.

## Dry-Run & Ops Commands

- `GET /v1/operators/quarantine` — read-only backlog census.
- `GET /v1/operators/screening-appeals` — read-only appeals queue census.
- `GET /stats.json` — verify `safety.quarantine_cases_open` returns to baseline.

## Local Workerd/D1 Rehearsal Checklist

1. Run `apps/wire/test/unit/screening-route.test.ts` (timeout & provider-error tests) and verify both produce `decision: "quarantine"` + `provider-timeout-fail-closed` / `provider-error-fail-closed` (never `"pass"`).
2. In local Workerd/D1, trigger a fail-closed hold, inspect it via `GET /v1/operators/quarantine`, and resolve it via `POST /v1/operators/quarantine/decision` with a non-echoing `reason`.
3. Confirm `operator_audit` and `/moderation/log.json` record the action with zero candidate body text.
