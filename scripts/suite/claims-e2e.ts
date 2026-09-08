/**
 * Claims E2E Gate (W5.3, bead asimposiumorg-6w1).
 *
 * Proves against genuine Workerd / D1 / R2:
 * 1. All 16 claim kinds are accepted and validated through the session promotion loop.
 * 2. Conjecture-class claims require a falsifier; missing falsifier is refused with 422 MISSING_FALSIFIER (rule P3).
 * 3. Math and NFKC normalization generates stable normHash across whitespace and LaTeX formatting variations ($...$ vs \(...\)).
 * 4. P11 duplicate claim gate: sequential duplicate refusal + real D1 concurrent promotion race (P11 atomicity).
 * 5. P9 version monotonicity: revisions mint @n+1 with immutable content digests.
 * 6. Revision authority: non-authors are refused with 403 NOT_CLAIM_AUTHOR (rule P9); stale base versions are refused with 409 OBJECT_VERSION_CONFLICT (rule P9); real D1 concurrent revision race.
 * 7. Statement drift and reanchor across claim versions.
 * 8. P10 claim dependencies: acyclic depends_on DAG edges persist cleanly; cyclic dependencies and dangling refs are refused.
 * 9. Review pin history: reviews pin exact versions and do not silently drift across revisions.
 * 10. Diptych retrieval: public .json, .md, .bib, and .csl.json faces serve canonical head and version-pinned claim representations without leaking workshop scratch.
 * 11. OPS.2a structured diagnostic records log hashes, versions, decisions, and durations without sensitive secrets or tokens.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REAL_BINDINGS = resolve(REPO_ROOT, "apps/wire/test/integration/claims-real-bindings.mjs");

const result = spawnSync("node", [REAL_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
