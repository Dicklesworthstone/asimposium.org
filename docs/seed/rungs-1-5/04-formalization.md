# Rung 4 — Formalization: Euclid's theorem in Mathlib

## Exact statement

For every `n : Nat`, there exists `p : Nat` such that `n ≤ p` and `Nat.Prime p`.

## Falsifier

A specific `n` for which no natural prime `p` satisfies `n ≤ p`, or an independently compiled artifact whose theorem statement is not definitionally equivalent to the stated target.

## Motivation

The known declaration separates statement binding, toolchain pinning, formalization friction, and independent compilation from the much harder task of formalizing a novel claim. It is intentionally not a model benchmark.

## Scope and out of scope

Scope is Lean 4.33.0 and Mathlib commit `db584cd6d46c92f209a44c0f1c829460d327499d`, with the exact statement above. It excludes hosted Lean execution, automatic certified classification, comparison of proof assistants, and any claim that an existing library declaration validates a new result.

## Authoritative anchored sources and rights

- `mathlib-euclid-declaration` — [Mathlib `Nat.exists_infinite_primes`](https://leanprover-community.github.io/mathlib4_docs/Mathlib/Data/Nat/Prime/Infinite.html#Nat.exists_infinite_primes), locator: theorem declaration with `n : Nat` and a witness prime `p ≥ n`. Source is Apache-2.0; only a locator is stored. Retrieved 2026-08-13.
- `mathlib-license` — [Mathlib LICENSE at the pinned commit](https://github.com/leanprover-community/mathlib4/blob/db584cd6d46c92f209a44c0f1c829460d327499d/LICENSE), locator: repository license. Apache-2.0. Retrieved 2026-08-13.

## Known answer and target hash

The operator-only oracle is `oracle-formalization-euclid-mathlib-v1`. It pins the Lean version, Mathlib commit, declaration, exact target statement, and the requirement for independent compilation plus statement-equivalence review. The oracle digest is checked locally; it is not a substitute for a proof artifact.

## Expected ledger objects and validator behavior

Expected objects: a theorem-attempt claim, formalization-friction evidence, an artifact manifest, and an independent review.

- P2/P4: author-written `certified`, `machine-checked`, or disposition fields are refused; those labels are not writeable evidence.
- P3: a formalization claim with no exact target statement or falsifier is refused.
- P8: an asserted theorem name without the pinned declaration locator is treated as memory rather than retrieved evidence.

## Safety and privacy

All compilation remains in the sponsor's harness. No source tree, secret, participant data, or hidden reasoning is committed here.

## Freshness

The release commit and source locators were checked on 2026-08-13. Recheck the exact toolchain before W12.1; never silently substitute a current checkout for the pinned commit.

## External review required

A Lean/Mathlib maintainer or formal-methods reviewer who is not the artifact author must compile from a clean pinned checkout, examine the axiom report, and compare the claimed theorem statement with the declaration.

## No-claim boundary

A selected Mathlib declaration is neither a new proof nor a certified ASImposium result. The real certified path requires an artifact, independent compilation, and statement-equivalence review in W12.1.
