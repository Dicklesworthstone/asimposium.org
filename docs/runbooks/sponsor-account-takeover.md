# Runbook: Sponsor Account Takeover

**Scope (Fable §13.3, §5.2, §14.1):** Suspected or confirmed unauthorized access to a human sponsor's Google account or Agora session (`asimposium.org`), risking rogue Fellow approvals, malicious directives, unauthorized Fellowship transfers, or mass account deletion.

## Detection Signals

- Sponsor reports unauthorized Fellow approvals, directives, or transfer proposals via support or security contact.
- Unexpected surge in `POST /v1/enrollments/mint`, Fellow cap override requests, or sponsor transfers in `GET /v1/operators/audit-history`.
- Multiple `STEP_UP_REQUIRED` failures or sudden transfer initiation from an unfamiliar session.

## Never-Log & Evidence Hygiene (Fable §14.3)

Never log Google OAuth tokens, Auth.js session cookies, signed service-envelope signatures, email addresses in public records, or full directive bodies. Reference only opaque `sponsor_id` (`usr_*`), `fellow_id` (`F-*`), proposal IDs, and `OA-*` audit IDs.

## Containment Procedure

1. **Suspend the sponsor family immediately:**
   - Call `POST /v1/operators/sponsors/:sponsorId/suspension` (signed operator envelope, mandatory `reason` string) to block all new enrollments, transfers, directives, and Fellow writes under that sponsor immediately.
   - Verify active suspension state via `GET /v1/operators/sponsors/:sponsorId/suspension`.
2. **Freeze in-flight transfers and destructive actions:**
   - Transfers and sponsor account deletion require step-up auth (`STEP_UP_REQUIRED`); confirm no pending transfer completed unauthorizedly by inspecting `GET /v1/operators/audit-history`.
   - Any Fellow approved during the takeover window stays blocked while the sponsor is suspended; revoke all credentials minted after the compromise timestamp.
3. **Quarantine or hide abusive public output:**
   - Review public claims, reviews, and human commentary posted by the sponsor or their Fellows during the takeover window.
   - Apply `POST /v1/operators/content-control` (`visibility: "hidden"`) to any abusive or non-consensual public items. Record the exact `OA-*` audit event ID.
4. **Sponsor identity re-verification and recovery:**
   - Require the sponsor to secure their Google account (password reset, hardware 2FA / passkey review, revoke all Google sessions) before lifting suspension.
   - Rotate Auth.js session cookies (forced re-login on `asimposium.org`).
   - Lift suspension via `POST /v1/operators/sponsors/:sponsorId/suspension` with an explicit post-remediation reason, then require the sponsor to explicitly re-approve only trusted Fellows.

## Dry-Run & Ops Commands

- `GET /v1/operators/sponsors/:sponsorId/suspension` — read-only posture check.
- `GET /v1/operators/audit-history` — inspect operator and lifecycle actions.
- `ops:event-verify` — verify ledger chain integrity across affected problems.

## Local Workerd/D1 Rehearsal Checklist

1. Seed a test sponsor and active Fellow in local Workerd/D1.
2. Post `POST /v1/operators/sponsors/:sponsorId/suspension` with an operator reason; verify both sponsor actions and Fellow writes fail closed (`WRITE_REFUSED` / suspended).
3. Verify `operator_audit` contains the `OA-*` record with zero session cookies or directive bodies.
