#!/usr/bin/env bash
# S-5 Diptych spike, end to end (bead asimposiumorg-6jo).
#
# Phase 1 (local): render one projection to all three faces through @asimposium/render,
# compare semantic digests, assert the markdown control header, and seed a private workshop
# canary that must be absent from every public face.
#
# Phase 1b: the checked-in golden faces, which are the byte-level drift backstop.
#
# Phase 2 (Worker-served): start real local wrangler/workerd on the unmounted harness
# entrypoint apps/wire/src/render-face/worker.ts and compare the *served* bytes against a
# local render — media type, ETag, If-None-Match 304, and the canary's absence on public
# faces. No binding is touched, so nothing is mocked; the harness is not the W4-W6 public
# surface and answers 404 on product routes, which phase 2 asserts.
#
# Evidence discipline: a failing gate prints the tool's own stdout and stderr, redacted for
# absolute paths and credential shapes. A record that says "a gate failed" without the
# tool's output is not evidence (this script used to do exactly that).
#
# Usage:
#   bash scripts/e2e-s5-diptych.sh
#   S5_PORT=8799 bash scripts/e2e-s5-diptych.sh
#
# Exit codes: 0 every phase ran and passed · 1 an assertion failed · 78 a phase is blocked
# on named future work.

set -uo pipefail

readonly BLOCKED_EXIT=78
readonly SEED="${ASIMP_S5_SEED:-s5-fixed-seed-v1}"
readonly REPRO="bash scripts/e2e-s5-diptych.sh"
readonly PORT="${S5_PORT:-8793}"
readonly ORIGIN="http://127.0.0.1:${PORT}"
readonly WRANGLER="apps/wire/node_modules/.bin/wrangler"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
readonly ROOT="$PWD"
readonly RUN_DIR="$(mktemp -d -t asimposium-s5)"
if [[ -z "${RUN_DIR}" || ! -d "${RUN_DIR}" ]]; then
  printf '{"spike":"s5-diptych","assertion":"scratch_dir","status":"fail","detail":"mktemp failed"}\n'
  exit 1
fi

SECONDS=0

phase_record() {
  local assertion="$1" status="$2" detail="$3" duration="$4"
  printf '{"assertion":"%s","detail":"%s","duration_ms":%s,"repro":"%s","seed":"%s","spike":"s5-diptych","status":"%s"}\n' \
    "$assertion" "$detail" "$duration" "$REPRO" "$SEED" "$status"
}

# Print a captured log so a failure is diagnosable, with absolute paths and credential
# shapes removed. Bounded: a runaway log must not bury the record that explains it.
show_redacted() {
  local label="$1" file="$2" limit="${3:-60}"
  printf '%s\n' "--- ${label} (redacted, first ${limit} lines) ---" >&2
  # `|` as the delimiter throughout: an enrollment fragment pattern starts with `#`, and
  # reusing `#` as the delimiter makes sed fail exactly when a failure needs to be shown.
  sed -e "s|${ROOT}|<repo>|g" -e "s|${HOME}|<home>|g" \
      -e 's|asimp_ag_[A-Za-z0-9_-]\{4,\}|<redacted>|g' \
      -e 's|Bearer [A-Za-z0-9._~+/-]\{8,\}|<redacted>|g' \
      -e 's|#v1\.[A-Za-z0-9._~-]\{8,\}|<redacted>|g' \
      "$file" | head -n "$limit" >&2
  printf '%s\n' "--- end ${label} ---" >&2
}

# ── phase 1: local render ───────────────────────────────────────────────────
if ! bun packages/render/scripts/s5-spike.ts --seed "$SEED"; then
  phase_record "phase1_local_render" "fail" "the local spike driver reported a failed assertion" 0
  exit 1
fi

# ── phase 1b: golden faces ──────────────────────────────────────────────────
readonly GOLDEN_LOG="${RUN_DIR}/golden.log"
golden_status=0
( cd packages/render && bun test test/contract/golden.test.ts ) >"${GOLDEN_LOG}" 2>&1 || golden_status=$?
if [[ ${golden_status} -ne 0 ]]; then
  # The suite prints the face, the line number and both sides. Suppressing that and saying
  # "run the suite to see the line" wastes the one output that makes the gate actionable.
  show_redacted "golden faces" "${GOLDEN_LOG}"
  phase_record "phase1_golden_faces" "fail" "checked-in golden faces no longer match; the suite output is above" 0
  exit 1
fi
phase_record "phase1_golden_faces" "pass" "checked-in md/json/html goldens match byte for byte" 0

# ── phase 2: Worker-served ──────────────────────────────────────────────────
if [[ ! -x "${WRANGLER}" ]]; then
  phase_record "phase2_worker_served" "blocked" "wrangler is not installed under apps/wire; run bun install" 0
  phase_record "spike_summary" "blocked" "phase 1 passed; phase 2 blocked on the local toolchain" 0
  exit "${BLOCKED_EXIT}"
fi

readonly SERVER_LOG="${RUN_DIR}/wrangler.log"
"${WRANGLER}" dev apps/wire/src/render-face/worker.ts \
  --config infra/wrangler.toml \
  --local \
  --persist-to "${RUN_DIR}" \
  --port "${PORT}" \
  --log-level error \
  --show-interactive-dev-session=false \
  >"${SERVER_LOG}" 2>&1 &
readonly SERVER_PID=$!

ready=0
for _attempt in {1..40}; do
  if curl --silent --output /dev/null --max-time 2 "${ORIGIN}/__s5/face?format=md"; then
    ready=1
    break
  fi
  sleep 0.25
done

stop_server() {
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null
    wait "${SERVER_PID}" 2>/dev/null
  fi
}

if [[ ${ready} -ne 1 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  stop_server
  phase_record "phase2_worker_served" "fail" "the local Worker did not answer; its log is above" "$((SECONDS * 1000))"
  exit 1
fi

readonly CHECK_LOG="${RUN_DIR}/check.log"
S5_ORIGIN="${ORIGIN}" bun apps/wire/src/render-face/check.ts 2>"${CHECK_LOG}"
readonly CHECK_EXIT=$?
if [[ -s "${CHECK_LOG}" ]]; then
  show_redacted "phase 2 stderr" "${CHECK_LOG}" 40
fi
stop_server

if [[ ${CHECK_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}" 40
  phase_record "phase2_worker_served" "fail" "served faces disagreed with the local render; records and logs are above" "$((SECONDS * 1000))"
  exit 1
fi

phase_record "phase2_worker_served" "pass" "served bytes, media types, ETags, 304s and canary absence all match the local render" "$((SECONDS * 1000))"
phase_record "spike_summary" "pass" "local render, goldens and the workerd-served faces agree" "$((SECONDS * 1000))"
