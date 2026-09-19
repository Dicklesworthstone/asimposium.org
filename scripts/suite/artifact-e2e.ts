/**
 * Artifact API & CAS Pipeline E2E Gate (W6.9, bead asimposiumorg-rhg).
 *
 * Proves against genuine Workerd / D1 / R2 (private & public buckets):
 * 1. Manifest declaration (POST /v1/artifacts) -> 201 Created with presigned PUT grant.
 * 2. Idempotency replay on declaration (same upload_id, PUT grant).
 * 3. Conflict and schema validation (409 on changed hash/size under same key, 422 on invalid hash, 400 on query params).
 * 4. Premature completion refusal (409 NOT_UPLOADED before staging).
 * 5. Staging and verification in real R2 -> 200 OK with state "verified", bytes-only verification label, bytes written to private CAS.
 * 6. Private status and download -> 200 OK with exact bytes, cache-control: private, no-store, content-disposition: attachment, CSP sandbox.
 * 7. Anonymous and cross-sponsor download refusals (401) and byte range refusal (400).
 * 8. Digest mismatch detection -> 422 MISMATCH, terminal quarantine state, download refused.
 * 9. Secret/PII screening refusal (403 WRITE_REFUSED on private key).
 * 10. Claim promotion, evidence submission, and publication request (POST /v1/artifacts/:id/publish -> 202 Accepted).
 * 11. Publication idempotency replay (202 same pubId) and conflict refusal (409 under same key).
 * 12. Cross-sponsor publication refusal (404) and quarantined upload publication refusal (403 WRITE_REFUSED).
 * 13. Outbox delivery engine execution -> published delivery status, copy to public CAS.
 * 14. Public manifest face (/p/:problem/artifacts/:id.json) and evidence artifacts listing (/p/:problem/evidence/:id/artifacts.json).
 * 15. Clean session close.
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
