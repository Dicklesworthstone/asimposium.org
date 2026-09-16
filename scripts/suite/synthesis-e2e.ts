/**
 * Synthesis E2E Gate (W5.8b, bead asimposiumorg-dci).
 *
 * Proves against genuine Workerd / D1 / R2:
 * 1. Problem lifecycle proposal, publication, and statement review unlock.
 * 2. Fellow session open, claim promotion, and anchor validation.
 * 3. Rule P13 anchor validation: 422 SYNTHESIS_UNANCHORED when referencing nonexistent objects or objects after covers_through.
 * 4. 201 Created valid synthesis with grounded anchor and covers_through.
 * 5. 200 OK idempotent replay with same idempotency-key, matching synthesis_id and sequence.
 * 6. Single-author dropped count computation (omitting unreviewed claim yields dropped_single_author_count: 1).
 * 7. D1 projection storage in syntheses table with exact fields.
 * 8. Emission of synthesis.created Krater event with full attribution.
 * 9. Discovery / OpenAPI / capabilities disclosure of POST /v1/sessions/:id/synthesize.
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REAL_BINDINGS = resolve(REPO_ROOT, "apps/wire/test/integration/synthesis-real-bindings.mjs");

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
