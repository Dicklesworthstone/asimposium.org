#!/usr/bin/env bash
# S-5 Diptych spike, end to end (bead asimposiumorg-6jo).
#
# Phase 1 (local, runs today): render one projection to all three faces through
# @asimposium/render, compare semantic digests, assert the markdown control header, and
# seed a private workshop canary that must be absent from every public face. Emits
# OPS.2a-shaped NDJSON on stdout — digests only, never a rendered body, a workshop byte,
# a credential, a cookie, a token or a fragment.
#
# Phase 2 (Worker-served): serve the same projection from the local Worker and compare the
# served bytes and headers against phase 1. This phase is BLOCKED today and says so rather
# than pretending: at OPS.1 apps/wire serves exactly one route (/internal/health), declares
# no dependency on @asimposium/render, and the public face surface is W4–W6 work. A phase
# that cannot run honestly exits 78 (the root-owned blocked code) instead of exiting 0 and
# looking green.
#
# Usage:
#   bash scripts/e2e-s5-diptych.sh                 # phase 1, then report phase 2 blocked
#   ASIMP_WORKER_ORIGIN=http://127.0.0.1:8787 \
#     bash scripts/e2e-s5-diptych.sh               # additionally probe a running Worker
#
# Exit codes: 0 every phase ran and passed · 1 an assertion failed · 78 nothing failed but
# a phase is blocked on named future work.

set -euo pipefail

BLOCKED_EXIT=78
SEED="${ASIMP_S5_SEED:-s5-fixed-seed-v1}"
REPRO="bash scripts/e2e-s5-diptych.sh"

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ROOT="$(repo_root)"
cd "$ROOT"

# One NDJSON record for a phase-level outcome. Keys are sorted to match the driver's own
# records so a consumer reads one shape. Values are literals here: no paths, no env values.
phase_record() {
  local assertion="$1" status="$2" detail="$3" duration="$4"
  printf '{"assertion":"%s","detail":"%s","duration_ms":%s,"repro":"%s","seed":"%s","spike":"s5-diptych","status":"%s"}\n' \
    "$assertion" "$detail" "$duration" "$REPRO" "$SEED" "$status"
}

# Bash's own second counter: `date +%s%3N` is GNU-only and BSD date passes `%3N` through
# unchanged, which turns the later arithmetic into a runtime error on macOS. Per-assertion
# millisecond timings come from the driver; this is only the phase envelope.
SECONDS=0

# ── phase 1: local render ───────────────────────────────────────────────────
phase1_status=0
bun packages/render/scripts/s5-spike.ts --seed "$SEED" || phase1_status=$?

if [ "$phase1_status" -ne 0 ]; then
  phase_record "phase1_local_render" "fail" "the local spike driver reported a failed assertion" 0
  exit 1
fi

# ── phase 1b: the golden faces are the drift backstop ───────────────────────
golden_status=0
( cd packages/render && bun test test/contract/golden.test.ts >/dev/null 2>&1 ) || golden_status=$?
if [ "$golden_status" -ne 0 ]; then
  phase_record "phase1_golden_faces" "fail" "checked-in golden faces no longer match; run the suite to see the line" 0
  exit 1
fi
phase_record "phase1_golden_faces" "pass" "checked-in md/json/html goldens match byte for byte" 0

# ── phase 2: Worker-served ──────────────────────────────────────────────────
# Honest detection, in this order: is an origin supplied at all, and does it serve a face?
if [ -z "${ASIMP_WORKER_ORIGIN:-}" ]; then
  phase_record "phase2_worker_served" "blocked" \
    "no ASIMP_WORKER_ORIGIN supplied and apps-wire serves no face route at OPS.1 (only internal-health); needs the W4-W6 public surface plus a render dependency in the Worker" 0
  phase_record "spike_summary" "blocked" "phase 1 passed; phase 2 blocked on the Worker face surface" 0
  exit "$BLOCKED_EXIT"
fi

# An origin was supplied: probe it rather than assuming. A 404 is the honest answer that
# the route does not exist yet, and it stays blocked rather than becoming a failure.
# curl prints `000` itself when it cannot connect, so no `|| echo` fallback: that would
# concatenate a second code onto the first and produce `000000`.
probe_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "${ASIMP_WORKER_ORIGIN}/p/demo-bounded-sums.md" 2>/dev/null || true)"
probe_status="${probe_status:-000}"

case "$probe_status" in
  200)
    phase_record "phase2_worker_served" "fail" \
      "the Worker served a face but this script does not yet compare it; wire the comparison before claiming this phase" 0
    exit 1
    ;;
  404)
    phase_record "phase2_worker_served" "blocked" \
      "the Worker answered 404: no public face route exists yet (W4-W6)" 0
    ;;
  000)
    phase_record "phase2_worker_served" "blocked" \
      "no Worker answered at the supplied origin; start wrangler dev before rerunning" 0
    ;;
  *)
    phase_record "phase2_worker_served" "blocked" \
      "the Worker answered ${probe_status} rather than a face; no comparison is possible yet" 0
    ;;
esac

phase_record "spike_summary" "blocked" "phase 1 passed; phase 2 blocked on the Worker face surface" "$((SECONDS * 1000))"
exit "$BLOCKED_EXIT"
