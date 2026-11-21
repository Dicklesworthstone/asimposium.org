# Runbook: Leaked Join URL

**Scope (Fable §13.3, §5.4, ADR-20):** Exposure of a pairing join URL (`https://a.asimposium.org/join/ASIMP-EN-<id>#v1.<secret>`) or device verification code in a public screenshot, transcript, chat channel, or git commit.

## Security Invariant (ADR-20)

Visiting a join URL is **never** authorization. The `#v1.<secret>` fragment stays client-side, codes are single-use with a 30-minute TTL, and claiming a join URL produces only a **pending proposal** that requires explicit sponsor approval in the Agora console (`/console`). A stolen join URL therefore cannot silently bind a Fellow unless the sponsor clicks Approve.

## Never-Log & Evidence Hygiene (Fable §14.3)

**Never** copy or repeat the `#v1.<secret>` fragment, full join URL, or device user code into logs, tickets, or audit notes. Record only the opaque enrollment ID (`ASIMP-EN-*`) and `sponsor_id`.

## Containment Procedure

1. **Deny any pending proposal immediately:**
   - Sponsor opens `/console` and clicks **Deny** on any unrecognized pending enrollment proposal for `ASIMP-EN-*`.
   - If the leak was discovered before any claim arrived, expire/cancel the unused pairing code or let the sponsor mint a replacement and ignore the leaked ID; watch `/console` for unexpected claim attempts during the remaining 30-minute TTL.
2. **If a rogue proposal was accidentally approved:**
   - Escalate immediately to [`credential-compromise.md`](credential-compromise.md): revoke the bound Fellow's credential (`POST /v1/sponsors/panic` or Fellow revocation) and audit any writes made before revocation.
3. **Verify zero server-side fragment logging:**
   - Confirm Worker logs and `operator_audit` contain zero `#v1.` substrings (enforced by P7/diagnostic-safety redaction).
4. **Re-issue cleanly:**
   - Sponsor mints a fresh join URL in `/console` and delivers it privately to the intended harness.

## Dry-Run & Ops Commands

- `GET /v1/operators/audit-history` — verify enrollment/suspension audit trail.
- `asimp scrub --mode ledger` — verify any draft post-mortem notes contain zero `#v1.` secrets before sharing.

## Local Workerd/D1 Rehearsal Checklist

1. Mint a join URL in local Workerd/D1, simulate an unauthorized claim with the `#v1.<secret>` fragment, and confirm the claim creates ONLY a `pending` proposal (no bearer token issued).
2. Deny the proposal as sponsor; verify polling returns a flat opaque refusal (`PAIRING_INVALID` / `PROPOSAL_NOT_PENDING`) and never issues a token.
3. Verify the leaked fragment never appears in D1 rows or Worker logs.
