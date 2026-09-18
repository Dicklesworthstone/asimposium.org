# Scientific input withdrawal

Evidence and review authors can record a correction through the mounted session
router. The existing claim-only `POST /v1/sessions/:id/retract` remains unchanged.
The new endpoints use the durable `scientific_withdrawals` engine and its exact
source-event pins, not a second retraction table or an alternate ledger writer.

## Calls

Send `POST /v1/sessions/:id/evidence/:evidence_id/retract` or
`POST /v1/sessions/:id/reviews/:review_id/retract` with the Fellow bearer,
`Content-Type: application/json`, and a stable `Idempotency-Key`. The body is:

```json
{
  "source_event_id": "E-EXAMPLE",
  "source_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "reason": "The author identified a substantive error in the record."
}
```

Use the actual source event and full payload digest, not the illustrative zeros.
`/schemas/scientific-withdrawals.v1.json` is generated from the shared Zod
request and receipt definitions. A successful `200` is the durable correction
receipt; an identical retry returns the original receipt without a new screen
or event. Preserve the same path, body and key after an ambiguous failure.

Only the original author can retract the input. Evidence withdrawal requires
promotion authority; a review author uses review authority. Current session,
member, grant, credential, quota and publication checks remain in the existing
engine and are rechecked at commit. The public explanation uses the existing
screening provider. A failed or held screen is not a successful withdrawal;
the HTTP adapter does not pretend it has stored a pending correction body.
No sponsor cookie or service envelope supplies Fellow authority.

## Effects and boundaries

The canonical disposition fold removes withdrawn positive inputs and their
structured evidence dependents. Prior cursor cuts retain their prior history.
Negative findings are not resolved merely because their author withdraws an
endorsement. Original event bodies and digests remain recorded. A withdrawn
source cannot ground a new direct scientific reference or pass its atomic
reference guard. Transitive read invalidation is not a claim of a new transitive
write-admission resolver.

Retraction explanations are read from digest-verified, non-redacted event
content, never the projection's retained reason. Unreadable explanations are
explicitly omitted without erasing the durable withdrawal. The schema/index
and these endpoints are mounted; OpenAPI operation enumeration remains separate.

## Rollout

Apply migrations through `0071_scientific_withdrawals.sql`, then
`0072_withdrawn_artifact_evidence.sql`, before deploying the corresponding Worker.
0072 replaces only a derived view; it deletes no event, source, or artifact row.
It excludes withdrawn evidence consistently from artifact admission, public
source reads and the queued publication release CAS.

Already release-authorized public copies are not made private again. Artifact
takedown and CDN purge remain separate work. No new dependency, secret or AI
provider is introduced. Committing these files performs no production migration
or deployment. Local SQLite/transport tests do not prove the complete D1,
Hono, enrollment, screening-provider or deployed Worker integration.
