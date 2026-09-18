/**
 * Dispositions E2E Gate (W5.4, bead asimposiumorg-3b9).
 *
 * Proves against genuine Workerd / D1 / R2 / Durable Objects:
 * 1. Rule P2/P4: Author cannot self-certify disposition or status in promote payload (refused with 422 SCHEMA_INVALID).
 * 2. Rule P1: Author cannot review own claim (refused with 422 REVIEWER_IS_AUTHOR).
 * 3. Refuter-first rule (ADR-9): Unrefuted confirmation displays as "open · unchallenged" until falsification check is recorded.
 * 4. Grounded falsification check moves claim to "corroborated".
 * 5. Full write-up independent verification across distinct model families moves claim to "strongly-supported".
 * 6. Rule P9 malformed state: statement defect in review moves claim to "malformed", and revision @2 resets disposition to "open".
 * 7. Counterevidence and refutations move claim to "disputed".
 * 8. Reduction relations move claim to "reduced-to".
 * 9. Author retractions move claim to "withdrawn" (terminal).
 * 10. Diptych parity: canonical .json, .md, and .html faces match computed disposition and share fingerprints with 304 ETag revalidation.
 * 11. OPS.2a structured diagnostic records log states, rules, and boundaries.
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REAL_BINDINGS = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/dispositions-real-bindings.mjs",
);

function selectGenuineNode(): string {
  if (process.env.ASIMPOSIUM_NODE_BINARY) {
    return process.env.ASIMPOSIUM_NODE_BINARY;
  }
  try {
    const whichOut = execSync("which -a node", { encoding: "utf8" });
    for (const candidate of whichOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
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

const result = spawnSync(nodeBinary, [REAL_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
