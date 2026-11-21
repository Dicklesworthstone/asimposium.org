# Runbook: Malicious Artifact

**Scope (Fable §13.3, §10.4, §14.3):** Detection of an uploaded or linked CAS artifact (`artifacts.asimposium.org`) containing malware, active HTML/script payloads, decompression bombs, archive traversal payloads, embedded credentials/PII, or policy-violating binaries.

## Related Runbooks

- Upload authorization and lifecycle details: [`artifact-uploads.md`](artifact-uploads.md)
- Publication binding and retry state: [`artifact-publications.md`](artifact-publications.md)

## Never-Log & Evidence Hygiene (Fable §14.3)

Never execute, decompress unboundedly, or render suspect artifact bytes in a privileged browser or Worker context. Never echo embedded credentials or violating excerpts into `operator_audit` or tickets. Reference only CAS `sha256:<hex>` digests, `artifact_id` / upload IDs, and problem/evidence IDs.

## Containment Procedure

1. **Cut public visibility immediately:**
   - Apply `POST /v1/operators/content-control` (`visibility: "hidden"`, mandatory `reason`) on the referencing evidence/artifact publication target so public faces (`/p/:id/evidence/:evidence/artifacts`) stop serving links to the suspect digest.
   - Resolve or uphold any associated Fellow/sponsor report via `POST /v1/operators/reports/resolution`.
2. **Quarantine and remove from R2 CAS (`artifacts.asimposium.org`):**
   - Inventory all references to the offending `sha256:<hex>` digest across `artifact_uploads` and `artifact_publications` using `ops:artifact-inventory` (dry-run first) so shared references across problems are accounted for.
   - Move or delete the object from the public R2 bucket into isolated operator quarantine (or delete outright for malware/CSAM/lawful takedown) and purge `https://artifacts.asimposium.org/<digest>` at Cloudflare edge cache.
3. **Contain the uploading actor:**
   - Inspect the uploading Fellow and sponsor via `GET /v1/operators/audit-history` and `artifact_uploads`.
   - If the upload indicates hostile intent or credential compromise, suspend the sponsor family via `POST /v1/operators/sponsors/:sponsorId/suspension`.
4. **Verify headers and MIME hardening:**
   - Confirm non-plain-text artifacts always serve `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on `artifacts.asimposium.org`.
   - Add a sanitized non-malicious structural regression fixture (never live malware!) to `apps/wire/src/krater/cas.ts` tests if a scanner or MIME-sniffing gap allowed ingress.

## Dry-Run & Ops Commands

- `ops:artifact-inventory` — dry-run CAS inventory comparing D1 `artifact_uploads`/`artifact_publications` rows against R2 object keys.
- `GET /v1/operators/reports` — review open artifact abuse reports.
- `ops:cache-privacy-test` — confirm quarantined/takedown artifact URLs return 404/410 anonymously after purge.

## Local Workerd/D1 Rehearsal Checklist

1. Seed a synthetic plain-text artifact publication in local Workerd/D1 + local R2.
2. Hide the target via `POST /v1/operators/content-control` and verify public artifact discovery omits the hidden item while `operator_audit` records the `OA-*` event.
3. Verify `asimp scrub --mode artifact` catches synthetic secret/PII fixtures before upload.
