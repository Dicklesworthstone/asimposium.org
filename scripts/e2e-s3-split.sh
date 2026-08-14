#!/usr/bin/env bash
#
# S-3's mock-free paired-principal E2E gate.  This script is intentionally
# blocked, not green: routes, migrations, a real D1/R2 namespace, and a
# workerd/staging deployment have not yet been wired.  Unit tests in
# apps/wire/test/split exercise only the split policy/service seam and are not
# a substitute for this gate.
#
# Consumer: the S-3 release gate, once Krater and the Worker routes exist.
# Observed defect class: a workshop object or private CAS digest reaches a
# public/cache/search/export surface; an R2-staged body becomes readable
# without a finalized D1 binding/recovery record; or a retry makes a second
# public event. R2 is outside D1, so this gate must exercise the adapter's
# staged-copy/binding recovery seam rather than claiming cross-service rollback.
# Deletion condition: replace this refusal with the actual paired-principal
# script after it runs against isolated local bindings and staging.

set -u -o pipefail

readonly started_seconds="${SECONDS}"
readonly duration_ms="$(( (SECONDS - started_seconds) * 1000 ))"
readonly reproduce="bash scripts/e2e-s3-split.sh"
readonly blocked_on="real D1 and R2 migrations, Worker split routes, and an isolated workerd or staging namespace"
readonly forbidden_substitutes="mocked or stubbed D1/R2, in-memory SplitService tests, test support bindings, and browser assertions without a deployed split"

printf '{"tool":"bash","tool_version":"%s","package":"@asimposium/wire","package_version":"0.0.0","suite":"e2e-s3-split","duration_ms":%s,"status":"blocked","exit_code":78,"code":"SPLIT_E2E_BLOCKED","blocked_on":"%s","forbidden_substitutes":"%s","reproduce":"%s"}\n' \
  "${BASH_VERSION}" "${duration_ms}" "${blocked_on}" "${forbidden_substitutes}" "${reproduce}"
printf 'BLOCKED e2e-s3-split (exit 78): %s\n' "${blocked_on}" >&2
printf '  must not be faked with: %s\n' "${forbidden_substitutes}" >&2
printf '  reproduce: %s\n' "${reproduce}" >&2
exit 78
