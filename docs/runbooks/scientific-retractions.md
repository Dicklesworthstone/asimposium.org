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

Evidence attached to a hypothesis uses the same evidence withdrawal route.
Read `/p/:problem_id/evidence/:evidence_id.json` and copy
`publication.event_id` into `source_event_id`; prefix its
`publication.payload_sha256` with `sha256:` for `source_digest`. Use the exact
evidence ID in the withdrawal URL and an authorized session on that problem.
The resulting receipt names `hypothesis_id`. Evidence or reviews about a claim
retain the existing `claim_id` and `claim_version` receipt fields. The request
cannot change which claim or hypothesis the source addressed.

Only the original author can retract the input. Evidence withdrawal requires
evidence publication authority, including an observer authorized to publish
evidence; a review author uses review authority. Current session,
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

For hypothesis evidence, the public item and evidence index retain the source
and mark it withdrawn. It no longer supplies a fresh elimination recommendation
or passes the source checks for a new hypothesis kill. Existing causal inbox
notices about that evidence disappear from actionable reads, unread counts and
acknowledgments. A previously recorded hypothesis elimination remains recorded;
correcting evidence does not reopen the route or rewrite its history.

Retraction explanations are read from digest-verified, non-redacted event
content, never the projection's retained reason. Unreadable explanations are
explicitly omitted without erasing the durable withdrawal. The schema/index
and these endpoints are mounted; OpenAPI operation enumeration remains separate.

## Rollout

Apply the ordered migration chain through
`0105_hypothesis_evidence_withdrawals.sql` before deploying the corresponding
Worker. Migration 0105 preserves every existing correction and replay receipt
while widening the same immutable withdrawal index to admit hypothesis evidence.
It runs in the normal atomic D1 migration transaction with foreign keys enabled;
it changes no event, source, artifact, or recorded elimination. Existing artifact
admission, source reads, and queued publication release checks continue to use
the same withdrawal index.

Already release-authorized public copies are not made private again. Artifact
takedown and CDN purge remain separate work. No new dependency, secret or AI
provider is introduced. Committing these files performs no production migration
or deployment. The `hypotheses-evidence-real-bindings.mjs` journey exercises the
mounted HTTP routes with local Workerd, D1, enrollment and deterministic
screening fixtures. It covers correction replay, rollback, inbox removal,
withdrawal during a hypothesis kill, historical kill replay and projection
rebuild. It does not verify the live screening provider or production deployment.
