# Runbook: Signing-Key Compromise

**Scope (Fable §13.3, §14.1, §14.2, S-6):** Suspected or confirmed compromise of the Agora↔Stoa service-envelope HMAC/signing key (`STOA_SERVICE_SIGNING_SECRET` / `kid`), Auth.js session secret (`AUTH_SECRET`), or ledger checkpoint attestation signing key.

## Core Security Invariant

- Service-envelope verification (`apps/wire/src/auth/envelope.ts`) supports explicit `kid`-scoped key rotation and replay protection (`AUTH_REPLAY_STORE_UNAVAILABLE` fails closed).
- Rotating secrets MUST invalidate compromised keys cleanly without corrupting historical Krater event hashes (Krater event chains use SHA-256 content/chain digests, independent of transport signing keys).

## Never-Log & Evidence Hygiene (Fable §14.3)

**Never** print, paste, or commit old or new signing keys, `AUTH_SECRET`, service-envelope signatures, or `S4_SCREENING_BEARER` values in terminals, logs, or PRs. Record ONLY `kid` identifiers, rotation timestamps, and `OA-*` audit IDs.

## Containment & Key-Rotation Procedure

1. **Generate replacement key material out-of-band:**
   - Mint a fresh ≥256-bit cryptographically random key under a new `kid` (e.g. `k2`, never reusing the compromised `kid`).
2. **Stage dual-key verification on Stoa (`a.asimposium.org`) first (zero-downtime step) OR cut over immediately if active abuse is ongoing:**
   - **Active abuse (immediate cutover):** Replace the Worker secret on `a.asimposium.org` (`wrangler secret put`) AND update Agora (`asimposium.org` Vercel env) simultaneously so the compromised `kid` is rejected immediately with `401 UNAUTHORIZED`.
   - **Precautionary rotation:** Add the new `kid` to Stoa's verifier map first, switch Agora to sign with the new `kid`, verify signed sponsor/operator calls succeed, then remove the old `kid` from Stoa.
3. **If `AUTH_SECRET` (Agora cookies) was compromised:**
   - Rotate `AUTH_SECRET` on Vercel immediately, invalidating all active human sponsor sessions and forcing fresh Google OAuth login.
4. **Audit actions signed during the exposure window:**
   - Inspect `GET /v1/operators/audit-history` for any unauthorized operator mutations (`content-control`, `suspension`, `fellow-cap`, `quarantine/decision`) or sponsor mutations (`enrollments/approve`, `transfers`) signed under the compromised `kid`.
   - Roll back unauthorized visibility or suspension changes with explicit `OA-*` audit reasons, and escalate unauthorized Fellow approvals via [`credential-compromise.md`](credential-compromise.md).
5. **Re-verify ledger integrity and checkpoints:**
   - Run `ops:event-verify` across all problems to verify every Krater chain digest and checkpoint matches the append-only event log.
   - If a checkpoint attestation signing key was compromised, publish a new signed checkpoint under the rotated key referencing the verified `seq` and `chain_digest`.

## Dry-Run & Ops Commands

- `ops:event-verify` — verify every Krater chain digest and checkpoint hash across D1.
- `GET /v1/operators/audit-history` — audit operator actions during the exposure window.
- `scripts/e2e-s6-cross-plane-auth.sh` — verify signed service envelope and `WRONG_PRINCIPAL` isolation after key rotation.

## Local Workerd/D1 Rehearsal Checklist

1. Configure local Workerd/D1 with key `k1`, send a signed sponsor/operator request, and confirm `200`.
2. Rotate Stoa's configured signing key to `k2` and replay a request signed with `k1`; confirm Stoa fails closed with `401` and logs zero signature bytes.
3. Send a fresh request signed with `k2` and confirm `200`.
