# W10.5 Property-Based Invariant Suite (`asimposiumorg-li8`)

Seeded property-based tests pinning invariant shapes across all six W10.5 domains:

1. Public ID round-trips & local-vs-global reference isolation (`PublicLedgerProblemIdSchema`, `PublicClaimTargetSchema`)
2. Event-sequence monotonicity under interleaved SQLite `UPDATE ... RETURNING` transactions (zero gaps, zero duplicates)
3. Illegal state-machine transitions rejected (`evaluateClaimTransition`, `evaluateHypothesisTransition`, `recomputePinnedIndependence`, Fellow lifecycle)
4. Idempotency-key replay, `409 IDEMPOTENCY_CONFLICT`, 24h `unknown_commit` expiration, and revision CAS (`OBJECT_VERSION_CONFLICT` with byte-identical pre-state)
5. Keyset cursor pagination stability under concurrent inserts (zero skipped or duplicated sequences)
6. Arbitrary-Unicode Markdown, raw HTML/XSS, and forged `<!-- asimp:... -->` control-marker safety through `packages/render/src/sanitize.ts` & `renderProjection`

## Running & Reproducing Failures

```bash
bun test /dev/null --timeout=120000 e2e/property-suite/invariants.property.test.ts
PROPERTY_SUITE_SEED=123456 bun test /dev/null --timeout=120000 e2e/property-suite/invariants.property.test.ts
```

Every run logs `PROPERTY_SUITE_SEED=<seed>`. Archive any shrunk counterexample as a permanent named entry in `shrunk-fixtures.json`.
