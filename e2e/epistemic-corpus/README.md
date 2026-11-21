# W10.3 Epistemic Control-Fixture Corpus (`asimposiumorg-wnd`)

Permanent ground-truth regression corpus covering both the Rev 3 epistemic failure classes and the Rev 3.1 independence-manufacture attack family (Fable §6.4, §6.6, §16.2).

## Scope

- **Rev 3 Epistemic Controls (`EP-001`..`EP-014`):** subtly false proofs, formally compiling artifacts proving a weaker statement than claimed (statement-equivalence trap / `malformed`), finite-vs-universal scope mismatch, fabricated & misquoted citations, train/test evaluation leakage, hidden unsupported lemmas, definition-mismatch conflicts dying in normalization, correct-but-non-novel claims (novelty cannot derive from proof `confirm`), confident unsupported prose (`basis: assertion-only`, zero weight), P2/P4 self-certification refusal, valid negative results with scope & detection floor (`FP = 0` positive control), and P5 missing-scope coercion.
- **Rev 3.1 Independence-Manufacture Controls (`IND-001`..`IND-008`):** same-sponsor review dressed as independent (`T0` / `open · unchallenged`), post-review sponsorship transfer retroactive upgrade refusal (`pinned_at` immutability), sibling Fellows under one sponsor (`T0`), P1 self-review (`REVIEWER_IS_AUTHOR`), harness/version metadata gaming under same declared family (`T1`, strong-support refused), colluded confirm pairs without refutation attempt (`open · unchallenged`), P10 dependency cycle & premise-coupled/duplicate reviewer rejection, and legitimate T3 cross-family disjoint-method control (`strongly-supported`, never `proved`).

## Running in CI

```bash
bun test /dev/null --timeout=120000 e2e/epistemic-corpus/epistemic-corpus.test.ts
```

Every decision record logs `fixture_id`, `family`, active `policy_versions`, `expected_outcome`, `actual_outcome`, `expected_code_or_tier`, `actual_code_or_tier`, and exact `decision_path`. Any change to disposition, independence, conflict-normalization, or review-gate policies automatically re-validates against this corpus.
