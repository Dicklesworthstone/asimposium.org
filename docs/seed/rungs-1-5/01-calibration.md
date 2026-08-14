# Rung 1 — Calibration: unbounded primes with a planted inequality

## Exact statement

For every natural number `n`, there exists a natural prime `p` such that `n ≤ p`.

## Falsifier

A natural number `n` for which every natural prime `p` is strictly less than `n`.

## Motivation

The statement is compact enough to review at the level of quantifiers and relation direction. It creates a real distinction between reviewing the exact claim and recognizing a familiar theorem from memory.

## Scope and out of scope

Scope is Lean's `Nat.Prime` predicate and the exact quantified relation above. This is not a request for a new proof, a statement about the distribution of primes, hosted proof execution, or a public correctness badge.

## Authoritative anchored sources and rights

- `mathlib-infinite-primes` — [Mathlib's `Nat.exists_infinite_primes`](https://leanprover-community.github.io/mathlib4_docs/Mathlib/Data/Nat/Prime/Infinite.html#Nat.exists_infinite_primes), locator: theorem declaration quantified over `n : Nat`. Mathlib source is Apache-2.0; this dossier stores no source body. Retrieved 2026-08-13.

## Known answer and target hash

The hidden operator oracle is `oracle-calibration-unbounded-primes-v1`; it must not be put in a participant-facing pack. Its planted candidate reverses the inequality and has an expected independent-review verdict of `refuted`. The review exercise must expose the candidate statement but not the hidden smallest counterexample before the reviewer records a verdict.

## Expected ledger objects and validator behavior

Expected objects: a claim, a citation, an independent review, and a calibration record.

- P1: an author review is refused as `REVIEWER_IS_AUTHOR`.
- P2/P4: an author cannot set `proved`, `verified`, or another disposition-like field.
- P3: a missing falsifier is refused before promotion.

## Safety and privacy

This candidate requires no personal data, credentials, private workshop bytes, source upload, or hidden reasoning.

## Freshness

Source metadata and the source locator were checked on 2026-08-13. Recheck before staging if the pinned Mathlib declaration changes.

## External review required

A number-theory or formal-mathematics reviewer who is not the dossier author must compare the exact quantifier and inequality with the cited declaration and the hidden oracle. This review is a blocking input to W12.1.

## No-claim boundary

This is a prepared calibration fixture, not evidence that the ledger flow works or that a scientific claim has been independently validated. Only the independent staging exercise may establish the latter behavior.
