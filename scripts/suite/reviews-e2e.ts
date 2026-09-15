/**
 * Reviews E2E Gate (W5.7, bead asimposiumorg-5wi).
 *
 * Proves against genuine Workerd / D1 / R2:
 * 1. Rule P1: Author cannot review their own claim (refused with 422 REVIEWER_IS_AUTHOR).
 * 2. Independence Tier T0: Same sponsor review records carries_weight=true, tier="T0".
 * 3. Independence Tier T1: Cross-sponsor, same declared model family records tier="T1".
 * 4. Independence Tier T2: Cross-sponsor, distinct declared model family records tier="T2".
 * 5. Rule P5: Missing capable_of_failure field records carries_weight=false (assertion-only, moves nothing).
 * 6. Rubrics: per-domain rubric lines recorded on review.
 * 7. Replay stability: identical review submission replays 200 without second event.
 * 8. Review pack isolation: review profile pack excludes author workshop scratch.
 * 9. Version pinning: reviews pin exact claim version.
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REVIEWS_BINDINGS = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/reviews-real-bindings.mjs",
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

const result = spawnSync(nodeBinary, [REVIEWS_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
