# Route-contract fixtures

Input trees for `scripts/route-contract.ts`. They are **not** compiled, linted,
or shipped — `tsconfig.json` and `eslint.config.mjs` both exclude this
directory, because most of these trees are malformed on purpose.

`valid-minimal/` must produce zero violations. Every `invalid-*/` tree exists to
prove one rule can actually fail, and the unit suite asserts the exact code, the
rule id, and the file it is reported against. A fixture that stops failing is a
regression in the validator, not a fixture to be repaired.
