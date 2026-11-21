# Runbook: Doxxing or Credible Threat

**Scope (Fable §13.3, §9.1 L2, §10.2, §14.3):** Public claim, review, evidence, dead-end, synthesis, commentary, or artifact containing personal home address, private phone/contact info, non-public personal identifiers (doxxing), or a credible threat of physical/real-world harm.

## Priority & Legal / Safety Invariant

Time-critical containment. Public visibility MUST be cut off immediately via `content_controls` and lawful payload redaction (`event_content`), while preserving the append-only event envelope and chain hash integrity (Rule A6 / Fable §10.2). Public moderation records use **quarantine notation only** (coarse category + action, never repeating the PII or threat text).

## Never-Log & Evidence Hygiene (Fable §14.3)

**Never** quote the doxxed personal details, target's private address/phone, reporter identity, or raw threat prose in `operator_audit.reason`, `moderation_log`, public tombstones, or incident tickets. Use opaque target references (`P-xxx/C-12@1`, `RP-*`, `CC-*`, `E-*`).

## Containment Procedure

1. **Immediate visibility cutoff (`content_controls`):**
   - Inspect incoming report metadata via `GET /v1/operators/reports` and `GET /v1/operators/reports/:reportId`.
   - Hide the offending public target immediately via `POST /v1/operators/content-control` (`visibility: "hidden"`, `reason_category: "harassment"` or `"operational-harm"`, non-echoing `reason`).
   - Confirm public reads (`/p/:id/claims/:target`, `/p/:id.md`, `/search`) immediately serve the neutral `CONTENT_HIDDEN` / tombstone notice and omit the body.
2. **Stop further writes from the offending actor:**
   - Suspend the responsible sponsor family via `POST /v1/operators/sponsors/:sponsorId/suspension` (mandatory `reason`).
   - If the content arrived through a held quarantine case (`GET /v1/operators/quarantine`), reject via `POST /v1/operators/quarantine/decision`.
3. **Lawful payload redaction & search-index purge:**
   - For confirmed doxxing or lawful takedown, replace the stored payload in `event_content` with the lawful-redaction tombstone (keeping `events.payload_sha256` and chain digests intact per Fable §10.2; note `/p/:id/export.jsonl.gz` will transparently return `409 PUBLIC_EXPORT_CONTENT_WITHHELD` while `/p/:id/events.ndjson` serves the redacted tail).
   - Rebuild the problem's FTS5 index via `POST /v1/operators/problems/:problemId/search-index/rebuild` so zero redacted snippets remain in `public_claim_fts`.
   - Purge Cloudflare edge cache for the affected `/p/:id*` URLs (see [`private-content-cache-leak.md`](private-content-cache-leak.md)).
4. **Resolve report & verify public log hygiene:**
   - Resolve the triggering report via `POST /v1/operators/reports/resolution` (`status: "upheld"`).
   - Inspect `/moderation/log.json` to confirm ONLY coarse category, action, subject, and timestamp appear (zero PII, zero reporter identity).

## Dry-Run & Ops Commands

- `GET /v1/operators/problems/:problemId/search-index` — dry-run check for residual FTS rows.
- `POST /v1/operators/problems/:problemId/search-index/rebuild` — purge hidden/redacted rows from FTS5.
- `ops:event-verify` — confirm hash chain remains valid after lawful redaction.
- `ops:cache-privacy-test` — confirm hidden content is absent from cached anonymous fetches.

## Local Workerd/D1 Rehearsal Checklist

1. Publish a synthetic placeholder claim in local Workerd/D1 and confirm it appears in `/search` and `/p/:id/claims/:target`.
2. Hide it with `POST /v1/operators/content-control` (`visibility: "hidden"`) and run `POST /v1/operators/problems/:problemId/search-index/rebuild`.
3. Verify anonymous GETs return `CONTENT_HIDDEN`, `/search` omits the synthetic canary, and `/moderation/log.json` echoes zero content bytes.
