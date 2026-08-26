#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
suite="smoke-entrypoints-integration"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/smoke-entrypoints.test.sh"

emit() {
  local status="$1"
  local code="$2"
  e2e_emit_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce"
}

for self_test in \
  "$repository_root/scripts/smoke-agent.sh" \
  "$repository_root/scripts/smoke-gallery.sh" \
  "$repository_root/e2e/gauntlet/run.sh"; do
  if ! "$self_test" --self-test --write-artifacts >/dev/null; then
    emit "fail" "ENTRYPOINT_SELF_TEST_FAILED"
    exit 1
  fi
done

# The shared artifact writer now refuses unclaimed namespaces. Pin each common
# entry point's ordering so a future refactor cannot start validation, emit a
# recorded blocker, or launch product work before its exclusive mkdir claim.
for artifact_entrypoint in \
  "$repository_root/scripts/smoke-agent.sh" \
  "$repository_root/scripts/smoke-gallery.sh" \
  "$repository_root/e2e/gauntlet/run.sh"; do
  if ! awk '
    /e2e_close_artifact_writer_leases_on_exit/ && exit_trap == 0 { exit_trap = NR }
    /^run_id="\$\(e2e_resolve_run_id / { resolved = NR }
    resolved > 0 && /e2e_claim_artifact_run_at_root / && claim == 0 { claim = NR }
    resolved > 0 && /e2e_validate_staging_origin / && first_validation == 0 {
      first_validation = NR
    }
    resolved > 0 && /e2e_emit_and_optionally_record / && first_record == 0 {
      first_record = NR
    }
    END {
      exit(!(exit_trap > 0 && resolved > exit_trap && claim > resolved &&
        first_validation > claim && first_record > claim))
    }
  ' "$artifact_entrypoint"; then
    emit "fail" "ARTIFACT_CLAIM_ORDER_INVALID"
    exit 1
  fi
done

if ! awk '
  /e2e_validate_staging_origin / && validation == 0 { validation = NR }
  /command -v bunx/ && dependency == 0 { dependency = NR }
  /if ! e2e_claim_artifact_run_at_root / && claim == 0 { claim = NR }
  /e2e_select_artifact_claim_at_root / && selected == 0 { selected = NR }
  /ASIMPOSIUM_PLAYWRIGHT_ARTIFACT_ROOT_IDENTITY=/ { capability = NR }
  /bunx --no-install playwright test/ { launch = NR }
  END {
    exit(!(validation > 0 && dependency > validation && claim > dependency &&
      selected > claim && capability > selected && launch >= capability))
  }
' "$repository_root/e2e/run-playwright.sh"; then
  emit "fail" "PLAYWRIGHT_ARTIFACT_NAMESPACE_NOT_CLAIMED"
  exit 1
fi
if ! awk '
  /const claimedRepositoryRoot = process\.env\.ASIMPOSIUM_PLAYWRIGHT_REPOSITORY_ROOT/ {
    source = NR
  }
  /directDirectoryIdentity\(artifactRoot\) !== artifactRootIdentity/ { root_identity = NR }
  /directDirectoryIdentity\(runDirectory\) !== runIdentity/ { run_identity = NR }
  /directDirectoryIdentity\(leaseDirectory\) !== leaseIdentity/ { lease_identity = NR }
  /anyNodeExists\(join\(leaseDirectory, "closed"\)\)/ { open_lease = NR }
  /const artifactDirectory = join\(runDirectory, "playwright"\)/ { exact_output = NR }
  /anyNodeExists\(artifactDirectory\)/ { fresh_child = NR }
  /outputDir: artifactDirectory/ { output = NR }
  END {
    exit(!(source > 0 && root_identity > source && run_identity >= root_identity &&
      lease_identity > run_identity && open_lease >= lease_identity &&
      exact_output > open_lease && fresh_child > exact_output && output > fresh_child))
  }
' "$repository_root/e2e/playwright.config.ts"; then
  emit "fail" "PLAYWRIGHT_ARTIFACT_DIRECTORY_VALIDATION_MISSING"
  exit 1
fi

# Every production shell writer that adopts the shared artifact claim must arm
# its lease closer immediately after sourcing the helper and before its first
# claim. The helper deliberately does not seize EXIT itself because complex
# orchestrators must retain ownership of child reaping and terminal evidence.
for leased_entrypoint in \
  "$repository_root/scripts/smoke-agent.sh" \
  "$repository_root/scripts/smoke-gallery.sh" \
  "$repository_root/e2e/run-playwright.sh" \
  "$repository_root/e2e/gauntlet/run.sh" \
  "$repository_root/scripts/e2e-device-enrollment.sh" \
  "$repository_root/scripts/e2e-ci-pipeline.sh"; do
  if ! awk '
    /source .*e2e\/lib\/run-diagnostics\.sh/ && helper == 0 { helper = NR }
    /trap .*_artifact_writer_leases_on_exit.* EXIT/ && exit_trap == 0 {
      exit_trap = NR
    }
    /^trap .* INT$/ && int_trap == 0 { int_trap = NR }
    /^trap .* TERM$/ && term_trap == 0 { term_trap = NR }
    /^trap .* HUP$/ && hup_trap == 0 { hup_trap = NR }
    /e2e_claim_artifact_run_at_root/ && claim == 0 { claim = NR }
    END {
      exit(!(helper > 0 && exit_trap > helper &&
        int_trap > exit_trap && term_trap > exit_trap && hup_trap > exit_trap &&
        claim > int_trap && claim > term_trap && claim > hup_trap))
    }
  ' "$leased_entrypoint"; then
    emit "fail" "ARTIFACT_WRITER_LEASE_TRAP_ORDER_INVALID"
    exit 1
  fi
done

collision_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-entrypoint-claim.XXXXXX")" || {
  emit "fail" "ARTIFACT_CLAIM_FIXTURE_UNAVAILABLE"
  exit 1
}
mkdir -p \
  "$collision_root/e2e/artifacts/collision-run" \
  "$collision_root/e2e/lib" \
  "$collision_root/e2e/gauntlet" \
  "$collision_root/scripts" || {
  emit "fail" "ARTIFACT_CLAIM_FIXTURE_UNAVAILABLE"
  exit 1
}
cp "$repository_root/e2e/lib/run-diagnostics.sh" "$collision_root/e2e/lib/run-diagnostics.sh"
cp "$repository_root/e2e/run-playwright.sh" "$collision_root/e2e/run-playwright.sh"
cp "$repository_root/e2e/gauntlet/run.sh" "$collision_root/e2e/gauntlet/run.sh"
cp "$repository_root/scripts/smoke-agent.sh" "$collision_root/scripts/smoke-agent.sh"
cp "$repository_root/scripts/smoke-gallery.sh" "$collision_root/scripts/smoke-gallery.sh"

collision_bin="$collision_root/trapped-product-bin"
collision_marker="$collision_root/product-command-invoked"
mkdir "$collision_bin" || {
  emit "fail" "ARTIFACT_CLAIM_FIXTURE_UNAVAILABLE"
  exit 1
}
for trapped_binary in curl bunx bun python3; do
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$0" >> "$ARTIFACT_CLAIM_PRODUCT_MARKER"' \
    'exit 66' > "$collision_bin/$trapped_binary" || {
    emit "fail" "ARTIFACT_CLAIM_FIXTURE_UNAVAILABLE"
    exit 1
  }
  chmod 700 "$collision_bin/$trapped_binary" || {
    emit "fail" "ARTIFACT_CLAIM_FIXTURE_UNAVAILABLE"
    exit 1
  }
done

for collision_entrypoint in \
  "$collision_root/scripts/smoke-agent.sh" \
  "$collision_root/scripts/smoke-gallery.sh" \
  "$collision_root/e2e/run-playwright.sh" \
  "$collision_root/e2e/gauntlet/run.sh"; do
  set +e
  collision_output="$(
    env \
      -u ASIMPOSIUM_E2E_RUN_ID \
      -u ASIMPOSIUM_SMOKE_FELLOW_TOKEN \
      -u GAUNTLET_JOIN_URLS_FILE \
      PATH="$collision_bin:$PATH" \
      ARTIFACT_CLAIM_PRODUCT_MARKER="$collision_marker" \
      ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
      ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora-preview.example" \
      /bin/bash "$collision_entrypoint" --write-artifacts --run-id collision-run 2>&1
  )"
  collision_status=$?
  set -e
  if [[ "$collision_status" -ne 78 \
    || "$collision_output" != *'"status":"blocked"'* \
    || "$collision_output" != *'"code":"ARTIFACT_RUN_ALREADY_EXISTS"'* ]]; then
    emit "fail" "REUSED_ARTIFACT_RUN_NOT_BLOCKED"
    exit 1
  fi
done
if [[ -e "$collision_marker" \
  || -n "$(find "$collision_root/e2e/artifacts/collision-run" -mindepth 1 -print -quit)" ]]; then
  emit "fail" "REUSED_ARTIFACT_RUN_STARTED_PRODUCT_WORK_OR_MUTATED"
  exit 1
fi

synthetic_fellow_token="asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
if ! ASIMPOSIUM_SMOKE_FELLOW_TOKEN="$synthetic_fellow_token" \
  "$repository_root/scripts/smoke-agent.sh" --self-test >/dev/null; then
  emit "fail" "SMOKE_AGENT_DID_NOT_SCRUB_EXPORTED_CREDENTIAL"
  exit 1
fi

set +e
traced_self_test_output="$(
  ASIMPOSIUM_SMOKE_FELLOW_TOKEN="$synthetic_fellow_token" \
    bash -x "$repository_root/scripts/smoke-agent.sh" --self-test 2>&1
)"
traced_self_test_status=$?
set -e
if [[ "$traced_self_test_status" -ne 0 || "$traced_self_test_output" == *"$synthetic_fellow_token"* ]]; then
  emit "fail" "SMOKE_AGENT_XTRACE_LEAKED_CREDENTIAL"
  exit 1
fi

for smoke_source in \
  "$repository_root/scripts/smoke-agent.sh" \
  "$repository_root/scripts/smoke-gallery.sh"; do
  if awk '
    BEGIN { found = 0 }
    !/^[[:space:]]*#/ && /(^|[^[:alnum:]_])curl[[:space:]]/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$smoke_source"; then
    emit "fail" "SMOKE_ENTRYPOINT_BYPASSES_EXACT_USER_AGENT_WRAPPER"
    exit 1
  fi
done
if awk '
  BEGIN { found = 0 }
  !/^[[:space:]]*#/ && tolower($0) ~ /authorization:[[:space:]]*bearer/ { found = 1 }
  END { exit(found ? 0 : 1) }
' "$repository_root/scripts/smoke-agent.sh"; then
  emit "fail" "SMOKE_AGENT_PUTS_CREDENTIAL_IN_CURL_ARGV"
  exit 1
fi

assert_cli_parsing_table() {
  local entrypoint="$1"
  local output
  local status

  # 1. Unknown argument
  set +e
  output="$("$entrypoint" --invalid-flag 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 64 || "$output" != *'"code":"UNKNOWN_ARGUMENT"'* ]]; then
    emit "fail" "CLI_UNKNOWN_ARGUMENT_MISCLASSIFIED"
    exit 1
  fi

  # 2. Missing --run-id values
  set +e
  output="$("$entrypoint" --run-id 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 64 || "$output" != *'"code":"RUN_ID_MISSING"'* ]]; then
    emit "fail" "CLI_RUN_ID_MISSING_MISCLASSIFIED"
    exit 1
  fi

  set +e
  output="$("$entrypoint" --run-id "" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 64 || "$output" != *'"code":"RUN_ID_MISSING"'* ]]; then
    emit "fail" "CLI_RUN_ID_EMPTY_MISCLASSIFIED"
    exit 1
  fi

  set +e
  output="$("$entrypoint" --run-id --self-test 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 64 || "$output" != *'"code":"RUN_ID_MISSING"'* ]]; then
    emit "fail" "CLI_RUN_ID_FLAG_NEXT_MISCLASSIFIED"
    exit 1
  fi

  # 3. Invalid run-id values
  for invalid_run_id in \
    "../escape" \
    "with spaces" \
    ".leading-dot" \
    "_leading-underscore" \
    "-leading-dash" \
    "has\$dollar" \
    "$(printf 'a%.0s' {1..81})"; do
    set +e
    output="$("$entrypoint" --self-test --run-id "$invalid_run_id" 2>&1)"
    status=$?
    set -e
    if [[ "$status" -ne 64 || "$output" != *'"code":"RUN_ID_INVALID"'* ]]; then
      emit "fail" "CLI_RUN_ID_INVALID_MISCLASSIFIED"
      exit 1
    fi
  done

  # 4. Valid run-id boundaries with --self-test
  for valid_run_id in \
    "valid-run-1" \
    "A.B-C_D" \
    "$(printf 'a%.0s' {1..80})"; do
    set +e
    output="$("$entrypoint" --self-test --run-id "$valid_run_id" 2>&1)"
    status=$?
    set -e
    if [[ "$status" -ne 0 || "$output" != *'"code":"HARNESS_SELF_TEST_OK"'* ]]; then
      emit "fail" "CLI_RUN_ID_VALID_SELF_TEST_FAILED"
      exit 1
    fi
  done
}

assert_cli_parsing_table "$repository_root/scripts/smoke-agent.sh"
assert_cli_parsing_table "$repository_root/scripts/smoke-gallery.sh"
assert_cli_parsing_table "$repository_root/e2e/gauntlet/run.sh"

assert_production_refused() {
  local entrypoint="$1"
  local expected_code="$2"
  local output
  local status

  set +e
  output="$(
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://a.asimposium.org:443" \
      ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://ASIMPOSIUM.ORG." \
      "$entrypoint" 2>&1
  )"
  status=$?
  set -e
  if [[ "$status" -ne 78 || "$output" != *"\"code\":\"$expected_code\""* ]]; then
    emit "fail" "PRODUCTION_ORIGIN_NOT_BLOCKED"
    exit 1
  fi
  if [[ "$output" == *"https://"* || "$output" == *"asimposium.org"* ]]; then
    emit "fail" "PRODUCTION_ORIGIN_LEAKED"
    exit 1
  fi
}

assert_production_refused "$repository_root/scripts/smoke-agent.sh" "STAGING_AGENT_BASE_URL_INVALID"
assert_production_refused "$repository_root/scripts/smoke-gallery.sh" "STAGING_AGORA_BASE_URL_INVALID"
assert_production_refused "$repository_root/e2e/run-playwright.sh" "STAGING_SURFACE_BASE_URL_INVALID"
assert_production_refused "$repository_root/e2e/gauntlet/run.sh" "STAGING_AGENT_BASE_URL_INVALID"

set +e
direct_playwright_output="$(
  cd "$repository_root/e2e" \
    && ASIMPOSIUM_PLAYWRIGHT_ENTRY=1 \
      ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://a.asimposium.org" \
      ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://asimposium.org" \
      bunx --no-install playwright test --config playwright.config.ts --list 2>&1
)"
direct_playwright_status=$?
set -e
if [[ "$direct_playwright_status" -eq 0 \
  || "$direct_playwright_output" != *"bind this exact repository root"* ]]; then
  emit "fail" "DIRECT_PLAYWRIGHT_WITHOUT_CLAIM_ACCEPTED"
  exit 1
fi
if [[ "$direct_playwright_output" == *"https://"* ]]; then
  emit "fail" "DIRECT_PLAYWRIGHT_PRODUCTION_ORIGIN_LEAKED"
  exit 1
fi

forged_playwright_run_id="direct-unclaimed-$$"
forged_playwright_run="$repository_root/e2e/artifacts/$forged_playwright_run_id"
if [[ -e "$forged_playwright_run" || -L "$forged_playwright_run" ]]; then
  emit "fail" "DIRECT_PLAYWRIGHT_CLAIM_FIXTURE_COLLISION"
  exit 1
fi
playwright_artifact_root_identity="$(e2e_artifact_directory_identity "$repository_root/e2e/artifacts")" || {
  emit "fail" "DIRECT_PLAYWRIGHT_CLAIM_FIXTURE_UNAVAILABLE"
  exit 1
}
playwright_lease_epoch="$(e2e_artifact_writer_lease_epoch_name "$playwright_artifact_root_identity")" || {
  emit "fail" "DIRECT_PLAYWRIGHT_CLAIM_FIXTURE_UNAVAILABLE"
  exit 1
}
set +e
forged_playwright_output="$(
  cd "$repository_root/e2e" \
    && ASIMPOSIUM_PLAYWRIGHT_ENTRY=1 \
      ASIMPOSIUM_PLAYWRIGHT_REPOSITORY_ROOT="$repository_root" \
      ASIMPOSIUM_PLAYWRIGHT_RUN_ID="$forged_playwright_run_id" \
      ASIMPOSIUM_PLAYWRIGHT_ARTIFACT_ROOT_IDENTITY="$playwright_artifact_root_identity" \
      ASIMPOSIUM_PLAYWRIGHT_RUN_IDENTITY="0:0" \
      ASIMPOSIUM_PLAYWRIGHT_LEASE_DIRECTORY="$repository_root/e2e/.artifact-writer-leases/$playwright_lease_epoch/lease-1-1-1-1" \
      ASIMPOSIUM_PLAYWRIGHT_LEASE_IDENTITY="0:0" \
      bunx --no-install playwright test --config playwright.config.ts --list 2>&1
)"
forged_playwright_status=$?
set -e
if [[ "$forged_playwright_status" -eq 0 \
  || "$forged_playwright_output" != *"artifact root or run claim is not current"* \
  || -e "$forged_playwright_run" \
  || -L "$forged_playwright_run" ]]; then
  emit "fail" "DIRECT_PLAYWRIGHT_FORGED_CLAIM_ACCEPTED"
  exit 1
fi

set +e
missing_gauntlet_output="$(
  env -u ASIMPOSIUM_STAGING_AGENT_BASE_URL \
    "$repository_root/e2e/gauntlet/run.sh" 2>&1
)"
missing_gauntlet_exit=$?
missing_playwright_output="$(
  env -u ASIMPOSIUM_STAGING_AGENT_BASE_URL -u ASIMPOSIUM_STAGING_AGORA_BASE_URL \
    "$repository_root/e2e/run-playwright.sh" 2>&1
)"
missing_playwright_exit=$?
set -e

if [[ "$missing_gauntlet_exit" -ne 78 \
  || "$missing_gauntlet_output" != *'"status":"blocked"'* \
  || "$missing_gauntlet_output" != *'"code":"STAGING_AGENT_BASE_URL_MISSING"'* \
  || "$missing_gauntlet_output" != *'"reproduce":"bash e2e/gauntlet/run.sh"'* ]]; then
  emit "fail" "GAUNTLET_MISSING_STAGING_NOT_BLOCKED"
  exit 1
fi

if [[ "$missing_playwright_exit" -ne 78 \
  || "$missing_playwright_output" != *'"status":"blocked"'* \
  || "$missing_playwright_output" != *'"code":"STAGING_SURFACE_BASE_URL_MISSING"'* \
  || "$missing_playwright_output" != *'"reproduce":"bash e2e/run-playwright.sh"'* ]]; then
  emit "fail" "PLAYWRIGHT_MISSING_STAGING_NOT_BLOCKED"
  exit 1
fi

if invalid_run_id_output="$(ASIMPOSIUM_E2E_RUN_ID="../traversal" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "TRAVERSAL_RUN_ID_ACCEPTED"
  exit 1
fi

if [[ "$invalid_run_id_output" != *'"code":"RUN_ID_INVALID"'* ]]; then
  emit "fail" "TRAVERSAL_REJECTION_DIAGNOSTIC_MISSING"
  exit 1
fi

if credential_origin_output="$(ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://test-user:test-pass@127.0.0.1:1" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "CREDENTIAL_ORIGIN_ACCEPTED"
  exit 1
fi

if [[ "$credential_origin_output" != *'"code":"STAGING_AGENT_BASE_URL_INVALID"'* ]]; then
  emit "fail" "CREDENTIAL_ORIGIN_REJECTION_DIAGNOSTIC_MISSING"
  exit 1
fi

if [[ "$credential_origin_output" == *"test-user"* ]] || [[ "$credential_origin_output" == *"test-pass"* ]] || [[ "$credential_origin_output" == *"127.0.0.1:1"* ]]; then
  emit "fail" "CREDENTIAL_ORIGIN_LEAKED"
  exit 1
fi

set +e
invalid_fellow_output="$(
  ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://127.0.0.1:1" \
    ASIMPOSIUM_SMOKE_FELLOW_TOKEN="asimp_ag_invalid" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
invalid_fellow_status=$?
set -e
if [[ "$invalid_fellow_status" -ne 90 || "$invalid_fellow_output" != *'"code":"AGENT_LOOP_CREDENTIAL_INVALID"'* ]]; then
  emit "fail" "MALFORMED_FELLOW_CREDENTIAL_NOT_REFUSED"
  exit 1
fi
if [[ "$invalid_fellow_output" == *"asimp_ag_"* || "$invalid_fellow_output" == *"127.0.0.1:1"* ]]; then
  emit "fail" "MALFORMED_FELLOW_CREDENTIAL_REJECTION_LEAKED"
  exit 1
fi

# A transport failure after the two public preflights must still leave through
# the harness's typed diagnostic path. Without the explicit assignment guard,
# `set -e` exits here with curl's raw status before the suite can explain which
# product assertion was not observed.
curl_failure_fixture="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-smoke-curl.XXXXXX")" || {
  emit "fail" "SMOKE_CURL_FAILURE_FIXTURE_UNAVAILABLE"
  exit 1
}
# The single-quoted lines below are literal source for the generated fake curl.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'method=""' \
  'content_type=""' \
  'request_body=""' \
  'write_out=""' \
  'previous_argument=""' \
  'for argument in "$@"; do' \
  '  if [[ "$previous_argument" == "--request" ]]; then method="$argument"; fi' \
  '  if [[ "$previous_argument" == "--header" ]]; then content_type="$argument"; fi' \
  '  if [[ "$previous_argument" == "--data" ]]; then request_body="$argument"; fi' \
  '  if [[ "$previous_argument" == "--write-out" ]]; then write_out="$argument"; fi' \
  '  previous_argument="$argument"' \
  'done' \
  'url="${!#}"' \
  'case "$url" in' \
  '  */problems.json)' \
  '    problem_status="200"' \
  '    problem_content_type="Application/JSON; Charset=UTF-8"' \
  '    case "${SMOKE_FAKE_PROBLEMS_MODE:-fail}" in' \
  '      malformed) printf "not-json" ;;' \
  '      leak) printf "%s" '\''{"problems":[{"workshop_id":"synthetic-canary"}],"omitted":[]}'\'' ;;' \
  '      contract-empty) printf "%s" '\''{}'\'' ;;' \
  '      contract-array) printf "%s" '\''[]'\'' ;;' \
  '      contract-extra) printf "%s" '\''{"problems":[],"omitted":[],"extra":true}'\'' ;;' \
  '      contract-id) printf "%s" '\''{"problems":[{"id":"P--BAD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      contract-seq-bool) printf "%s" '\''{"problems":[{"id":"P-GOOD","public_seq":true,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      contract-seq-unsafe) printf "%s" '\''{"problems":[{"id":"P-GOOD","public_seq":9007199254740992,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      contract-created) printf "%s" '\''{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-02-30T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      contract-updated) printf "%s" '\''{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-02-30T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      contract-entry-extra) printf "%s" '\''{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","extra":true}],"omitted":[]}'\'' ;;' \
  '      contract-omitted-empty) printf "%s" '\''{"problems":[],"omitted":[""]}'\'' ;;' \
  '      contract-omitted-long) printf "%s" '\''{"problems":[],"omitted":["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]}'\'' ;;' \
  '      benign) printf "%s" '\''{"problems":[{"id":"P-private-workshop","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      http) printf "%s" '\''{"problems":[],"omitted":[]}'\''; problem_status="503" ;;' \
  '      wrong-media) printf "%s" '\''{"problems":[],"omitted":[]}'\''; problem_content_type="text/html; charset=utf-8" ;;' \
  '      cursor-http | cursor-transport) printf "%s" '\''{"problems":[],"omitted":[]}'\'' ;;' \
  '      reachable) printf "%s" '\''{"problems":[{"id":"P-4DSP","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      parser) printf "%s" '\''{"problems":[{"id":"P-4DSP","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      shape) printf "%s" '\''{"problems":[{"id":"P-4DSP","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      unproven) printf "%s" '\''{"problems":[],"omitted":[]}'\'' ;;' \
  '      auth-wrong-code | auth-forbidden | auth-malformed | auth-wrong-title | auth-wrong-detail | auth-wrong-fix | auth-wrong-media) printf "%s" '\''{"problems":[],"omitted":[]}'\'' ;;' \
  '      workshop) printf "%s" '\''{"problems":[{"id":"P-4DSP","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}'\'' ;;' \
  '      *) exit 7 ;;' \
  '    esac' \
  '    if [[ "$write_out" == *"content_type"* ]]; then printf "\n%s\t%s" "$problem_status" "$problem_content_type"; elif [[ "$write_out" == *"http_code"* ]]; then printf "\n%s" "$problem_status"; fi' \
  '    ;;' \
  '  */v1/sponsors/workshop*)' \
  '    workshop_body='\''{"type":"https://asimposium.org/errors/UNAUTHORIZED","title":"Authorization was not accepted","status":401,"code":"UNAUTHORIZED","detail":"The request did not include an authorization accepted by this route.","fix_hint":"Obtain a fresh sponsor authorization and retry the request."}'\''' \
  '    workshop_status="401"' \
  '    workshop_content_type="Application/Problem+JSON; Charset=UTF-8"' \
  '    case "${SMOKE_FAKE_PROBLEMS_MODE:-fail}" in' \
  '      reachable) workshop_body='\''{}'\''; workshop_status="200" ;;' \
  '      parser) workshop_body='\''{}'\''; workshop_status="422" ;;' \
  '      shape) if [[ "$method" != "POST" || "$content_type" != "content-type: application/json" || "$request_body" != '\''{}'\'' ]]; then workshop_body='\''{}'\''; workshop_status="422"; fi ;;' \
  '      unproven) workshop_body='\''{}'\''; workshop_status="503" ;;' \
  '      auth-wrong-code) workshop_body='\''{"type":"https://asimposium.org/errors/WRONG_PRINCIPAL","title":"Wrong principal","status":401,"code":"WRONG_PRINCIPAL","detail":"Wrong credential class.","fix_hint":"Use the required credential."}'\'' ;;' \
  '      auth-forbidden) workshop_body='\''{"type":"https://asimposium.org/errors/WRONG_PRINCIPAL","title":"Wrong principal","status":403,"code":"WRONG_PRINCIPAL","detail":"Wrong credential class.","fix_hint":"Use the required credential."}'\''; workshop_status="403" ;;' \
  '      auth-malformed) workshop_body='\''{}'\'' ;;' \
  '      auth-wrong-title) workshop_body="${workshop_body/Authorization was not accepted/Generic denial}" ;;' \
  '      auth-wrong-detail) workshop_body="${workshop_body/The request did not include an authorization accepted by this route./Generic detail.}" ;;' \
  '      auth-wrong-fix) workshop_body="${workshop_body/Obtain a fresh sponsor authorization and retry the request./Retry later.}" ;;' \
  '      auth-wrong-media) workshop_content_type="application/json; charset=utf-8" ;;' \
  '      cursor-*) ;;' \
  '      *) exit 7 ;;' \
  '    esac' \
  '    printf "%s" "$workshop_body"' \
  '    if [[ "$write_out" == *"content_type"* ]]; then printf "\n%s\t%s" "$workshop_status" "$workshop_content_type"; elif [[ "$write_out" == *"http_code"* ]]; then printf "\n%s" "$workshop_status"; fi' \
  '    ;;' \
  '  */cursor)' \
  '    case "${SMOKE_FAKE_PROBLEMS_MODE:-fail}" in' \
  '      cursor-http) printf "0\n503" ;;' \
  '      cursor-transport) exit 7 ;;' \
  '      *) printf "not-an-integer\n200" ;;' \
  '    esac' \
  '    ;;' \
  '  *) printf "200\t" ;;' \
  'esac' \
  >"$curl_failure_fixture/curl" || {
  emit "fail" "SMOKE_CURL_FAILURE_FIXTURE_UNAVAILABLE"
  exit 1
}
chmod 700 "$curl_failure_fixture/curl" || {
  emit "fail" "SMOKE_CURL_FAILURE_FIXTURE_UNAVAILABLE"
  exit 1
}
set +e
guarded_curl_failure_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
guarded_curl_failure_status=$?
set -e
if [[ "$guarded_curl_failure_status" -ne 87 \
  || "$guarded_curl_failure_output" != *'"code":"AGENT_PROBLEM_INDEX_UNAVAILABLE"'* ]]; then
  emit "fail" "SMOKE_AGENT_CURL_FAILURE_BYPASSED_DIAGNOSTIC"
  exit 1
fi
if [[ "$guarded_curl_failure_output" == *"agent-preview.example"* \
  || "$guarded_curl_failure_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_CURL_FAILURE_LEAKED_ORIGIN"
  exit 1
fi

set +e
index_http_failure_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="http" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
index_http_failure_status=$?
set -e
if [[ "$index_http_failure_status" -ne 87 \
  || "$index_http_failure_output" != *'"code":"AGENT_PROBLEM_INDEX_HTTP_FAILURE"'* ]]; then
  emit "fail" "SMOKE_AGENT_INDEX_HTTP_FAILURE_MISCLASSIFIED"
  exit 1
fi
if [[ "$index_http_failure_output" == *"agent-preview.example"* \
  || "$index_http_failure_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_INDEX_HTTP_FAILURE_LEAKED_ORIGIN"
  exit 1
fi

set +e
index_media_failure_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="wrong-media" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
index_media_failure_status=$?
set -e
if [[ "$index_media_failure_status" -ne 87 \
  || "$index_media_failure_output" != *'"code":"AGENT_PROBLEM_INDEX_MEDIA_TYPE_INVALID"'* ]]; then
  emit "fail" "SMOKE_AGENT_INDEX_MEDIA_TYPE_FALSE_GREEN"
  exit 1
fi
if [[ "$index_media_failure_output" == *"agent-preview.example"* \
  || "$index_media_failure_output" == *"https://"* \
  || "$index_media_failure_output" == *"text/html"* ]]; then
  emit "fail" "SMOKE_AGENT_INDEX_MEDIA_TYPE_DIAGNOSTIC_EXPOSED_INPUT"
  exit 1
fi

set +e
malformed_index_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="malformed" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
malformed_index_status=$?
set -e
if [[ "$malformed_index_status" -ne 87 \
  || "$malformed_index_output" != *'"code":"AGENT_PROBLEM_INDEX_MALFORMED"'* ]]; then
  emit "fail" "SMOKE_AGENT_MALFORMED_INDEX_MISCLASSIFIED"
  exit 1
fi
if [[ "$malformed_index_output" == *"agent-preview.example"* \
  || "$malformed_index_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_MALFORMED_INDEX_LEAKED_ORIGIN"
  exit 1
fi

for invalid_index_mode in \
  contract-empty \
  contract-array \
  contract-extra \
  contract-id \
  contract-seq-bool \
  contract-seq-unsafe \
  contract-created \
  contract-updated \
  contract-entry-extra \
  contract-omitted-empty \
  contract-omitted-long; do
  set +e
  invalid_index_output="$(
    PATH="$curl_failure_fixture:$PATH" \
      SMOKE_FAKE_PROBLEMS_MODE="$invalid_index_mode" \
      ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
      "$repository_root/scripts/smoke-agent.sh" 2>&1
  )"
  invalid_index_status=$?
  set -e
  if [[ "$invalid_index_status" -ne 87 \
    || "$invalid_index_output" != *'"code":"AGENT_PROBLEM_INDEX_CONTRACT_VIOLATION"'* ]]; then
    emit "fail" "SMOKE_AGENT_INVALID_INDEX_CONTRACT_FALSE_GREEN"
    exit 1
  fi
  if [[ "$invalid_index_output" == *"agent-preview.example"* \
    || "$invalid_index_output" == *"https://"* \
    || "$invalid_index_output" == *"P--BAD"* ]]; then
    emit "fail" "SMOKE_AGENT_INVALID_INDEX_DIAGNOSTIC_EXPOSED_INPUT"
    exit 1
  fi
done

set +e
leaking_index_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="leak" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
leaking_index_status=$?
set -e
if [[ "$leaking_index_status" -ne 87 \
  || "$leaking_index_output" != *'"code":"AGENT_PUBLIC_FACE_EXPOSES_FORBIDDEN_FIELDS"'* ]]; then
  emit "fail" "SMOKE_AGENT_FORBIDDEN_PUBLIC_FIELD_NOT_DETECTED"
  exit 1
fi
if [[ "$leaking_index_output" == *"synthetic-canary"* \
  || "$leaking_index_output" == *"agent-preview.example"* \
  || "$leaking_index_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_PUBLIC_LEAK_DIAGNOSTIC_EXPOSED_INPUT"
  exit 1
fi

set +e
benign_index_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="benign" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
benign_index_status=$?
set -e
if [[ "$benign_index_status" -ne 87 \
  || "$benign_index_output" != *'"code":"AGENT_SPONSOR_READ_PROBE_UNAVAILABLE"'* ]]; then
  emit "fail" "SMOKE_AGENT_PUBLIC_VALUE_FALSE_POSITIVE"
  exit 1
fi
if [[ "$benign_index_output" == *"P-private-workshop"* \
  || "$benign_index_output" == *"agent-preview.example"* \
  || "$benign_index_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_BENIGN_INDEX_DIAGNOSTIC_EXPOSED_INPUT"
  exit 1
fi

set +e
workshop_probe_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="workshop" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
workshop_probe_status=$?
set -e
if [[ "$workshop_probe_status" -ne 87 \
  || "$workshop_probe_output" != *'"code":"AGENT_SPONSOR_READ_PROBE_UNAVAILABLE"'* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PROBE_FAILURE_MISCLASSIFIED"
  exit 1
fi
if [[ "$workshop_probe_output" == *"agent-preview.example"* \
  || "$workshop_probe_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PROBE_FAILURE_LEAKED_ORIGIN"
  exit 1
fi

set +e
reachable_workshop_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="reachable" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
reachable_workshop_status=$?
set -e
if [[ "$reachable_workshop_status" -ne 87 \
  || "$reachable_workshop_output" != *'"code":"AGENT_SPONSOR_READ_REACHABLE_ANONYMOUSLY"'* ]]; then
  emit "fail" "SMOKE_AGENT_ANONYMOUS_SPONSOR_READ_FALSE_GREEN"
  exit 1
fi
if [[ "$reachable_workshop_output" == *"P-4DSP"* \
  || "$reachable_workshop_output" == *"agent-preview.example"* \
  || "$reachable_workshop_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_ANONYMOUS_SPONSOR_READ_DIAGNOSTIC_EXPOSED_INPUT"
  exit 1
fi

set +e
parser_bypass_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="parser" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
parser_bypass_status=$?
set -e
if [[ "$parser_bypass_status" -ne 87 \
  || "$parser_bypass_output" != *'"code":"AGENT_SPONSOR_AUTHENTICATION_BYPASSED"'* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PARSER_BYPASS_FALSE_GREEN"
  exit 1
fi
if [[ "$parser_bypass_output" == *"agent-preview.example"* \
  || "$parser_bypass_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PARSER_BYPASS_LEAKED_ORIGIN"
  exit 1
fi

set +e
unproven_workshop_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="unproven" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
unproven_workshop_status=$?
set -e
if [[ "$unproven_workshop_status" -ne 87 \
  || "$unproven_workshop_output" != *'"code":"AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN"'* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_AUTH_UNAVAILABLE_MISCLASSIFIED"
  exit 1
fi
if [[ "$unproven_workshop_output" == *"agent-preview.example"* \
  || "$unproven_workshop_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_AUTH_UNPROVEN_LEAKED_ORIGIN"
  exit 1
fi

for invalid_auth_mode in \
  auth-wrong-code \
  auth-forbidden \
  auth-malformed \
  auth-wrong-title \
  auth-wrong-detail \
  auth-wrong-fix \
  auth-wrong-media; do
  set +e
  invalid_auth_output="$(
    PATH="$curl_failure_fixture:$PATH" \
      SMOKE_FAKE_PROBLEMS_MODE="$invalid_auth_mode" \
      ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
      "$repository_root/scripts/smoke-agent.sh" 2>&1
  )"
  invalid_auth_status=$?
  set -e
  if [[ "$invalid_auth_status" -ne 87 \
    || "$invalid_auth_output" != *'"code":"AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN"'* ]]; then
    emit "fail" "SMOKE_AGENT_NONCANONICAL_AUTH_REFUSAL_FALSE_GREEN"
    exit 1
  fi
  if [[ "$invalid_auth_output" == *"WRONG_PRINCIPAL"* \
    || "$invalid_auth_output" == *"agent-preview.example"* \
    || "$invalid_auth_output" == *"https://"* ]]; then
    emit "fail" "SMOKE_AGENT_NONCANONICAL_AUTH_DIAGNOSTIC_EXPOSED_INPUT"
    exit 1
  fi
done

set +e
workshop_shape_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="shape" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
workshop_shape_status=$?
set -e
if [[ "$workshop_shape_status" -ne 88 \
  || "$workshop_shape_output" != *'"code":"AGENT_CURSOR_NOT_BARE_INTEGER"'* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PROBE_REQUEST_SHAPE_DRIFTED"
  exit 1
fi
if [[ "$workshop_shape_output" == *"agent-preview.example"* \
  || "$workshop_shape_output" == *"https://"* ]]; then
  emit "fail" "SMOKE_AGENT_SPONSOR_PROBE_SHAPE_DIAGNOSTIC_EXPOSED_INPUT"
  exit 1
fi

set +e
cursor_http_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="cursor-http" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
cursor_http_status=$?
set -e
if [[ "$cursor_http_status" -ne 88 \
  || "$cursor_http_output" != *'"code":"AGENT_CURSOR_HTTP_FAILURE"'* ]]; then
  emit "fail" "SMOKE_AGENT_CURSOR_HTTP_FAILURE_MISCLASSIFIED"
  exit 1
fi

set +e
cursor_transport_output="$(
  PATH="$curl_failure_fixture:$PATH" \
    SMOKE_FAKE_PROBLEMS_MODE="cursor-transport" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent-preview.example" \
    "$repository_root/scripts/smoke-agent.sh" 2>&1
)"
cursor_transport_status=$?
set -e
if [[ "$cursor_transport_status" -ne 88 \
  || "$cursor_transport_output" != *'"code":"AGENT_CURSOR_UNAVAILABLE"'* ]]; then
  emit "fail" "SMOKE_AGENT_CURSOR_TRANSPORT_FAILURE_MISCLASSIFIED"
  exit 1
fi
for cursor_diagnostic in "$cursor_http_output" "$cursor_transport_output"; do
  if [[ "$cursor_diagnostic" == *"agent-preview.example"* \
    || "$cursor_diagnostic" == *"https://"* ]]; then
    emit "fail" "SMOKE_AGENT_CURSOR_FAILURE_LEAKED_ORIGIN"
    exit 1
  fi
done

# Keep every command substitution that can fail because of network or response
# parsing out of Bash's implicit `set -e` exit path. The two multiline device
# flow calls and smoke_loop writes already carry guards on their closing lines;
# these single-line assignments are the easy regression shape.
for guarded_assignment in \
  loop_session_id \
  loop_pack \
  cursor_before \
  loop_workshop_id \
  cursor_after; do
  if ! awk -v assignment="$guarded_assignment" '
    index($0, assignment "=\"$(") == 1 && /\|\|/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$repository_root/scripts/smoke-agent.sh"; then
    emit "fail" "SMOKE_AGENT_UNGUARDED_COMMAND_SUBSTITUTION"
    exit 1
  fi
done

# /cursor is global, so another staging Fellow may advance it between this
# smoke's reads. Requiring exactly +1 turns correct concurrent runs red; the
# smoke may require at least +1 because its following P11 lookup proves its own
# claim committed.
if ! awk '
  /^[[:space:]]*if \(\( cursor_after < cursor_before \+ 1 \)\); then[[:space:]]*$/ { found = 1 }
  END { exit(found ? 0 : 1) }
' "$repository_root/scripts/smoke-agent.sh"; then
  emit "fail" "SMOKE_AGENT_CURSOR_ASSERTION_NOT_CONCURRENCY_SAFE"
  exit 1
fi

if missing_surface_output="$(ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://127.0.0.1:1" "$repository_root/scripts/smoke-agent.sh" 2>&1)"; then
  emit "fail" "MISSING_STAGING_SURFACE_ACCEPTED"
  exit 1
fi

if [[ "$missing_surface_output" != *'"code":"AGENT_HANDBOOK_UNAVAILABLE"'* ]]; then
  emit "fail" "MISSING_STAGING_SURFACE_DIAGNOSTIC_MISSING"
  exit 1
fi

if [[ "$missing_surface_output" == *"127.0.0.1:1"* ]] || [[ "$missing_surface_output" == *"https://"* ]]; then
  emit "fail" "MISSING_STAGING_SURFACE_ORIGIN_LEAKED"
  exit 1
fi

emit "pass" "ENTRYPOINT_NEGATIVE_CONTRACT_OK"
