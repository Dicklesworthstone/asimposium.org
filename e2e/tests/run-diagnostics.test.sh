#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

# Race fixtures override the already-sourced checker only inside this test
# process. With injection disabled this is the production predicate verbatim;
# a selected invocation plants the fence immediately before that check. This
# exercises the post-lease and post-run-claim checks without exposing a
# production callback that an inherited Bash function could trigger.
e2e_test_maintenance_check_count=0
e2e_test_fence_on_maintenance_check=0
e2e_artifact_maintenance_absent_at_root() {
  local checked_repository_root="$1"
  local physical_repository_root
  local physical_e2e_root
  local fence

  physical_repository_root="$(e2e_physical_directory "$checked_repository_root")" || return 1
  physical_e2e_root="$(e2e_physical_directory "$physical_repository_root/e2e")" || return 1
  [[ "$physical_e2e_root" == "$physical_repository_root/e2e" ]] || return 1
  fence="$physical_e2e_root/$ASIMPOSIUM_E2E_ARTIFACT_MAINTENANCE_FENCE"
  if ((e2e_test_fence_on_maintenance_check > 0)); then
    e2e_test_maintenance_check_count=$((e2e_test_maintenance_check_count + 1))
    if ((e2e_test_maintenance_check_count == e2e_test_fence_on_maintenance_check)); then
      : > "$fence" || return 1
    fi
  fi
  [[ ! -e "$fence" && ! -L "$fence" ]]
}

e2e_test_acquired_lease_is_closed_for_root() {
  local checked_repository_root="$1"
  local root_identity="$2"
  local epoch_directory
  local lease_directory="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH"
  local lease_identity="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY"
  local closed_marker="$lease_directory/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED"

  epoch_directory="$(
    e2e_artifact_writer_lease_epoch_at_root "$checked_repository_root" "$root_identity"
  )" || return 1
  [[ -n "$lease_directory" \
    && "${lease_directory%/*}" == "$epoch_directory" \
    && -d "$lease_directory" \
    && ! -L "$lease_directory" \
    && "$(e2e_artifact_directory_identity "$lease_directory")" == "$lease_identity" \
    && -d "$closed_marker" \
    && ! -L "$closed_marker" \
    && "$(e2e_physical_directory "$closed_marker")" == "$closed_marker" ]]
}

suite="run-diagnostics-unit"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/run-diagnostics.test.sh"

fail() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 1
}

if ! e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"; then
  fail "HARNESS_SELF_TEST_FAILED"
fi

for valid_run_id in "a" "OPS.1-20260813" "run_42"; do
  e2e_validate_run_id "$valid_run_id" || {
    fail "VALID_RUN_ID_REJECTED"
  }
done

for invalid_run_id in "../traversal" "nested/path" "-leading-dash" "contains space"; do
  if e2e_validate_run_id "$invalid_run_id"; then
    fail "INVALID_RUN_ID_ACCEPTED"
  fi
done

export ASIMPOSIUM_TEST_STAGING_ORIGIN="https://agent-preview.example:443"
e2e_validate_staging_origin "ASIMPOSIUM_TEST_STAGING_ORIGIN" \
  || fail "VALID_STAGING_ORIGIN_REJECTED"
for production_origin in \
  "https://asimposium.org" \
  "https://www.asimposium.org.:443" \
  "https://A.ASIMPOSIUM.ORG:8443" \
  "https://artifacts.asimposium.org"; do
  export ASIMPOSIUM_TEST_STAGING_ORIGIN="$production_origin"
  if e2e_validate_staging_origin "ASIMPOSIUM_TEST_STAGING_ORIGIN"; then
    fail "PRODUCTION_ORIGIN_ACCEPTED_AS_STAGING"
  fi
done
for malformed_origin in \
  'https://agent-preview.example\backslash' \
  'https://agent-preview.example;forged' \
  'https://-agent-preview.example' \
  'https://agent-preview-.example' \
  'https://agent-preview.example:0' \
  'https://agent-preview.example:0443' \
  'https://agent-preview.example:65536'; do
  export ASIMPOSIUM_TEST_STAGING_ORIGIN="$malformed_origin"
  if e2e_validate_staging_origin "ASIMPOSIUM_TEST_STAGING_ORIGIN"; then
    fail "MALFORMED_STAGING_AUTHORITY_ACCEPTED"
  fi
done
unset ASIMPOSIUM_TEST_STAGING_ORIGIN

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-artifact.XXXXXX")" || fail "TEMPORARY_FIXTURE_UNAVAILABLE"
mkdir -p "$temporary_root/e2e" "$temporary_root/outside" || fail "TEMPORARY_FIXTURE_LAYOUT_FAILED"

if absent_root_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "absent-run" "$suite" "$started_ms" "fail" "ABSENT_ROOT_TEST" "$reproduce" 2>&1)"; then
  fail "UNCLAIMED_ABSENT_ROOT_WRITE_ACCEPTED"
fi
if [[ -n "$absent_root_output" || -e "$temporary_root/e2e/artifacts" ]]; then
  fail "UNCLAIMED_ABSENT_ROOT_WRITE_MUTATED_OR_LEAKED"
fi

e2e_claim_artifact_run_at_root "$temporary_root" "claimed-run" \
  || fail "UNIQUE_ARTIFACT_RUN_REJECTED"
claimed_root_identity="$(e2e_artifact_directory_identity "$temporary_root/e2e/artifacts")" \
  || fail "ARTIFACT_WRITER_LEASE_IDENTITY_UNAVAILABLE"
if e2e_artifact_writer_leases_quiescent_at_root "$temporary_root" "$claimed_root_identity"; then
  fail "OPEN_ARTIFACT_WRITER_LEASE_REPORTED_QUIESCENT"
fi
if [[ "${#ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[@]}" -ne 1 \
  || ! "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[0]}" =~ /e2e/\.artifact-writer-leases/dev-[0-9]+-ino-[0-9]+/lease-[0-9]+-[0-9]+-[0-9]+-[0-9]+$ \
  || ! -d "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[0]}" \
  || -L "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[0]}" ]]; then
  fail "ARTIFACT_WRITER_LEASE_SHAPE_INVALID"
fi
if second_claim_output="$(e2e_claim_artifact_run_at_root "$temporary_root" "claimed-run" 2>&1)"; then
  fail "REUSED_ARTIFACT_RUN_ACCEPTED"
fi
if [[ -n "$second_claim_output" ]]; then
  fail "REUSED_ARTIFACT_RUN_LEAKED"
fi

namespaced_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-namespaced.XXXXXX")" \
  || fail "NAMESPACED_CLAIM_FIXTURE_UNAVAILABLE"
mkdir -p "$namespaced_root/e2e" || fail "NAMESPACED_CLAIM_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_namespaced_run_at_root "$namespaced_root" s2-krater nested-run \
  || fail "NAMESPACED_CLAIM_REJECTED"
namespaced_root_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
namespaced_namespace_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY"
namespaced_run_identity="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
namespaced_lease_path="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
namespaced_lease_identity="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
if [[ "$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_DIRECTORY" != \
    "$namespaced_root/e2e/artifacts/s2-krater" \
  || "$ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY" != \
    "$namespaced_root/e2e/artifacts/s2-krater/nested-run" ]] \
  || ! e2e_artifact_namespaced_run_matches_at_root \
    "$namespaced_root" s2-krater nested-run \
    "$namespaced_root_identity" "$namespaced_namespace_identity" \
    "$namespaced_run_identity" "$namespaced_lease_path" "$namespaced_lease_identity" \
  || e2e_artifact_writer_leases_quiescent_at_root \
    "$namespaced_root" "$namespaced_root_identity"; then
  fail "NAMESPACED_CLAIM_CAPABILITY_INVALID"
fi
if repeated_namespaced_output="$(
  e2e_claim_artifact_namespaced_run_at_root "$namespaced_root" s2-krater nested-run 2>&1
)"; then
  fail "REUSED_NAMESPACED_RUN_ACCEPTED"
fi
if [[ -n "$repeated_namespaced_output" \
  || -n "$(find "$namespaced_root/e2e/artifacts/s2-krater/nested-run" -mindepth 1 -print -quit)" ]]; then
  fail "REUSED_NAMESPACED_RUN_MUTATED_OR_LEAKED"
fi
e2e_close_artifact_writer_lease "$namespaced_lease_path" "$namespaced_lease_identity" \
  || fail "NAMESPACED_CLAIM_CLOSE_FAILED"
if ! e2e_artifact_writer_leases_quiescent_at_root \
  "$namespaced_root" "$namespaced_root_identity"; then
  fail "CLOSED_NAMESPACED_CLAIM_REPORTED_OPEN"
fi

namespaced_fence_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-namespaced-fence.XXXXXX")" \
  || fail "NAMESPACED_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$namespaced_fence_root/e2e" || fail "NAMESPACED_FENCE_FIXTURE_UNAVAILABLE"
e2e_test_maintenance_check_count=0
e2e_test_fence_on_maintenance_check=3
if e2e_claim_artifact_namespaced_run_at_root \
  "$namespaced_fence_root" s2-krater fenced-run >/dev/null 2>&1; then
  fail "NAMESPACED_RUN_FENCE_RACE_ACCEPTED"
fi
e2e_test_fence_on_maintenance_check=0
namespaced_fence_identity="$(
  e2e_artifact_directory_identity "$namespaced_fence_root/e2e/artifacts"
)" || fail "NAMESPACED_FENCE_FIXTURE_UNAVAILABLE"
if [[ "$e2e_test_maintenance_check_count" -ne 3 \
  || ! -d "$namespaced_fence_root/e2e/artifacts/s2-krater" \
  || -e "$namespaced_fence_root/e2e/artifacts/s2-krater/fenced-run" ]] \
  || ! e2e_test_acquired_lease_is_closed_for_root \
    "$namespaced_fence_root" "$namespaced_fence_identity" \
  || ! e2e_artifact_writer_leases_quiescent_at_root \
    "$namespaced_fence_root" "$namespaced_fence_identity"; then
  fail "NAMESPACED_RUN_FENCE_RACE_MUTATED_OR_LEFT_OPEN"
fi

namespaced_post_claim_fence_root="$(
  mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-namespaced-post-claim-fence.XXXXXX"
)" || fail "NAMESPACED_POST_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$namespaced_post_claim_fence_root/e2e" \
  || fail "NAMESPACED_POST_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
e2e_test_maintenance_check_count=0
e2e_test_fence_on_maintenance_check=5
if e2e_claim_artifact_namespaced_run_at_root \
  "$namespaced_post_claim_fence_root" s2-krater fenced-run >/dev/null 2>&1; then
  fail "NAMESPACED_POST_CLAIM_FENCE_RACE_ACCEPTED"
fi
e2e_test_fence_on_maintenance_check=0
namespaced_post_claim_fence_identity="$(
  e2e_artifact_directory_identity "$namespaced_post_claim_fence_root/e2e/artifacts"
)" || fail "NAMESPACED_POST_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
if [[ "$e2e_test_maintenance_check_count" -ne 5 \
  || ! -d "$namespaced_post_claim_fence_root/e2e/artifacts/s2-krater/fenced-run" \
  || -n "$(
    find "$namespaced_post_claim_fence_root/e2e/artifacts/s2-krater/fenced-run" \
      -mindepth 1 -print -quit
  )" ]] \
  || ! e2e_test_acquired_lease_is_closed_for_root \
    "$namespaced_post_claim_fence_root" "$namespaced_post_claim_fence_identity" \
  || ! e2e_artifact_writer_leases_quiescent_at_root \
    "$namespaced_post_claim_fence_root" "$namespaced_post_claim_fence_identity"; then
  fail "NAMESPACED_POST_CLAIM_FENCE_RACE_MUTATED_OR_LEFT_OPEN"
fi

namespaced_namespace_swap_root="$(
  mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-namespaced-namespace-swap.XXXXXX"
)" || fail "NAMESPACED_NAMESPACE_SWAP_FIXTURE_UNAVAILABLE"
mkdir -p "$namespaced_namespace_swap_root/e2e" \
  || fail "NAMESPACED_NAMESPACE_SWAP_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_namespaced_run_at_root \
  "$namespaced_namespace_swap_root" s2-krater swap-run \
  || fail "NAMESPACED_NAMESPACE_SWAP_CLAIM_REJECTED"
namespace_swap_root_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
namespace_swap_namespace_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY"
namespace_swap_run_identity="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
namespace_swap_lease_path="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
namespace_swap_lease_identity="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
mv "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater" \
  "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater-original" \
  || fail "NAMESPACED_NAMESPACE_SWAP_FIXTURE_UNAVAILABLE"
mkdir "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater" \
  || fail "NAMESPACED_NAMESPACE_SWAP_FIXTURE_UNAVAILABLE"
mv "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater-original/swap-run" \
  "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater/swap-run" \
  || fail "NAMESPACED_NAMESPACE_SWAP_FIXTURE_UNAVAILABLE"
if e2e_artifact_namespaced_run_matches_at_root \
  "$namespaced_namespace_swap_root" s2-krater swap-run \
  "$namespace_swap_root_identity" "$namespace_swap_namespace_identity" \
  "$namespace_swap_run_identity" "$namespace_swap_lease_path" \
  "$namespace_swap_lease_identity"; then
  fail "REPLACED_ARTIFACT_NAMESPACE_ACCEPTED"
fi
if [[ -n "$(
    find "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater/swap-run" \
      -mindepth 1 -print -quit
  )" \
  || -n "$(
    find "$namespaced_namespace_swap_root/e2e/artifacts/s2-krater-original" \
      -mindepth 1 -print -quit
  )" ]]; then
  fail "REPLACED_ARTIFACT_NAMESPACE_MUTATED"
fi
e2e_close_artifact_writer_lease "$namespace_swap_lease_path" "$namespace_swap_lease_identity" \
  || fail "NAMESPACED_NAMESPACE_SWAP_CLOSE_FAILED"

namespaced_run_swap_root="$(
  mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-namespaced-run-swap.XXXXXX"
)" || fail "NAMESPACED_RUN_SWAP_FIXTURE_UNAVAILABLE"
mkdir -p "$namespaced_run_swap_root/e2e" \
  || fail "NAMESPACED_RUN_SWAP_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_namespaced_run_at_root "$namespaced_run_swap_root" s2-krater swap-run \
  || fail "NAMESPACED_RUN_SWAP_CLAIM_REJECTED"
run_swap_root_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
run_swap_namespace_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY"
run_swap_run_identity="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
run_swap_lease_path="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
run_swap_lease_identity="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
mv "$namespaced_run_swap_root/e2e/artifacts/s2-krater/swap-run" \
  "$namespaced_run_swap_root/e2e/artifacts/s2-krater/swap-run-original" \
  || fail "NAMESPACED_RUN_SWAP_FIXTURE_UNAVAILABLE"
mkdir "$namespaced_run_swap_root/e2e/artifacts/s2-krater/swap-run" \
  || fail "NAMESPACED_RUN_SWAP_FIXTURE_UNAVAILABLE"
if e2e_artifact_namespaced_run_matches_at_root \
  "$namespaced_run_swap_root" s2-krater swap-run \
  "$run_swap_root_identity" "$run_swap_namespace_identity" "$run_swap_run_identity" \
  "$run_swap_lease_path" "$run_swap_lease_identity"; then
  fail "REPLACED_NAMESPACED_RUN_ACCEPTED"
fi
if [[ -n "$(
    find "$namespaced_run_swap_root/e2e/artifacts/s2-krater/swap-run" \
      -mindepth 1 -print -quit
  )" \
  || -n "$(
    find "$namespaced_run_swap_root/e2e/artifacts/s2-krater/swap-run-original" \
      -mindepth 1 -print -quit
  )" ]]; then
  fail "REPLACED_NAMESPACED_RUN_MUTATED"
fi
e2e_close_artifact_writer_lease "$run_swap_lease_path" "$run_swap_lease_identity" \
  || fail "NAMESPACED_RUN_SWAP_CLOSE_FAILED"

foreign_lease_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-foreign-lease.XXXXXX")" \
  || fail "FOREIGN_LEASE_FIXTURE_UNAVAILABLE"
mkdir -p "$foreign_lease_root/e2e" || fail "FOREIGN_LEASE_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_namespaced_run_at_root "$foreign_lease_root" s2-krater foreign-run \
  || fail "FOREIGN_LEASE_CLAIM_REJECTED"
foreign_lease_path="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
foreign_lease_identity="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
if e2e_artifact_namespaced_run_matches_at_root \
  "$namespaced_root" s2-krater nested-run \
  "$namespaced_root_identity" "$namespaced_namespace_identity" "$namespaced_run_identity" \
  "$foreign_lease_path" "$foreign_lease_identity"; then
  fail "FOREIGN_EPOCH_LEASE_ACCEPTED"
fi
e2e_close_artifact_writer_lease "$foreign_lease_path" "$foreign_lease_identity" \
  || fail "FOREIGN_LEASE_CLOSE_FAILED"

inherited_child_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-inherited-child.XXXXXX")" \
  || fail "INHERITED_CHILD_FIXTURE_UNAVAILABLE"
mkdir -p "$inherited_child_root/e2e" || fail "INHERITED_CHILD_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_namespaced_run_at_root "$inherited_child_root" s2-krater parent-run \
  || fail "INHERITED_CHILD_PARENT_CLAIM_REJECTED"
inherited_root_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
inherited_namespace_identity="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY"
inherited_parent_run_identity="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
inherited_lease_path="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
inherited_lease_identity="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
inherited_epoch="${inherited_lease_path%/*}"
inherited_leases_before="$(find "$inherited_epoch" -mindepth 1 -type d -print | LC_ALL=C sort)"
e2e_claim_artifact_namespaced_run_with_lease_at_root \
  "$inherited_child_root" s2-krater child-run \
  "$inherited_root_identity" "$inherited_namespace_identity" \
  "$inherited_lease_path" "$inherited_lease_identity" \
  || fail "INHERITED_CHILD_CLAIM_REJECTED"
inherited_child_run_identity="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
inherited_leases_after="$(find "$inherited_epoch" -mindepth 1 -type d -print | LC_ALL=C sort)"
if [[ "$inherited_leases_before" != "$inherited_leases_after" \
  || -z "$inherited_child_run_identity" \
  || -n "$(find "$inherited_child_root/e2e/artifacts/s2-krater/child-run" -mindepth 1 -print -quit)" ]] \
  || ! e2e_artifact_namespaced_run_matches_at_root \
    "$inherited_child_root" s2-krater parent-run \
    "$inherited_root_identity" "$inherited_namespace_identity" \
    "$inherited_parent_run_identity" "$inherited_lease_path" "$inherited_lease_identity" \
  || ! e2e_artifact_namespaced_run_matches_at_root \
    "$inherited_child_root" s2-krater child-run \
    "$inherited_root_identity" "$inherited_namespace_identity" \
    "$inherited_child_run_identity" "$inherited_lease_path" "$inherited_lease_identity"; then
  fail "INHERITED_CHILD_CAPABILITY_INVALID"
fi
e2e_close_artifact_writer_lease "$inherited_lease_path" "$inherited_lease_identity" \
  || fail "INHERITED_CHILD_LEASE_CLOSE_FAILED"
if ! e2e_artifact_writer_leases_quiescent_at_root \
  "$inherited_child_root" "$inherited_root_identity"; then
  fail "INHERITED_CHILD_LEASE_REPORTED_OPEN_AFTER_PARENT_CLOSE"
fi

lease_fence_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-lease-fence.XXXXXX")" \
  || fail "LEASE_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$lease_fence_root/e2e" || fail "LEASE_FENCE_FIXTURE_UNAVAILABLE"
e2e_test_maintenance_check_count=0
e2e_test_fence_on_maintenance_check=2
if e2e_claim_artifact_run_at_root "$lease_fence_root" "lease-fenced-run" >/dev/null 2>&1; then
  fail "LEASE_FENCE_RACE_ACCEPTED"
fi
e2e_test_fence_on_maintenance_check=0
lease_fence_identity="$(e2e_artifact_directory_identity "$lease_fence_root/e2e/artifacts")" \
  || fail "LEASE_FENCE_FIXTURE_UNAVAILABLE"
if [[ "$e2e_test_maintenance_check_count" -ne 2 \
  || ! -f "$lease_fence_root/e2e/.artifact-maintenance" \
  || -L "$lease_fence_root/e2e/.artifact-maintenance" \
  || -e "$lease_fence_root/e2e/artifacts/lease-fenced-run" ]] \
  || ! e2e_test_acquired_lease_is_closed_for_root "$lease_fence_root" "$lease_fence_identity" \
  || ! e2e_artifact_writer_leases_quiescent_at_root \
    "$lease_fence_root" "$lease_fence_identity"; then
  fail "LEASE_FENCE_RACE_MUTATED_OR_LEFT_OPEN"
fi

run_claim_fence_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-run-claim-fence.XXXXXX")" \
  || fail "RUN_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$run_claim_fence_root/e2e" || fail "RUN_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
e2e_test_maintenance_check_count=0
e2e_test_fence_on_maintenance_check=3
if e2e_claim_artifact_run_at_root "$run_claim_fence_root" "run-claim-fenced" >/dev/null 2>&1; then
  fail "RUN_CLAIM_FENCE_RACE_ACCEPTED"
fi
e2e_test_fence_on_maintenance_check=0
run_claim_fence_identity="$(e2e_artifact_directory_identity "$run_claim_fence_root/e2e/artifacts")" \
  || fail "RUN_CLAIM_FENCE_FIXTURE_UNAVAILABLE"
if [[ "$e2e_test_maintenance_check_count" -ne 3 \
  || ! -f "$run_claim_fence_root/e2e/.artifact-maintenance" \
  || -L "$run_claim_fence_root/e2e/.artifact-maintenance" \
  || ! -d "$run_claim_fence_root/e2e/artifacts/run-claim-fenced" \
  || -n "$(find "$run_claim_fence_root/e2e/artifacts/run-claim-fenced" -mindepth 1 -print -quit)" ]] \
  || ! e2e_test_acquired_lease_is_closed_for_root \
    "$run_claim_fence_root" "$run_claim_fence_identity" \
  || ! e2e_artifact_writer_leases_quiescent_at_root \
    "$run_claim_fence_root" "$run_claim_fence_identity"; then
  fail "RUN_CLAIM_FENCE_RACE_MUTATED_OR_LEFT_OPEN"
fi

fenced_before_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-fenced-before.XXXXXX")" \
  || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$fenced_before_root/e2e" || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
: > "$fenced_before_root/e2e/.artifact-maintenance" \
  || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
if e2e_claim_artifact_run_at_root "$fenced_before_root" "fenced-before-run" >/dev/null 2>&1; then
  fail "MAINTENANCE_FENCE_BEFORE_CLAIM_ACCEPTED"
fi
if [[ -e "$fenced_before_root/e2e/artifacts" ]]; then
  fail "MAINTENANCE_FENCE_BEFORE_CLAIM_MUTATED"
fi

fenced_after_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-fenced-after.XXXXXX")" \
  || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
mkdir -p "$fenced_after_root/e2e" || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_run_at_root "$fenced_after_root" "fenced-after-run" \
  || fail "MAINTENANCE_FENCE_AFTER_CLAIM_SETUP_FAILED"
: > "$fenced_after_root/e2e/.artifact-maintenance" \
  || fail "MAINTENANCE_FENCE_FIXTURE_UNAVAILABLE"
if e2e_write_artifact_diagnostic_at_root "$fenced_after_root" "fenced-after-run" "$suite" "$started_ms" "fail" "FENCED_WRITE" "$reproduce" >/dev/null 2>&1; then
  fail "MAINTENANCE_FENCE_AFTER_CLAIM_DIAGNOSTIC_ACCEPTED"
fi
if e2e_append_artifact_jsonl_at_root "$fenced_after_root" "fenced-after-run" "steps.jsonl" '{"status":"pass"}' >/dev/null 2>&1; then
  fail "MAINTENANCE_FENCE_AFTER_CLAIM_STEP_ACCEPTED"
fi
if [[ -n "$(find "$fenced_after_root/e2e/artifacts/fenced-after-run" -mindepth 1 -print -quit)" ]]; then
  fail "MAINTENANCE_FENCE_AFTER_CLAIM_MUTATED"
fi

root_epoch_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-root-epoch.XXXXXX")" \
  || fail "ARTIFACT_ROOT_EPOCH_FIXTURE_UNAVAILABLE"
mkdir -p "$root_epoch_root/e2e" || fail "ARTIFACT_ROOT_EPOCH_FIXTURE_UNAVAILABLE"
e2e_claim_artifact_run_at_root "$root_epoch_root" "root-epoch-run" \
  || fail "ARTIFACT_ROOT_EPOCH_CLAIM_REJECTED"
mv "$root_epoch_root/e2e/artifacts" "$root_epoch_root/e2e/artifacts-original" \
  || fail "ARTIFACT_ROOT_EPOCH_FIXTURE_UNAVAILABLE"
mkdir "$root_epoch_root/e2e/artifacts" \
  || fail "ARTIFACT_ROOT_EPOCH_FIXTURE_UNAVAILABLE"
mv \
  "$root_epoch_root/e2e/artifacts-original/root-epoch-run" \
  "$root_epoch_root/e2e/artifacts/root-epoch-run" \
  || fail "ARTIFACT_ROOT_EPOCH_FIXTURE_UNAVAILABLE"
if e2e_write_artifact_diagnostic_at_root "$root_epoch_root" "root-epoch-run" "$suite" "$started_ms" "fail" "REPLACED_ROOT_WRITE" "$reproduce" >/dev/null 2>&1; then
  fail "REPLACED_ARTIFACT_ROOT_DIAGNOSTIC_ACCEPTED"
fi
if e2e_append_artifact_jsonl_at_root "$root_epoch_root" "root-epoch-run" "steps.jsonl" '{"status":"pass"}' >/dev/null 2>&1; then
  fail "REPLACED_ARTIFACT_ROOT_STEP_ACCEPTED"
fi
if [[ -n "$(find "$root_epoch_root/e2e/artifacts/root-epoch-run" -mindepth 1 -print -quit)" \
  || -n "$(find "$root_epoch_root/e2e/artifacts-original" -mindepth 1 -print -quit)" ]]; then
  fail "REPLACED_ARTIFACT_ROOT_MUTATED"
fi
if fresh_shell_output="$(
  bash -c '
    source "$1"
    e2e_write_artifact_diagnostic_at_root "$2" "claimed-run" "fresh-shell" "0" "fail" "FOREIGN_WRITE" "reproduce"
  ' _ "$repository_root/e2e/lib/run-diagnostics.sh" "$temporary_root" 2>&1
)"; then
  fail "FOREIGN_CLAIMED_ARTIFACT_WRITE_ACCEPTED"
fi
if [[ -n "$fresh_shell_output" || -e "$temporary_root/e2e/artifacts/claimed-run/diagnostics.jsonl" ]]; then
  fail "FOREIGN_CLAIMED_ARTIFACT_WRITE_MUTATED_OR_LEAKED"
fi
if bash -c '
  source "$1"
  e2e_append_artifact_jsonl_at_root "$2" "claimed-run" "steps.jsonl" '\''{"status":"pass"}'\''
' _ "$repository_root/e2e/lib/run-diagnostics.sh" "$temporary_root" >/dev/null 2>&1; then
  fail "FOREIGN_CLAIMED_STEP_WRITE_ACCEPTED"
fi
if [[ -e "$temporary_root/e2e/artifacts/claimed-run/steps.jsonl" ]]; then
  fail "FOREIGN_CLAIMED_STEP_WRITE_MUTATED"
fi

e2e_claim_artifact_run_at_root "$temporary_root" "replaced-run" \
  || fail "REPLACED_RUN_CLAIM_REJECTED"
mv \
  "$temporary_root/e2e/artifacts/replaced-run" \
  "$temporary_root/e2e/artifacts/replaced-run-original" \
  || fail "REPLACED_RUN_PLANT_UNAVAILABLE"
mkdir "$temporary_root/e2e/artifacts/replaced-run" \
  || fail "REPLACED_RUN_PLANT_UNAVAILABLE"
if e2e_write_artifact_diagnostic_at_root "$temporary_root" "replaced-run" "$suite" "$started_ms" "fail" "REPLACED_RUN_WRITE" "$reproduce" >/dev/null 2>&1; then
  fail "REPLACED_RUN_DIAGNOSTIC_ACCEPTED"
fi
if e2e_append_artifact_jsonl_at_root "$temporary_root" "replaced-run" "steps.jsonl" '{"status":"pass"}' >/dev/null 2>&1; then
  fail "REPLACED_RUN_STEP_ACCEPTED"
fi
if [[ -n "$(find "$temporary_root/e2e/artifacts/replaced-run" -mindepth 1 -print -quit)" \
  || -n "$(find "$temporary_root/e2e/artifacts/replaced-run-original" -mindepth 1 -print -quit)" ]]; then
  fail "REPLACED_RUN_MUTATED"
fi

if unclaimed_write_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "regular-run" "$suite" "$started_ms" "fail" "UNCLAIMED_ARTIFACT_TEST" "$reproduce" 2>&1)"; then
  fail "UNCLAIMED_ARTIFACT_WRITE_ACCEPTED"
fi
if [[ -n "$unclaimed_write_output" || -e "$temporary_root/e2e/artifacts/regular-run" ]]; then
  fail "UNCLAIMED_ARTIFACT_WRITE_MUTATED_OR_LEAKED"
fi
if e2e_append_artifact_jsonl_at_root "$temporary_root" "regular-run" "steps.jsonl" '{"status":"pass"}' >/dev/null 2>&1; then
  fail "UNCLAIMED_STEP_ARTIFACT_WRITE_ACCEPTED"
fi
if [[ -e "$temporary_root/e2e/artifacts/regular-run" ]]; then
  fail "UNCLAIMED_STEP_ARTIFACT_WRITE_MUTATED"
fi

e2e_claim_artifact_run_at_root "$temporary_root" "regular-run" \
  || fail "REGULAR_ARTIFACT_RUN_CLAIM_REJECTED"
if ! regular_artifact_path="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "regular-run" "$suite" "$started_ms" "fail" "REGULAR_ARTIFACT_TEST" "$reproduce")"; then
  fail "REGULAR_ARTIFACT_WRITE_REJECTED"
fi

if [[ "$regular_artifact_path" != "e2e/artifacts/regular-run/diagnostics.jsonl" ]]; then
  fail "REGULAR_ARTIFACT_RELATIVE_PATH_INVALID"
fi

regular_diagnostic="$(<"$temporary_root/e2e/artifacts/regular-run/diagnostics.jsonl")"
if [[ "$regular_diagnostic" != *'"code":"REGULAR_ARTIFACT_TEST"'* ]] || [[ "$regular_diagnostic" == *"$temporary_root"* ]]; then
  fail "REGULAR_ARTIFACT_DIAGNOSTIC_UNSAFE"
fi

safe_step='{"tool":"curl","status":"pass","code":"SAFE_STEP","device_digest":"0123456789ab"}'
if ! safe_step_path="$(e2e_append_artifact_jsonl_at_root "$temporary_root" "regular-run" "steps.jsonl" "$safe_step")"; then
  fail "REGULAR_STEP_ARTIFACT_WRITE_REJECTED"
fi
if [[ "$safe_step_path" != "e2e/artifacts/regular-run/steps.jsonl" \
  || "$(<"$temporary_root/e2e/artifacts/regular-run/steps.jsonl")" != "$safe_step" ]]; then
  fail "REGULAR_STEP_ARTIFACT_INVALID"
fi

for unsafe_step in \
  '{"flow_handle":"flow_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  '{"token":"asimp_ag_SECRET"}' \
  '{"email":"sponsor@example.invalid"}' \
  $'{"status":"pass"}\n{"status":"forged"}'; do
  if e2e_append_artifact_jsonl_at_root "$temporary_root" "regular-run" "steps.jsonl" "$unsafe_step" >/dev/null; then
    fail "UNSAFE_STEP_ARTIFACT_ACCEPTED"
  fi
done

ln -s "$temporary_root/outside" "$temporary_root/e2e/artifacts/escaped-run" || fail "SYMLINK_FIXTURE_UNAVAILABLE"
if symlink_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "escaped-run" "$suite" "$started_ms" "fail" "SYMLINK_ESCAPE_TEST" "$reproduce" 2>&1)"; then
  fail "SYMLINK_RUN_DIRECTORY_ACCEPTED"
fi

if [[ -n "$symlink_output" ]] || [[ -e "$temporary_root/outside/diagnostics.jsonl" ]]; then
  fail "SYMLINK_RUN_DIRECTORY_LEAKED"
fi

e2e_claim_artifact_run_at_root "$temporary_root" "leaf-run" \
  || fail "LEAF_FIXTURE_LAYOUT_FAILED"
ln -s "$temporary_root/outside/diagnostics.jsonl" "$temporary_root/e2e/artifacts/leaf-run/diagnostics.jsonl" || fail "LEAF_SYMLINK_FIXTURE_UNAVAILABLE"
if leaf_symlink_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "leaf-run" "$suite" "$started_ms" "fail" "LEAF_SYMLINK_ESCAPE_TEST" "$reproduce" 2>&1)"; then
  fail "SYMLINK_DIAGNOSTIC_FILE_ACCEPTED"
fi

if [[ -n "$leaf_symlink_output" ]] || [[ -e "$temporary_root/outside/diagnostics.jsonl" ]]; then
  fail "SYMLINK_DIAGNOSTIC_FILE_LEAKED"
fi

e2e_claim_artifact_run_at_root "$temporary_root" "step-leaf-run" \
  || fail "STEP_LEAF_FIXTURE_LAYOUT_FAILED"
ln -s "$temporary_root/outside/steps.jsonl" "$temporary_root/e2e/artifacts/step-leaf-run/steps.jsonl" \
  || fail "STEP_LEAF_SYMLINK_FIXTURE_UNAVAILABLE"
if step_symlink_output="$(e2e_append_artifact_jsonl_at_root "$temporary_root" "step-leaf-run" "steps.jsonl" "$safe_step" 2>&1)"; then
  fail "SYMLINK_STEP_FILE_ACCEPTED"
fi
if [[ -n "$step_symlink_output" ]] || [[ -e "$temporary_root/outside/steps.jsonl" ]]; then
  fail "SYMLINK_STEP_FILE_LEAKED"
fi

if ! emitted_stdout="$(e2e_emit_and_optionally_record_at_root "$temporary_root" "1" "escaped-run" "$suite" "$started_ms" "fail" "ORIGINAL_PRODUCT_FAILURE" "$reproduce" 2>"$temporary_root/artifact-write.stderr")"; then
  fail "ORIGINAL_PRODUCT_FAILURE_STATUS_NOT_RETAINED"
fi

emitted_stderr="$(<"$temporary_root/artifact-write.stderr")"
if [[ -n "$emitted_stdout" ]] || [[ "$emitted_stderr" != *'"code":"ORIGINAL_PRODUCT_FAILURE"'* ]] || [[ "$emitted_stderr" != *'"code":"ARTIFACT_DIAGNOSTIC_WRITE_FAILED"'* ]]; then
  fail "ARTIFACT_WRITE_FAILURE_DIAGNOSTIC_MISSING"
fi

if [[ "$emitted_stderr" == *"$temporary_root"* ]] || [[ "$emitted_stderr" == *"https://"* ]] || [[ "$emitted_stderr" == *"asimp_ag_"* ]]; then
  fail "ARTIFACT_WRITE_FAILURE_DIAGNOSTIC_UNSAFE"
fi

if ! e2e_close_artifact_writer_leases; then
  fail "ARTIFACT_WRITER_LEASE_CLOSE_FAILED"
fi
if ! e2e_artifact_writer_leases_quiescent_at_root "$temporary_root" "$claimed_root_identity"; then
  fail "CLOSED_ARTIFACT_WRITER_LEASE_NOT_QUIESCENT"
fi
if e2e_write_artifact_diagnostic_at_root "$temporary_root" "regular-run" "$suite" "$started_ms" "fail" "CLOSED_LEASE_WRITE" "$reproduce" >/dev/null 2>&1; then
  fail "CLOSED_ARTIFACT_WRITER_LEASE_PUBLISHED"
fi

exit_lease_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-exit-lease.XXXXXX")" \
  || fail "ARTIFACT_WRITER_EXIT_FIXTURE_UNAVAILABLE"
mkdir -p "$exit_lease_root/e2e" || fail "ARTIFACT_WRITER_EXIT_FIXTURE_UNAVAILABLE"
if ! bash -c '
  source "$1"
  trap '\''e2e_close_artifact_writer_leases_on_exit'\'' EXIT
  e2e_claim_artifact_run_at_root "$2" "exit-lease-run"
' _ "$repository_root/e2e/lib/run-diagnostics.sh" "$exit_lease_root"; then
  fail "ARTIFACT_WRITER_EXIT_DISPATCHER_FAILED"
fi
exit_lease_identity="$(e2e_artifact_directory_identity "$exit_lease_root/e2e/artifacts")" \
  || fail "ARTIFACT_WRITER_EXIT_FIXTURE_UNAVAILABLE"
if ! e2e_artifact_writer_leases_quiescent_at_root "$exit_lease_root" "$exit_lease_identity"; then
  fail "ARTIFACT_WRITER_EXIT_DISPATCHER_LEFT_OPEN_LEASE"
fi

crash_lease_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-crash-lease.XXXXXX")" \
  || fail "ARTIFACT_WRITER_CRASH_FIXTURE_UNAVAILABLE"
mkdir -p "$crash_lease_root/e2e" || fail "ARTIFACT_WRITER_CRASH_FIXTURE_UNAVAILABLE"
if bash -c '
  source "$1"
  e2e_claim_artifact_run_at_root "$2" "crash-lease-run"
  exit 99
' _ "$repository_root/e2e/lib/run-diagnostics.sh" "$crash_lease_root"; then
  fail "ARTIFACT_WRITER_CRASH_PLANT_DID_NOT_EXIT"
fi
crash_lease_identity="$(e2e_artifact_directory_identity "$crash_lease_root/e2e/artifacts")" \
  || fail "ARTIFACT_WRITER_CRASH_FIXTURE_UNAVAILABLE"
if e2e_artifact_writer_leases_quiescent_at_root "$crash_lease_root" "$crash_lease_identity"; then
  fail "CRASHED_ARTIFACT_WRITER_LEASE_RECLAIMED"
fi

signal_lease_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-signal-lease.XXXXXX")" \
  || fail "ARTIFACT_WRITER_SIGNAL_FIXTURE_UNAVAILABLE"
mkdir -p "$signal_lease_root/e2e" || fail "ARTIFACT_WRITER_SIGNAL_FIXTURE_UNAVAILABLE"
set +e
bash -c '
  source "$1"
  trap '\''e2e_close_artifact_writer_leases_on_exit'\'' EXIT
  trap '\''e2e_leave_artifact_writer_leases_open_on_signal 143'\'' TERM
  e2e_claim_artifact_run_at_root "$2" "signal-lease-run" || exit 98
  kill -TERM "$$"
  exit 97
' _ "$repository_root/e2e/lib/run-diagnostics.sh" "$signal_lease_root"
signal_lease_status=$?
set -e
if [[ "$signal_lease_status" -ne 143 ]]; then
  fail "ARTIFACT_WRITER_SIGNAL_EXIT_INVALID"
fi
signal_lease_identity="$(e2e_artifact_directory_identity "$signal_lease_root/e2e/artifacts")" \
  || fail "ARTIFACT_WRITER_SIGNAL_FIXTURE_UNAVAILABLE"
if e2e_artifact_writer_leases_quiescent_at_root "$signal_lease_root" "$signal_lease_identity"; then
  fail "SIGNALED_ARTIFACT_WRITER_LEASE_RECLAIMED"
fi

malformed_lease_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-malformed-lease.XXXXXX")" \
  || fail "MALFORMED_ARTIFACT_WRITER_LEASE_FIXTURE_UNAVAILABLE"
mkdir -p "$malformed_lease_root/e2e/artifacts" "$malformed_lease_root/e2e/.artifact-writer-leases" \
  || fail "MALFORMED_ARTIFACT_WRITER_LEASE_FIXTURE_UNAVAILABLE"
malformed_lease_identity="$(e2e_artifact_directory_identity "$malformed_lease_root/e2e/artifacts")" \
  || fail "MALFORMED_ARTIFACT_WRITER_LEASE_FIXTURE_UNAVAILABLE"
: > "$malformed_lease_root/e2e/.artifact-writer-leases/forged" \
  || fail "MALFORMED_ARTIFACT_WRITER_LEASE_FIXTURE_UNAVAILABLE"
if e2e_artifact_writer_leases_quiescent_at_root "$malformed_lease_root" "$malformed_lease_identity"; then
  fail "MALFORMED_ARTIFACT_WRITER_LEASE_ACCEPTED"
fi

if ! command -v curl >/dev/null 2>&1; then
  fail "CURL_UNAVAILABLE"
fi

# A planted curl binary proves the shared wrapper supplies the exact user
# agent, while the authenticated wrapper transports a canonical Fellow token
# only through stdin config—not through argv or inherited environment.
curl_fixture_bin="$temporary_root/curl-fixture-bin"
curl_args_file="$temporary_root/curl-fixture-args"
curl_env_file="$temporary_root/curl-fixture-env"
curl_stdin_file="$temporary_root/curl-fixture-stdin"
mkdir -p "$curl_fixture_bin" || fail "CURL_FIXTURE_LAYOUT_FAILED"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "<__ASIMP_CURL_INVOCATION__>" >>"$ASIMPOSIUM_E2E_CURL_ARGS_FILE"' \
  'printf "<%s>\n" "$@" >>"$ASIMPOSIUM_E2E_CURL_ARGS_FILE"' \
  'printf "%s\n" "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN-}" >"$ASIMPOSIUM_E2E_CURL_ENV_FILE"' \
  'config_line=""' \
  'write_out=""' \
  'read_stdin=0' \
  'previous_argument=""' \
  'for argument in "$@"; do' \
  '  if [[ "$previous_argument" == "--config" && "$argument" == "-" ]]; then read_stdin=1; fi' \
  '  if [[ "$previous_argument" == "--write-out" ]]; then write_out="$argument"; fi' \
  '  previous_argument="$argument"' \
  'done' \
  'if [[ "$read_stdin" -eq 1 ]]; then IFS= read -r config_line || true; fi' \
  'printf "%s\n" "$config_line" >"$ASIMPOSIUM_E2E_CURL_STDIN_FILE"' \
  'url="${!#}"' \
  'case "$url" in' \
  '  */redirect-production) printf "302\thttps://a.asimposium.org/" ;;' \
  '  */redirect-self) printf "302\thttps://agent-preview.example/redirect-self" ;;' \
  '  */redirect-same) printf "302\thttps://agent-preview.example/redirect-same/" ;;' \
  '  */redirect-same/) printf "204" ;;' \
  '  */redirect-not-modified) printf "304\thttps://agent-preview.example/redirect-not-modified/" ;;' \
  '  */redirect-not-modified/) printf "204" ;;' \
  '  */redirect-wrong) printf "302\thttps://agent-preview.example/landing" ;;' \
  '  */landing) printf "204" ;;' \
  '  *) if [[ "$write_out" == *"redirect_url"* ]]; then printf "204\t"; else printf "204"; fi ;;' \
  'esac' \
  >"$curl_fixture_bin/curl" || fail "CURL_FIXTURE_WRITE_FAILED"
chmod 700 "$curl_fixture_bin/curl" || fail "CURL_FIXTURE_MODE_FAILED"

export ASIMPOSIUM_E2E_CURL_ARGS_FILE="$curl_args_file"
export ASIMPOSIUM_E2E_CURL_ENV_FILE="$curl_env_file"
export ASIMPOSIUM_E2E_CURL_STDIN_FILE="$curl_stdin_file"
original_path="$PATH"
PATH="$curl_fixture_bin:$PATH"

curl_invocation_count() {
  grep -Fxc '<__ASIMP_CURL_INVOCATION__>' "$curl_args_file"
}

curl_invocation_prefix() {
  local target_invocation="$1"
  awk -v target="$target_invocation" '
    $0 == "<__ASIMP_CURL_INVOCATION__>" { current += 1; next }
    current == target && arguments < 8 { print; arguments += 1 }
  ' "$curl_args_file"
}

curl_invocation_argument() {
  local target_invocation="$1"
  local target_argument="$2"
  awk -v target_invocation="$target_invocation" -v target_argument="$target_argument" '
    $0 == "<__ASIMP_CURL_INVOCATION__>" { current += 1; next }
    current == target_invocation {
      arguments += 1
      if (arguments == target_argument) { print; exit }
    }
  ' "$curl_args_file"
}

assert_exact_curl_policy_prefix() {
  local target_invocation="$1"
  local failure_code="$2"
  local expected_prefix
  local actual_prefix

  expected_prefix="$(printf '%s\n' \
    '<--disable>' \
    '<--user-agent>' \
    "<$ASIMPOSIUM_E2E_HTTP_USER_AGENT>" \
    '<--max-redirs>' \
    '<0>' \
    '<--max-filesize>' \
    "<$ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES>" \
    '<--no-location>')"
  actual_prefix="$(curl_invocation_prefix "$target_invocation")"
  [[ "$actual_prefix" == "$expected_prefix" ]] || fail "$failure_code"
}

: >"$curl_args_file"
if ! planted_probe_status="$(e2e_probe_public_path "https://agent-preview.example" "/")"; then
  fail "PLANTED_PUBLIC_PROBE_REJECTED"
fi
if [[ -n "$planted_probe_status" ]]; then
  fail "PLANTED_PUBLIC_PROBE_PRINTED"
fi
if [[ "$(curl_invocation_count)" -ne 1 ]]; then
  fail "EXACT_CURL_TRANSPORT_POLICY_MISSING"
fi
assert_exact_curl_policy_prefix 1 "EXACT_CURL_TRANSPORT_POLICY_MISSING"
if [[ "$(declare -f e2e_probe_public_path)" == *"--location"* ]]; then
  fail "PUBLIC_PROBE_FOLLOWS_REDIRECT"
fi
if e2e_probe_public_path "https://agent-preview.example" "/redirect-production"; then
  fail "PUBLIC_PROBE_BORROWED_PRODUCTION_REDIRECT"
fi
if e2e_probe_public_path "https://agent-preview.example" "/redirect-self"; then
  fail "PUBLIC_PROBE_ACCEPTED_SELF_REDIRECT"
fi
: >"$curl_args_file"
if ! e2e_probe_public_path "https://agent-preview.example" "/redirect-same"; then
  fail "PUBLIC_PROBE_REFUSED_SAFE_SAME_ORIGIN_REDIRECT"
fi
if [[ "$(curl_invocation_count)" -ne 2 ]]; then
  fail "REDIRECT_HOP_TRANSPORT_POLICY_MISSING"
fi
assert_exact_curl_policy_prefix 1 "REDIRECT_HOP_TRANSPORT_POLICY_MISSING"
assert_exact_curl_policy_prefix 2 "REDIRECT_HOP_TRANSPORT_POLICY_MISSING"
if e2e_probe_public_path "https://agent-preview.example" "/redirect-wrong"; then
  fail "PUBLIC_PROBE_BORROWED_WRONG_PATH_REDIRECT"
fi
if e2e_probe_public_path "https://agent-preview.example" "/redirect-not-modified"; then
  fail "PUBLIC_PROBE_ACCEPTED_NON_REDIRECT_304"
fi

assert_transport_override_refused() {
  : >"$curl_args_file"
  if e2e_curl "$@" >/dev/null 2>&1; then
    fail "CURL_TRANSPORT_OVERRIDE_ACCEPTED"
  fi
  if [[ -s "$curl_args_file" ]]; then
    fail "CURL_TRANSPORT_OVERRIDE_REACHED_PROCESS"
  fi
}

assert_transport_override_refused --user-agent forged https://agent-preview.example/
assert_transport_override_refused --user-ag=forged https://agent-preview.example/
assert_transport_override_refused --max-redirs 3 https://agent-preview.example/
assert_transport_override_refused --max-re=3 https://agent-preview.example/
assert_transport_override_refused --max-filesize 0 https://agent-preview.example/
assert_transport_override_refused --location https://agent-preview.example/
assert_transport_override_refused -sL https://agent-preview.example/
assert_transport_override_refused -: https://agent-preview.example/
assert_transport_override_refused --header 'User-Agent: forged' https://agent-preview.example/
assert_transport_override_refused --heade 'User-Agent: forged' https://agent-preview.example/
assert_transport_override_refused --heade='User-Agent: forged' https://agent-preview.example/
assert_transport_override_refused --expand-header 'User-Agent: forged' https://agent-preview.example/
assert_transport_override_refused --expand-he 'User-Agent: forged' https://agent-preview.example/
assert_transport_override_refused -H'user-agent: forged' https://agent-preview.example/
assert_transport_override_refused --header 'User-Agent;' https://agent-preview.example/
assert_transport_override_refused --header '@/tmp/hostile-headers' https://agent-preview.example/
assert_transport_override_refused --header $'x-safe: one\nUser-Agent: forged' https://agent-preview.example/
assert_transport_override_refused --config "$temporary_root/hostile-curl-config" https://agent-preview.example/
assert_transport_override_refused --next https://agent-preview.example/

: >"$curl_args_file"
if [[ "$(e2e_curl --max-rate 1M --local-port 5000-5010 "https://agent-preview.example/")" != "204" ]]; then
  fail "LEGITIMATE_CURL_OPTIONS_FALSE_RED"
fi

valid_fellow_token="asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
unset ASIMPOSIUM_SMOKE_FELLOW_TOKEN
: >"$curl_args_file"
if [[ "$(e2e_curl_with_fellow_token "$valid_fellow_token" --silent "https://agent-preview.example/v1/sessions")" != "204" ]]; then
  fail "FELLOW_TOKEN_STDIN_TRANSPORT_FAILED"
fi
if [[ "$(curl_invocation_count)" -ne 1 ]]; then
  fail "AUTHENTICATED_CURL_TRANSPORT_POLICY_MISSING"
fi
assert_exact_curl_policy_prefix 1 "AUTHENTICATED_CURL_TRANSPORT_POLICY_MISSING"
if [[ "$(curl_invocation_argument 1 9)" != "<--config>" \
  || "$(curl_invocation_argument 1 10)" != "<->" ]]; then
  fail "AUTHENTICATED_CURL_TRANSPORT_POLICY_MISSING"
fi
if grep -Fq "$valid_fellow_token" "$curl_args_file" || grep -Fq "$valid_fellow_token" "$curl_env_file"; then
  fail "FELLOW_TOKEN_REACHED_CURL_PROCESS_METADATA"
fi
if [[ "$(<"$curl_stdin_file")" != "header = \"Authorization: Bearer $valid_fellow_token\"" ]]; then
  fail "FELLOW_TOKEN_AUTHORIZATION_HEADER_MISSING"
fi

: >"$curl_args_file"
if e2e_curl_with_fellow_token "$valid_fellow_token" --location "https://agent-preview.example/v1/sessions" >/dev/null 2>&1; then
  fail "AUTHENTICATED_CURL_TRANSPORT_OVERRIDE_ACCEPTED"
fi
if [[ -s "$curl_args_file" ]]; then
  fail "AUTHENTICATED_CURL_TRANSPORT_OVERRIDE_REACHED_PROCESS"
fi

: >"$curl_args_file"
if e2e_curl_with_fellow_token "asimp_ag_invalid" --silent "https://agent-preview.example" >/dev/null 2>&1; then
  fail "MALFORMED_FELLOW_TOKEN_ACCEPTED"
fi
if [[ -s "$curl_args_file" ]]; then
  fail "MALFORMED_FELLOW_TOKEN_REACHED_CURL"
fi

PATH="$original_path"
unset ASIMPOSIUM_E2E_CURL_ARGS_FILE ASIMPOSIUM_E2E_CURL_ENV_FILE ASIMPOSIUM_E2E_CURL_STDIN_FILE

if probe_output="$(e2e_probe_public_path "https://127.0.0.1:1" "/" 2>&1)"; then
  fail "UNREACHABLE_PROBE_ACCEPTED"
fi

if [[ -n "$probe_output" ]] || [[ "$probe_output" == *"127.0.0.1:1"* ]] || [[ "$probe_output" == *"https://"* ]]; then
  fail "RAW_PROBE_DIAGNOSTIC_LEAKED"
fi

e2e_emit_diagnostic "$suite" "$started_ms" "pass" "RUN_ID_AND_DIAGNOSTIC_CONTRACT_OK" "$reproduce"
