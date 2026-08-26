#!/usr/bin/env bash
# Flush beads DB -> its certified issues.jsonl, then stage a public projection
# without source_repo_path while leaving the certified working file untouched.
# Always use this instead of bare `br sync --flush-only` (see AGENTS.md).
set -euo pipefail
cd "$(dirname "$0")/.."

BEADS_JSONL=".beads/issues.jsonl"
BEADS_CERT_PATHS=(
  ".beads/beads.db-wal-cert"
  ".beads/beads.db-wal-cert-head"
)
BEADS_TRACKED_PATHS=(
  "$BEADS_JSONL"
  "${BEADS_CERT_PATHS[@]}"
)

assert_beads_stage_paths_safe() {
  local stage_path
  for stage_path in "${BEADS_TRACKED_PATHS[@]}"; do
    if [ ! -f "$stage_path" ] || [ -L "$stage_path" ]; then
      echo "beads-flush: refusing missing or non-regular sync path: $stage_path" >&2
      return 1
    fi
  done

  if ! git ls-files --error-unmatch -- "${BEADS_TRACKED_PATHS[@]}" >/dev/null 2>&1; then
    echo "beads-flush: refusing an untracked sync path" >&2
    return 1
  fi
}

sanitize_beads_jsonl() {
  jq -c 'del(.source_repo_path)' "$@"
}

stage_public_beads_files() {
  local git_runner="${1:-git}"

  assert_beads_stage_paths_safe

  local jsonl_blob
  jsonl_blob="$(sanitize_beads_jsonl "$BEADS_JSONL" | "$git_runner" hash-object -w --stdin)"
  if { [ "${#jsonl_blob}" -ne 40 ] && [ "${#jsonl_blob}" -ne 64 ]; } ||
    [ -n "${jsonl_blob//[0-9a-f]/}" ]; then
    echo "beads-flush: refusing an invalid sanitized JSONL blob id" >&2
    return 1
  fi

  "$git_runner" update-index --add --cacheinfo "100644,$jsonl_blob,$BEADS_JSONL"
  "$git_runner" add -- "${BEADS_CERT_PATHS[@]}"
}

self_test() {
  local fake_blob="0000000000000000000000000000000000000000"
  local working_blob_before
  working_blob_before="$(git hash-object "$BEADS_JSONL")"
  local -a captured_update_args=()
  local -a captured_add_args=()
  local -a expected_update_args=(
    "update-index"
    "--add"
    "--cacheinfo"
    "100644,$fake_blob,.beads/issues.jsonl"
  )
  local -a expected_add_args=(
    "add"
    "--"
    ".beads/beads.db-wal-cert"
    ".beads/beads.db-wal-cert-head"
  )

  capture_git_args() {
    case "${1:-}" in
      hash-object)
        if [ "$#" -ne 3 ] || [ "${2:-}" != "-w" ] || [ "${3:-}" != "--stdin" ]; then
          echo "beads-flush self-test: sanitized blob creation arguments drifted" >&2
          return 1
        fi
        if ! jq -s -e 'length > 0 and all(.[]; (has("source_repo_path") | not))' >/dev/null; then
          echo "beads-flush self-test: staged JSONL projection is invalid or exposes a local path" >&2
          return 1
        fi
        printf '%s\n' "$fake_blob"
        ;;
      update-index)
        captured_update_args=("$@")
        ;;
      add)
        captured_add_args=("$@")
        ;;
      *)
        echo "beads-flush self-test: unexpected git operation" >&2
        return 1
        ;;
    esac
  }

  stage_public_beads_files capture_git_args

  if [ "$(git hash-object "$BEADS_JSONL")" != "$working_blob_before" ]; then
    echo "beads-flush self-test: staging changed the certified working JSONL" >&2
    return 1
  fi

  if [ "${#captured_update_args[@]}" -ne "${#expected_update_args[@]}" ]; then
    echo "beads-flush self-test: unexpected update-index argument count" >&2
    return 1
  fi

  local index
  for ((index = 0; index < ${#expected_update_args[@]}; index += 1)); do
    if [ "${captured_update_args[$index]}" != "${expected_update_args[$index]}" ]; then
      echo "beads-flush self-test: sanitized JSONL staging drifted at argument $index" >&2
      return 1
    fi
  done

  if [ "${#captured_add_args[@]}" -ne "${#expected_add_args[@]}" ]; then
    echo "beads-flush self-test: unexpected certificate staging argument count" >&2
    return 1
  fi
  for ((index = 0; index < ${#expected_add_args[@]}; index += 1)); do
    if [ "${captured_add_args[$index]}" != "${expected_add_args[$index]}" ]; then
      echo "beads-flush self-test: certificate staging allowlist drifted at argument $index" >&2
      return 1
    fi
  done

  local sanitized_fixture
  sanitized_fixture="$(
    printf '%s\n' '{"id":"fixture","source_repo_path":"/private/host","nested":{"source_repo_path":"preserve"}}' |
      sanitize_beads_jsonl
  )"
  if [ "$sanitized_fixture" != '{"id":"fixture","nested":{"source_repo_path":"preserve"}}' ]; then
    echo "beads-flush self-test: public source_repo_path sanitizer drifted" >&2
    return 1
  fi

  if rg -n 'git add[[:space:]]+\.beads/' AGENTS.md README.md scripts/beads-flush.sh package.json; then
    echo "beads-flush self-test: an authoritative surface still teaches broad Beads staging" >&2
    return 1
  fi

  echo "BEADS_FLUSH_SELF_TEST_GREEN"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit
fi

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/beads-flush.sh [--self-test]" >&2
  exit 2
fi

assert_beads_stage_paths_safe
br sync --flush-only
assert_beads_stage_paths_safe

SOURCE_PATH_COUNT="$(jq -s '[.[] | select(has("source_repo_path"))] | length' "$BEADS_JSONL")"
stage_public_beads_files
echo "beads-flush: staged a public JSONL projection with $SOURCE_PATH_COUNT local path fields removed"
echo "beads-flush: the Beads-certified working JSONL remains unchanged"
