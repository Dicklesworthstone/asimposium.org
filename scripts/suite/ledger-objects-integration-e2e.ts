/**
 * Ledger Objects Integration E2E Gate (W5.8, bead asimposiumorg-0vu).
 *
 * Proves against genuine Workerd / D1 / R2:
 * 1. Unified problem lifecycle and integration across all W5.8 objects:
 *    - Dead ends, nulls, retry triggers, and farming guards (W5.8a)
 *    - Syntheses and Rule P13 ledger anchoring (W5.8b)
 *    - Citations and source-provenance objects (W5.8c)
 *    - Leased questions, answers, and retractions (W5.8d)
 * 2. Rule P6 permanent negative knowledge: DB immutability triggers refuse direct DELETE
 *    on dead_ends, citations, citation_versions, questions, syntheses, and retractions.
 * 3. Rule P9/P11 version monotonicity, duplicate prevention, and conflict detection:
 *    - Duplicate citation and dead-end prevention (409 DUPLICATE_*)
 *    - Stale revision conflict rejection (409 OBJECT_VERSION_CONFLICT) on citations and dead-end supersession
 *    - Non-author modification refusal (403 NOT_*_AUTHOR)
 * 4. Leased questions and answers:
 *    - Leasable question posting, exclusive lease holding, conflict on concurrent lease (409)
 *    - Resolution via object reference, duplicate answer conflict (409)
 * 5. Rule P13 synthesis anchoring:
 *    - Unanchored synthesis targeting nonexistent objects rejected (422 SYNTHESIS_UNANCHORED)
 *    - Synthesis anchoring exact historical versions of claims and citations
 * 6. History-preserving retractions:
 *    - Author self-correction retraction recorded without deleting historical events or objects
 * 7. Rule A6 event log rebuild and strict sequence monotonicity:
 *    - All substantive ledger mutations append events with continuous monotonically increasing seq
 * 8. Rule A1 Diptych faces and exact-version retrieval:
 *    - Public .json, .md, .bib, and version-pinned faces (@version) serve canonical data
 * 9. OPS.2a secret-safe structured diagnostic logging.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REAL_BINDINGS = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/ledger-objects-integration-real-bindings.mjs",
);

const nodeBinary =
  process.env.ASIMPOSIUM_NODE_BINARY ||
  (existsSync("/home/ubuntu/.nvm/versions/node/v24.1.0/bin/node")
    ? "/home/ubuntu/.nvm/versions/node/v24.1.0/bin/node"
    : "node");

const result = spawnSync(nodeBinary, [REAL_BINDINGS], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
