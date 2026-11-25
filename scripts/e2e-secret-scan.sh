#!/usr/bin/env bash
# W9.2 Secret/PII Scan & Scrub Parity E2E Gate (bead asimposiumorg-xka).
#
# Injects synthetic canaries across workshop, promotion, commentary, artifact
# CAS, path redaction, and Worker <-> Rust `asimp scrub` differential parity,
# emitting OPS.2a structured JSONL (digests, policy version, scanner version,
# coarse classes, status/code, duration_ms — NEVER canary bytes).
#
# Usage:
#   bash scripts/e2e-secret-scan.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

T0="$(bun -e 'console.log(Date.now())')"

# Verify compiled `asimp` binary exists (or build via rch/cargo if absent).
ASIMP_BIN="${ASIMP_BIN:-}"
if [[ -z "$ASIMP_BIN" ]]; then
  for cand in "$REPO_ROOT/target/debug/asimp" "$REPO_ROOT/target/release/asimp" "$REPO_ROOT/cli/target/debug/asimp" "$REPO_ROOT/cli/target/release/asimp"; do
    if [[ -x "$cand" ]]; then
      ASIMP_BIN="$cand"
      break
    fi
  done
fi
if [[ -z "$ASIMP_BIN" ]]; then
  echo '{"type":"error","code":"ASIMP_BIN_MISSING","hint":"Build cli with rch exec -- cargo build --manifest-path cli/Cargo.toml --locked -j 2"}' >&2
  exit 78
fi
export ASIMP_BIN

# 1. Worker unit credential-scan suite
(cd apps/wire && bun test --timeout=30000 ./test/unit/credential-scan.test.ts) >/dev/null

# 2. W9.2 mock-free D1/R2 ingest/egress canary injection + Worker<->asimp parity suite
(cd e2e/secret-scan && bun test --timeout=60000 ./secret-scan-e2e.test.ts) >/dev/null

# 3. Full cross-language differential parity harness (W11.3 + W9.2 vectors)
bun cli/tests/differential-parity.ts >/dev/null

T1="$(bun -e 'console.log(Date.now())')"
DUR=$((T1 - T0))

# Emit secret-safe OPS.2a structured JSONL summary (digests & policy version only).
bun -e '
import { W92_CANARY_VECTORS, W92_CORPUS_VERSION, W92_POLICY_VERSION } from "./e2e/secret-scan/canary-corpus.ts";
import { sha256Hex } from "./apps/wire/src/split/policy.ts";

const corpusDigest = await sha256Hex(JSON.stringify(W92_CANARY_VECTORS.map((v) => ({ id: v.id, wall: v.wall, coarse_class: v.coarse_class }))));
const summary = {
  type: "ops2a.secret_scan_gate",
  status: "pass",
  code: "W92_SECRET_SCAN_PARITY_PASS",
  corpus_version: W92_CORPUS_VERSION,
  corpus_digest: "sha256:" + corpusDigest,
  policy_version: W92_POLICY_VERSION,
  vectors_verified: W92_CANARY_VECTORS.length,
  surfaces: [
    "POST /v1/sessions/:id/workshop",
    "POST /v1/sessions/:id/promote",
    "POST /v1/sponsors/commentary",
    "CAS storeWorkshopBody / scanBodyForSecrets",
    "redactPathname (idempotency)",
    "Worker <-> Rust asimp scrub differential parity",
  ],
  canary_bytes_leaked: 0,
  duration_ms: Number(process.argv[1]),
  local_only: true,
  does_not_prove: ["hosted_sentry_scrub_pipeline (requires live Sentry DSN post-rs5n)"],
};
const serialized = JSON.stringify(summary);
for (const v of W92_CANARY_VECTORS) {
  for (const c of v.forbidden_canaries) {
    if (serialized.includes(c)) throw new Error("OPS2A_SUMMARY_CANARY_LEAK");
  }
}
console.log(serialized);
' "$DUR"
