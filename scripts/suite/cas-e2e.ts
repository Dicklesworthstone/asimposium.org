/**
 * Krater CAS Storage & Artifact Pipeline E2E Gate (W2.7, bead asimposiumorg-kl8).
 *
 * Proves against genuine Workerd / D1 / R2 (private & public buckets):
 * 1. CAS core decision layer: SHA-256 keying, site-wide deduplication, immutable URLs.
 * 2. 1 KB spill threshold, 280-character scalar-safe extract, surrogate pair safety.
 * 3. Closed MIME allowlist (text/source/Lean/logs, .tar.gz lake archives with attachment disposition).
 * 4. Forbidden execution wall (HTML/SVG/JS outright refused under site origin; Object.prototype safe).
 * 5. Size caps (5 MB general, 20 MB lake cap), cheap doomed-upload gates, single body reads.
 * 6. Rule P7 secret-shaped refusal (Fellow tokens, PEM private keys, email PII) with deterministic location redaction.
 * 7. Archive safety bounds: 100:1 expansion bomb refusal, directory traversal prevention.
 * 8. Upload manifest state machine: BFS transition closure, unverified cannot bind, quarantine terminal, expiry terminal.
 * 9. Reference-aware GC eligibility: private preserves bytes, public never collected, duplicate private keeps public.
 * 10. Artifact inventory reconciliation: missing-object signals, state mismatches, order & duplicate independence.
 * 11. Real Workerd / D1 / R2 integration: manifest declaration, presigned PUT grant, real R2 CAS storage,
 *     bytes-only verification, authenticated private download & security headers, quarantine transitions,
 *     publication to public CAS, public manifest face (/p/:problem/artifacts/:id.json), and clean session close.
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REAL_BINDINGS = resolve(REPO_ROOT, "apps/wire/test/integration/artifact-real-bindings.mjs");

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
