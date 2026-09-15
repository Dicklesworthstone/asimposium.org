/**
 * Problem Lifecycle E2E Gate (W5.1, bead asimposiumorg-5yu).
 *
 * Proves against genuine Workerd / D1 / R2:
 * 1. Sponsor problem brief creation, listing, assignment, and withdrawal with write isolation.
 * 2. Fellow problem proposal with private-draft isolation (absent from public index/faces).
 * 3. P11 duplicate statement screening (409 POSSIBLE_DUPLICATE without distinct_because).
 * 4. Sponsor publish to public sharpening status with atomic problem.admitted event.
 * 5. P3 claims board lock while in sharpening (422 CLAIMS_BOARD_LOCKED).
 * 6. Statement review: P1 author self-certification refusal (422 REVIEWER_IS_AUTHOR).
 * 7. Statement review: independent review (statement-clear) unlocks sharpening -> active with problem.statement-reviewed event.
 * 8. Active claims promotion on unlocked board.
 * 9. Problem statement revision (S@1 -> S@2): flags open claims with statement_drift = 1.
 * 10. P9 review refusal on drifted claims (422 STATEMENT_DRIFT).
 * 11. Author claim re-anchor (POST /v1/sessions/:id/reanchor): clears statement_drift to 0.
 * 12. Enter under-result-review and premature resolution refusal (rule P3).
 * 13. Famous problem guardrail check and problem resolution with closing synthesis.
 * 14. Problem retirement with problem.retired event.
 * 15. Problem ingress body limits (512 KiB) and malformed payload refusals.
 * 16. Real D1 lifecycle ledger transactions, concurrency races, rollbacks, and discovery isolation.
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const LIFECYCLE_BINDINGS = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/problem-lifecycle-real-bindings.mjs",
);
const LEDGER_BINDINGS = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/problem-lifecycle-ledger-real-bindings.mjs",
);

function selectGenuineNode(): string {
  if (process.env.ASIMPOSIUM_NODE_BINARY) {
    return process.env.ASIMPOSIUM_NODE_BINARY;
  }
  try {
    const whichOut = execSync("which -a node", { encoding: "utf8" });
    for (const candidate of whichOut.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const check = spawnSync(candidate, [
        "-e",
        "process.exit(!process.versions.bun && Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)",
      ]);
      if (check.status === 0) return candidate;
    }
  } catch {}
  return "node";
}

const nodeBinary = selectGenuineNode();

const lifecycleResult = spawnSync(nodeBinary, [LIFECYCLE_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (lifecycleResult.status !== 0) {
  process.exit(lifecycleResult.status ?? 1);
}

const ledgerResult = spawnSync(nodeBinary, [LEDGER_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (ledgerResult.status !== 0) {
  process.exit(ledgerResult.status ?? 1);
}
