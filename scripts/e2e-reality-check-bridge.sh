#!/usr/bin/env bash
# End-to-end local multi-actor Reality-Check Bridge verification & pre-deploy
# dry-run gate (Stages A-F, bead asimposiumorg-rc-final-bridge-e2e-gate-uxmh).
#
# Emits deterministic secret-safe NDJSON step trace (`step`, `duration_ms`,
# `verdict`, `failures[]`) and a final summary with an explicit local-vs-hosted
# no-claim boundary.
#
# Usage:
#   bash scripts/e2e-reality-check-bridge.sh [--quick] [--verify-regressions]
#
# Flags:
#   --quick               Skip the ~90s local Workerd gauntlet reference run
#                         (still runs all Stage A-F tests + loopback staging).
#   --verify-regressions  Also execute the 4 planted-regression should-fail
#                         controls and verify every one fails cleanly nonzero.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

QUICK=0
VERIFY_REGRESSIONS=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --verify-regressions) VERIFY_REGRESSIONS=1 ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "{\"type\":\"error\",\"code\":\"UNKNOWN_ARGUMENT\",\"arg\":\"$arg\"}" >&2
      exit 64
      ;;
  esac
done

now_ms() {
  bun -e 'console.log(Date.now())'
}

FAIL_COUNT=0
PASS_COUNT=0
FAILED_STEPS=()

run_step() {
  local step_name="$1"
  shift
  local t0 t1 dur rc out
  t0="$(now_ms)"
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  t1="$(now_ms)"
  dur=$((t1 - t0))
  if [[ "$rc" -eq 0 ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '{"type":"step","step":"%s","duration_ms":%d,"exit_code":0,"verdict":"pass","failures":[]}\n' \
      "$step_name" "$dur"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_STEPS+=("$step_name")
    local snippet_json
    snippet_json="$(printf '%s' "$out" | bun -e '
      const raw = await new Response(Bun.stdin.stream()).text();
      const tail = raw.split(/\r?\n/).slice(-6).join(" ")
        .replace(/asimp_ag_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
        .replace(/v1\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
        .slice(0, 400);
      console.log(JSON.stringify(tail));
    ')"
    printf '{"type":"step","step":"%s","duration_ms":%d,"exit_code":%d,"verdict":"fail","failures":[%s]}\n' \
      "$step_name" "$dur" "$rc" "$snippet_json"
  fi
}

# ── Stage A: Pre-Deploy Readiness, Bindings, Bundle Purity & CI Readiness ────
run_step "stage_a_infra_validators" \
  bash -c 'bun infra/validate-environments.mjs && bun infra/validate-scaffold.mjs && bun infra/generate-wrangler.mjs --check'

run_step "stage_a_prod_bundle_exclusions" \
  bash -c 'cd apps/wire && bun test --timeout=60000 ./test/unit/deploy-bundle-exclusions.test.ts'

run_step "stage_a_ci_readiness_check" \
  bun test --timeout=30000 ./scripts/suite/e2e-ci-pipeline.test.ts

# ── Stage B: Contracts, Ontology, Render/TOON, Protocol, Wire Bridge Suites ─
run_step "stage_b_contracts_drift_and_ontology" \
  bash -c 'bun run --filter @asimposium/contracts check:drift && cd packages/contracts && bun test --timeout=30000 ./test/contract/ontology-consumers.test.ts ./test/unit/public-watch.test.ts'

run_step "stage_b_render_and_protocol" \
  bash -c 'bun run --filter @asimposium/render test && bun run --filter @asimposium/protocol test'

run_step "stage_b_wire_bridge_subsystems" \
  bash -c 'cd apps/wire && bun test --timeout=60000 ./test/unit/public-moves.test.ts ./test/unit/herald-human-workshop-rooms.test.ts ./test/unit/outbox-consumers.test.ts ./test/unit/synthesis-draft-famous-resolve.test.ts ./test/unit/problem-resolution-lifecycle.test.ts ./test/unit/stats.test.ts ./test/unit/screening-appeals-http.test.ts ./test/unit/public-write-quota-routes.test.ts ./test/unit/discovery-generation.test.ts'

run_step "stage_b_s2_source_closure" \
  bash -c 'cd apps/wire && bun test --timeout=30000 ./test/unit/s2-krater-harness.test.ts -t "declared source list is closed"'

# ── Stage C: Cold-Agent Gauntlet (Staging Rehearsal + Real Local Workerd) ──
run_step "stage_c_gauntlet_staging_and_unit" \
  bash -c 'cd e2e/gauntlet && bun test --timeout=30000 ./staging-product-flow.test.ts ./orchestrate.test.ts ./gemini-sandbox.test.ts ./harness-agent.test.ts ./state-verdict.test.ts ./scorecard.test.ts ./token-accounting.test.ts ./token-accounting-codex.test.ts'

if [[ "$QUICK" -eq 0 ]]; then
  run_step "stage_c_gauntlet_local_workerd_12_cases" \
    bash e2e/gauntlet/run.sh --target local
fi

# ── Stage D/E: Agora Human UI, Diptych, Scholarly, Security & Herald Clients ─
run_step "stage_de_agora_bridge_tests" \
  bash -c 'cd apps/web && bun test --timeout=30000 ./test/unit/proxy-wrong-principal-and-report.test.ts ./test/unit/join-paste.test.ts ./test/unit/agora-scientific-wiring.test.tsx ./test/unit/protocol-admin.test.ts ./test/unit/public-ledger.test.ts ./test/unit/public-watch.test.ts ./test/unit/workshop-watch.test.ts ./test/unit/screening-appeal-transport.test.ts ./test/contract/agora-package.test.ts'

# ── Stage F: Ops, Cost Model, Artifact Archival, Beads Graph Hygiene ───────
run_step "stage_f_ops_archival_cost_and_beads_graph" \
  bash -c 'bun test --timeout=30000 ./scripts/check-beads-graph.test.ts ./scripts/archive-e2e-artifacts.test.ts ./scripts/verify-cost-model.test.ts ./scripts/suite/e2e-gate-fail-closed.test.ts && bun run scripts/check-beads-graph.ts && bash scripts/e2e-ops-runbooks.sh --local && bash scripts/e2e-error-recovery.sh --local'

# ── Planted-Regression Should-Fail Controls (Zero Repo Mutation) ───────────
if [[ "$VERIFY_REGRESSIONS" -eq 1 ]]; then
  run_step "planted_regression_controls_4x" \
    bun -e '
import { spawnSync } from "node:child_process";
import { auditBeadsGraph } from "./scripts/check-beads-graph.ts";
import { validateStagingAgentOrigin } from "./e2e/gauntlet/staging-product-flow.mjs";
import { scoreGauntlet } from "./e2e/gauntlet/scorecard.ts";

// 1. Production origin passed to staging Gauntlet MUST fail closed (exit 64).
const prod = spawnSync(process.execPath, ["e2e/gauntlet/run-gauntlet.ts"], {
  encoding: "utf8",
  env: { ...process.env, ASIMPOSIUM_STAGING_AGENT_BASE_URL: "https://a.asimposium.org" },
});
if (prod.status !== 64 || !prod.stdout.includes("STAGING_ORIGIN_PRODUCTION_FORBIDDEN")) {
  throw new Error("regression-1 failed: production origin was not refused fail-closed");
}

// 2. Validate origin helper refuses canonical production origin.
if (validateStagingAgentOrigin("https://asimposium.org").ok !== false) {
  throw new Error("regression-2 failed: apex origin was not refused");
}

// 3. Ungated launch target MUST fail Beads graph audit.
const graph = auditBeadsGraph(
  [
    { id: "asimposiumorg-rs5n", title: "OPERATOR ACTION: deploy", status: "open", issue_type: "task", priority: 0 },
    { id: "asimposiumorg-7ft", title: "S-7 G0 exit", status: "open", issue_type: "task", priority: 1 },
    { id: "asimposiumorg-oot", title: "W12.8 Launch gates", status: "open", issue_type: "task", priority: 1 },
  ],
  [{ issue_id: "asimposiumorg-7ft", depends_on_id: "asimposiumorg-rs5n", type: "blocks" }],
);
if (graph.ok !== false || !graph.violations.some((v) => v.code === "LAUNCH_GATE_UNGATED")) {
  throw new Error("regression-3 failed: ungated launch target passed audit");
}

// 4. 7/10 gauntlet completions MUST fail scorecard.
const sc = scoreGauntlet(
  Array.from({ length: 10 }, (_, i) => ({
    attemptIndex: i,
    harness: ["claude-code", "codex", "gemini"][i % 3],
    completed: i < 7,
    tokensUsed: 12000,
    stageReached: i < 7 ? "closed" : "pack_read",
  })),
);
if (sc.passed !== false) {
  throw new Error("regression-4 failed: 7/10 gauntlet cohort falsely passed");
}
console.log(JSON.stringify({ planted_regressions_caught: 4, ok: true }));
'
fi

TOTAL=$((PASS_COUNT + FAIL_COUNT))
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  printf '{"type":"summary","status":"pass","code":"REALITY_CHECK_BRIDGE_LOCAL_PASS","passed_steps":%d,"failed_steps":0,"total_steps":%d,"quick_mode":%s,"regressions_verified":%s,"local_only":true,"does_not_prove":["hosted_cloudflare_deploy (rs5n)","hosted_google_oauth (xeg/qnh)","hosted_workers_ai_s4_accuracy (xeg)","hosted_s2_edge_cache_cost (doa)","live_10_session_staging_gauntlet (zai/oot)"]}\n' \
    "$PASS_COUNT" "$TOTAL" "$( [[ "$QUICK" -eq 1 ]] && echo true || echo false )" "$( [[ "$VERIFY_REGRESSIONS" -eq 1 ]] && echo true || echo false )"
  exit 0
else
  failed_json="$(printf '%s\n' "${FAILED_STEPS[@]}" | bun -e '
    const raw = await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify(raw.split(/\r?\n/).filter(Boolean)));
  ')"
  printf '{"type":"summary","status":"fail","code":"REALITY_CHECK_BRIDGE_LOCAL_FAIL","passed_steps":%d,"failed_steps":%d,"total_steps":%d,"failed_step_names":%s,"local_only":true}\n' \
    "$PASS_COUNT" "$FAIL_COUNT" "$TOTAL" "$failed_json"
  exit 1
fi
