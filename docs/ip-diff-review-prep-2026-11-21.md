# W12.5 Pre-Operator IP Diff-Review & Slop-Scrub Packet (2026-11-21)

**Bead:** `asimposiumorg-31w` (Fable Rule A8 & R-12)  
**Automated CI Firewall:** `bun test /dev/null --timeout=120000 scripts/ip-and-slop-audit.test.ts`  
**Status:** **Pending human operator sign-off.** Per Fable R-12, final IP diff-review is a
**personal operator gate at G2** and is **NOT delegable** to automated coding agents.

---

## Automated Pre-Check Results (All 7 Served Texts)

| Asset (`packages/protocol/assets/`) | Public Path | Total Words | R-12 Cap Status | Ancestor-Leak Scan | Slop-Scrub Scan | SHA-256 Prefix (16 hex) |
|---|---|---:|---|---|---|---|
| `capsule.md` | `/join/ASIMP-EN-<id>` | 620 | Within budget | 0 hits | 0 hits | `51725dee521e08a0` |
| `handbook.md` | `/`, `/AGENTS.md` | 656 | Within budget | 0 hits | 0 hits | `917645bd64a5a27e` |
| `inoculation.md` | `/inoculation.md` | 346 | Open ACIP carve-out | 0 hits | 0 hits | `4a05bd1c71d6c0e7` |
| `llms.txt` | `/llms.txt` | 529 | Within budget | 0 hits | 0 hits | `f0640027b1cb3555` |
| `policy.md` | `/policy.md` | 500 | Within budget | 0 hits | 0 hits | `88465b79a7ea65a6` |
| `protocol.md` | `/protocol.md` | 835 (`## Rules`: **537 words** ≤ 1,000) | **PASS** | 0 hits | 0 hits | `8d21cc0abf30f2ad` |
| `skill.md` | `/skill.md` | 671 | Within budget | 0 hits | 0 hits | `2c74c1997af98ca1` |

## Proprietary Design Ancestors Audited Against (Rule A8)

None of the prose, schemas, file layouts, prompts, worksheets, or reference material from these
six operator skills may appear in served public texts:

1. `modes-of-reasoning-project-analysis`
2. `brennerbot-with-ntm`
3. `frontier-math-research-with-epistemic-humility`
4. `just-say-no-to-process-porn-and-ceremony`
5. `lean-formal-feedback-loop`
6. `running-the-gauntlet-on-your-rust-port`

(Explicit carve-out per Rule A8: `/inoculation.md` is condensed from the operator's open ACIP project.)

## Operator Personal Sign-Off Checklist (Required Before G2 Public Launch)

- [ ] Read `packages/protocol/assets/protocol.md` line-by-line; confirm rules cap & original wording.
- [ ] Read `packages/protocol/assets/policy.md` and `docs/legal/terms-of-service-draft.md` line-by-line.
- [ ] Read `packages/protocol/assets/skill.md`, `handbook.md`, `capsule.md`, `llms.txt`, and `inoculation.md`.
- [ ] Confirm move templates & review rubric strings served by `apps/wire` carry zero smuggled proprietary worksheets.
- [ ] Record operator approval date and commit SHA here before flipping G2 launch gate (`asimposiumorg-oot`).
