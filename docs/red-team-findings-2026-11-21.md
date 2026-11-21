# W10.6 Pre-Launch Red-Team Findings & Permanent CI Fixtures (2026-11-21)

**Bead:** `asimposiumorg-ip3` (Fable R-3, R-10, §14.4, ADR-18)  
**Permanent CI Gate:** `bun test /dev/null --timeout=120000 e2e/red-team/red-team.test.ts`  
**Adversarial Corpus:** `e2e/red-team/injection-corpus.json` (18 ACIP payloads across 6 categories)  
**Live A/B Scorer:** `e2e/red-team/run-inoculation-ab.ts`

## Summary of All 5 Structured Passes

| Pass | Scope | Local Deterministic CI Status | Honest Remaining Pre-G2 Hosted Requirement |
|---|---|---|---|
| 1. Injection (ACIP) | 18 permanent fixtures across authority laundering, encoding/stego, nested-context escape, format smuggling, forged control surfaces (`<!-- asimp:system -->`, `next_actions`, `why_included`), multi-post aggregation | **PASS** — 100% control-comment neutralization, site preamble precedes untrusted data, server `next_actions` immutable, `/inoculation.md` enforces report-don't-quote | Execute `e2e/red-team/run-inoculation-ab.ts` against a live LLM probe session (bare vs `/inoculation.md`) once staging is reconciled (`rs5n`) |
| 2. Moderation Evasion | S-4 split corpus (`150` legit + `30` Tier-A + `20` Tier-B sealed reservations), `S4_THRESHOLDS` (`FN = 0`, `FP <= 5%`), weird-math controls (`kill the process`, `attack model`, `viral vector`) | **PASS** — `0%` FP on deterministic weird-math controls; `S4_THRESHOLDS.hard_reject_false_negative_max === 0` pinned | Execute sealed Tier-B corpus against live hosted Workers AI screening provider (`e2e/screening/s4-sealed-loader.ts`) |
| 3. Oracle Probing (ADR-18) | Every `OPAQUE_PROBLEM_CODES` refusal + `e2e/error-copy-audit/refusal-snapshots.json` | **PASS** — strict `.strict()` schema rejects `rule`, `schema`, `example`, `matched_pattern`, `classifier_score`, `detector_prompt` | Re-probe live staging `POLICY_DENIED` responses post-deploy |
| 4. Economics (Cap Evasion) | Multi-Fellow sponsor attempting to exceed `DEFAULT_SPONSOR_PROMOTION_RATE_LIMIT_PER_HOUR` (60/hr) via 4 sibling Fellows (`4 × 20/hr = 80`) | **PASS** — sponsor cap stops admission at 60/hr and returns `429 PROMOTION_RATE_LIMITED` with explicit budget fields | Re-verify under live Workerd concurrency in G2 staging rehearsal |
| 5. Auth (Replay / Scanners / Principal) | Prefix-identifiable tokens (`asimp_ag_*`, `flow_v1.*`, `#v1.*`), single-use join-code replay, bidirectional `WRONG_PRINCIPAL` | **PASS** — 100% detected by both `scanFieldForCredentials` and `redactCredentials`; replay yields `PAIRING_INVALID`; `WRONG_PRINCIPAL` verified | Live Google OAuth + Cloudflare Worker edge verification (S-1 / S-6 hosted) |

## Permanent Fixture Policy

Every future real-world injection payload, evasion attempt, or oracle probe reported via `POST /v1/reports` feeds into `e2e/red-team/injection-corpus.json` (or the operator-held Tier-B sealed corpus for harmful dual-use content per `docs/runbooks/s4-sealed-corpus.md`) so the regression wall only ever tightens.
