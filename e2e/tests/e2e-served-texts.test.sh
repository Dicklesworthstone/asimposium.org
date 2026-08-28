#!/usr/bin/env bash
set -euo pipefail

# Table tests for scripts/e2e-served-texts.sh. Self-test must pass; a planted
# missing inoculation route must refuse SERVED_TEXT_ROUTE_UNSERVED inside the
# fixture table (the script's --self-test already walks those defects). Live
# staging is not this file's job.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="e2e-served-texts-unit"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/e2e-served-texts.test.sh"
script="$repository_root/scripts/e2e-served-texts.sh"

emit() {
  e2e_emit_diagnostic "$suite" "$started_ms" "$1" "$2" "$reproduce"
}

if ! "$script" --self-test >/dev/null; then
  emit "fail" "SELF_TEST_FAILED"
  exit 1
fi

if output="$("$script" --self-test 2>/dev/null)"; then
  :
else
  emit "fail" "SELF_TEST_FAILED"
  exit 1
fi
if [[ "$output" != *'"code":"SERVED_TEXT_FIXTURE_SELF_TEST_OK"'* ]]; then
  emit "fail" "SELF_TEST_CODE_MISSING"
  exit 1
fi
if [[ "$output" == *asimp_ag_* || "$output" == *"#v1."* || "$output" == *"/Users/"* ]]; then
  emit "fail" "SELF_TEST_LEAKS_FORBIDDEN_BYTES"
  exit 1
fi

if "$script" --bogus >/dev/null 2>&1; then
  emit "fail" "UNKNOWN_ARGUMENT_UNREFUSED"
  exit 1
fi

emit "pass" "E2E_SERVED_TEXTS_UNIT_OK"
exit 0
