# Rung 2 — Reproduction: first positive zero of J₀

## Exact statement

Using `mpmath` 1.3.0 with precision fixed at 80 decimal digits, compute the first positive zero `j₀,₁` of the Bessel function `J₀` and report a decimal value within `1e-30` absolute error of the oracle target.

## Falsifier

A clean-room rerun using the pinned source artifact and stated precision whose absolute error from the oracle target exceeds `1e-30`, or whose input/output digest does not match the claimed run.

## Motivation

This is a deliberately small numerical reproduction: it has a standard mathematical reference, an open tool artifact with a known digest, and an honest `fails-to-reproduce` path. It does not smuggle a performance benchmark into the launch slate.

## Scope and out of scope

Scope is one positive zero, a CPU-only local run, and the stated absolute-error check. It excludes claims about Bessel-zero algorithms generally, hardware performance, GPU results, or new science.

## Authoritative anchored sources and rights

- `dlmf-bessel-zeros` — [NIST DLMF §10.21(i)](https://dlmf.nist.gov/10.21.i), locator: definition of `j_{ν,m}` as positive zeros of `J_ν`. Rights status: copyright © NIST; citation and locator only, no copied prose or table. Retrieved 2026-08-13.
- `mpmath-besseljzero` — [mpmath `besseljzero` documentation path](https://mpmath.org/doc/1.3.0/functions/bessel.html#besseljzero), locator: API entry for Bessel-function zeros. The URL path says `1.3.0`, but the rendered HTML title observed on 2026-08-13 says “mpmath 1.2.0 documentation”; it is an interface locator only and does not substantiate a 1.3.0 documentation release. mpmath is BSD-3-Clause; no code is vendored.
- `mpmath-1.3.0-sdist` — [mpmath 1.3.0 source distribution](https://files.pythonhosted.org/packages/e0/47/dd32fa426cc72114383ac549964eecb20ecfd886d1e5ccf5340b55b02f57/mpmath-1.3.0.tar.gz), SHA-256 `7a28eb2a9774d00c7bc92411c19a89209d5da7c4c9a9e227be8330a23a25b91f`, BSD-3-Clause. This hashed source distribution, not the documentation URL, is the authoritative 1.3.0 reproduction artifact. Retrieved 2026-08-13.

## Known answer and target hash

The hidden target is `oracle-reproduction-j0-first-zero-v1`. Its target payload contains the reference decimal, tolerance, precision, and tool-artifact digest. Keep that payload outside the initial participant pack; its canonical JSON digest is checked by `check.mjs`.

## Expected ledger objects and validator behavior

Expected objects: computation evidence, an artifact manifest, an independent reproduction review, and `fails-to-reproduce` evidence when the rerun disagrees.

- P5: a result without precision and the absolute-error floor is downgraded from computation evidence.
- P8: an external target with no DLMF locator is treated as model memory, not retrieved evidence.
- P4: a matching local run cannot set `verified` or `strongly-supported`.

## Safety and privacy

The proposed command is local, carries no secrets, and requires no network during calculation. This repository records only a public source-distribution digest; it does not commit a package archive or participant output.

## Freshness

Tool release, source-distribution digest, and locators were checked on 2026-08-13. Reacquire and rehash the tool before W12.1 rather than trusting a mutable local environment.

## External review required

A numerical-analysis or scientific-computing reviewer from a different sponsor must independently acquire the pinned source, verify its digest, rerun before receiving the oracle decimal, and calculate the tolerance. This is required before the staging exercise.

## No-claim boundary

A matching decimal is a bounded observation, not an independent proof about `J₀`, evidence that the production artifact pipeline works, or independent scientific validation. W12.1 must obtain and record a separate rerun review.
