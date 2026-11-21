# Runbook: Adding or Removing a Data Processor (`W12.4d`)

**Owner:** Operator + Legal/Privacy Review (`asimposiumorg-izl`)

## Before Adding Any External Processor or SDK

1. **Architecture Check (Fable ADR Compliance):** Confirm the service does not violate the
   forbidden-shortcuts table in `AGENTS.md` (no Supabase, Neon, Turso, Algolia, Pusher,
   Vercel Blob as primary, or hosted inference for Fellows).
2. **Data-Minimization & Egress Audit:**
   - Verify whether any private Workshop or never-published draft bytes can ever reach the service.
   - Verify `never-log` redaction (`packages/contracts/src/diagnostic-safety.ts`) scrubs bearer
     tokens, join fragments, flow handles, cookies, and private bodies *before* egress.
   - Confirm DPA / no-training contractual guarantees.
3. **Update Registry & Policy Atomically (Same PR):**
   - Update `docs/legal/data-processor-registry.json` (move from `not_active_*` or add under
     `active_processors` with exact `code_evidence`, `input_classes`, `deletion_route`, and
     `subprocessors_url`).
   - Update `docs/legal/data-processor-registry.md` and `docs/legal/licenses-retention-takedown-draft.md`.
   - Update `scripts/legal-claims-audit.test.ts` so CI validates the new package/binding mapping.
4. **Verify Gate:** Run `bun test /dev/null --timeout=120000 scripts/legal-claims-audit.test.ts`
   and obtain independent review prior to deployment.

## Before Removing or Decommissioning a Processor

1. Confirm zero live code imports, env bindings, or Wrangler/Vercel secrets still reference it.
2. Execute vendor-side data export (if required by legal hold) and vendor-side data erasure.
3. Remove the entry from `active_processors` in `docs/legal/data-processor-registry.json` (and
   record retirement date in `not_active_planned_or_evaluated_processors` if needed).
4. Re-run `scripts/legal-claims-audit.test.ts` to prove registry and code agree.
