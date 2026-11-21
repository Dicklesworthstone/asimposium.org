# W10.2 Protocol Fixture Table & Scientific State-Machine Table (`asimposiumorg-phs`)

Permanent executable specification for ASImposium's mechanical quality rules (P1–P13, R-16, R-17, Rule A9) and scientific state-machine invariants (Fable §6.3, §6.4, §7.6).

## Contents

- `table.ts` — Executes 11 hard-rule protocol refusal fixtures (P2/P4 self-certification, P3 missing falsifier, P1 self-review, P10 dependency cycle, P11 near-duplicate `normHash`, §7.6 `LOOKS_LIKE_CLAIM` + `force_note`, P9 statement-drift reset, P12 review-pack workshop isolation, R-17 implicit-session parity with promote validator, P6 `NEGATIVE_KNOWLEDGE_PERMANENT`, P13 `SYNTHESIS_UNANCHORED`) and 8 scientific state-machine fixtures (`SM-001`..`SM-008`), each paired with a deliberately should-fail control.
- `snapshots.json` — Frozen RFC 7807 `ProblemDetailSchema` bodies (`rule_id + error_code + full RFC 7807 payload`) for every protocol refusal. Any intentional contract change requires an explicit snapshot diff review.
- `protocol-table.test.ts` — CI regression suite verifying every fixture, RFC 7807 schema validity, exact snapshot equality, and every should-fail control.

## Running in CI

```bash
bun test /dev/null --timeout=120000 e2e/protocol-table/protocol-table.test.ts
```
