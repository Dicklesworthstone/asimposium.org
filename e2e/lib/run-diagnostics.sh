#!/usr/bin/env bash
# shellcheck disable=SC2034
# Shared, secret-safe diagnostics for executable E2E entry points.
# This file is sourced by the runners; it intentionally never prints input
# values, origins, credentials, artifact roots, or local absolute paths.

ASIMPOSIUM_E2E_HARNESS_VERSION="0.1.0"
ASIMPOSIUM_E2E_HTTP_USER_AGENT="OpenAI File Downloader, XaiImageApiFetch/1.0"
readonly ASIMPOSIUM_E2E_HTTP_USER_AGENT
ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES=1048576
readonly ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES
ASIMPOSIUM_E2E_ARTIFACT_MAINTENANCE_FENCE=".artifact-maintenance"
readonly ASIMPOSIUM_E2E_ARTIFACT_MAINTENANCE_FENCE
ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASES=".artifact-writer-leases"
readonly ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASES
ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED="closed"
readonly ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED

# Successful artifact namespace claims are process capabilities. Bash arrays
# survive the command-substitution subshells used by the writer helpers, but
# they are not exported to an independently started shell. Binding the claim to
# the directory's device/inode rejects a replacement observed before a helper
# publishes. Every claim also owns an append-only lifetime lease outside the
# rotatable artifact root. Maintenance can therefore fence new claims and wait
# for the matching root epoch to contain only closed leases before moving it.
# Top-level declarations are global without Bash 4's non-portable `declare -g`.
declare -a ASIMPOSIUM_E2E_CLAIM_ROOTS=()
declare -a ASIMPOSIUM_E2E_CLAIM_ROOT_IDENTITIES=()
declare -a ASIMPOSIUM_E2E_CLAIM_RUN_IDS=()
declare -a ASIMPOSIUM_E2E_CLAIM_IDENTITIES=()
declare -a ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS=()
declare -a ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES=()
ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH=""
ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY=""
ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT=""
ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY=""
ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_DIRECTORY=""
ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY=""
ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY=""
ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY=""
ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY=""
ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY=""

e2e_ascii_lower() {
  LC_ALL=C tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'
}

e2e_curl_header_preserves_user_agent() {
  local header_value="$1"

  header_value="${header_value#"${header_value%%[![:space:]]*}"}"
  [[ "$header_value" != @* ]] || return 1
  [[ "$header_value" != *$'\n'* && "$header_value" != *$'\r'* ]] || return 1
  [[ ! "$header_value" =~ ^[Uu][Ss][Ee][Rr]-[Aa][Gg][Ee][Nn][Tt][[:space:]]*[:\;] ]]
}

e2e_curl_policy_arguments_valid() {
  local argument
  local expect_header=0
  local header_value

  # These options are part of the evidence boundary, not caller preferences.
  # Refuse an attempted override before curl starts; otherwise a later caller
  # argument wins over the defaults below. Config files are refused here too:
  # the authenticated wrapper owns the sole stdin config line itself.
  for argument in "$@"; do
    if [[ "$expect_header" -eq 1 ]]; then
      e2e_curl_header_preserves_user_agent "$argument" || return 64
      expect_header=0
      continue
    fi
    case "$argument" in
      --heade*=*)
        header_value="${argument#*=}"
        e2e_curl_header_preserves_user_agent "$header_value" || return 64
        ;;
      --heade* | -H)
        expect_header=1
        ;;
      -H?*)
        header_value="${argument#-H}"
        e2e_curl_header_preserves_user_agent "$header_value" || return 64
        ;;
      --expand-h* | --user-a* | --max-re* | --max-f* | --locat* | --no-locat* | \
        --conf* | --nex* | -: | -[!-]*:* | -A | -A?* | -K | -K?* | \
        -L | -[!-]*A* | -[!-]*H* | -[!-]*K* | -[!-]*L*)
        return 64
        ;;
    esac
  done

  [[ "$expect_header" -eq 0 ]] || return 64
}

e2e_curl() {
  e2e_curl_policy_arguments_valid "$@" || return 64

  command curl \
    --disable \
    --user-agent "$ASIMPOSIUM_E2E_HTTP_USER_AGENT" \
    --max-redirs 0 \
    --max-filesize "$ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES" \
    --no-location \
    "$@"
}

e2e_validate_fellow_token() {
  local fellow_token="$1"
  [[ "$fellow_token" =~ ^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$ ]]
}

e2e_curl_with_fellow_token() {
  local fellow_token="$1"
  shift

  e2e_validate_fellow_token "$fellow_token" || return 64
  # The one allowed config source is the wrapper-owned stdin line below, so a
  # caller cannot replace transport policy or append another config source.
  e2e_curl_policy_arguments_valid "$@" || return 64

  # curl reads the Authorization header from stdin. The credential therefore
  # appears neither in curl's argv nor in its inherited environment.
  command curl \
    --disable \
    --user-agent "$ASIMPOSIUM_E2E_HTTP_USER_AGENT" \
    --max-redirs 0 \
    --max-filesize "$ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES" \
    --no-location \
    --config - \
    "$@" <<<"header = \"Authorization: Bearer $fellow_token\""
}

e2e_now_ms() {
  local candidate
  candidate="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$candidate" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${candidate:0:13}"
    return 0
  fi

  printf '%s000\n' "$(date +%s)"
}

e2e_elapsed_ms() {
  local started_ms="$1"
  local now_ms
  now_ms="$(e2e_now_ms)"
  printf '%s\n' "$((now_ms - started_ms))"
}

e2e_validate_run_id() {
  local run_id="$1"
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]
}

e2e_artifact_relpath() {
  local run_id="$1"
  e2e_validate_run_id "$run_id" || return 1
  printf 'e2e/artifacts/%s\n' "$run_id"
}

e2e_generated_run_id() {
  local suite="$1"
  printf '%s-%s-%s\n' "$suite" "$(date -u +%Y%m%dT%H%M%S)" "$$"
}

e2e_resolve_run_id() {
  local suite="$1"
  local explicit_run_id="${2:-}"
  local environment_run_id="${ASIMPOSIUM_E2E_RUN_ID:-}"
  local run_id

  if [[ -n "$explicit_run_id" && -n "$environment_run_id" && "$explicit_run_id" != "$environment_run_id" ]]; then
    return 1
  fi

  run_id="${explicit_run_id:-${environment_run_id:-$(e2e_generated_run_id "$suite")}}"
  e2e_validate_run_id "$run_id" || return 1
  printf '%s\n' "$run_id"
}

e2e_validate_staging_origin() {
  local variable_name="$1"
  local origin="${!variable_name:-}"
  local authority
  local hostname
  local port

  [[ -n "$origin" ]] || return 2
  [[ "$origin" == https://* ]] || return 1

  authority="${origin#https://}"
  [[ -n "$authority" ]] || return 1
  [[ "$authority" != */* ]] || return 1
  [[ "$authority" != *"?"* ]] || return 1
  [[ "$authority" != *"#"* ]] || return 1
  [[ "$authority" != *"@"* ]] || return 1
  [[ "$authority" != *[[:space:]]* ]] || return 1
  # Accept only a DNS name (or dotted-decimal hostname) with an optional
  # decimal port. Curl's permissive URL parser must not get to reinterpret
  # backslashes, escapes, delimiters, or an out-of-range port after this gate.
  [[ "$authority" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?(:[1-9][0-9]{0,4})?$ ]] || return 1
  if [[ "$authority" == *:* ]]; then
    port="${authority##*:}"
    (( 10#$port > 0 && 10#$port <= 65535 )) || return 1
  fi

  # Staging evidence must never be borrowed from the canonical deployment. Do
  # this before any caller launches curl or a browser, including explicit ports
  # and a DNS-equivalent trailing dot.
  hostname="${authority%%:*}"
  hostname="${hostname%.}"
  hostname="$(printf '%s' "$hostname" | e2e_ascii_lower)" || return 1
  case "$hostname" in
    a.asimposium.org | artifacts.asimposium.org | asimposium.org | www.asimposium.org)
      return 1
      ;;
  esac
}

e2e_json_escape() {
  local string="$1"
  string="${string//\\/\\\\}"
  string="${string//\"/\\\"}"
  string="${string//$'\n'/\\n}"
  string="${string//$'\r'/\\r}"
  string="${string//$'\t'/\\t}"
  printf '%s' "$string"
}

e2e_format_diagnostic() {
  local suite="$1"
  local started_ms="$2"
  local status="$3"
  local code="$4"
  local reproduce="$5"
  local duration_ms

  duration_ms="$(e2e_elapsed_ms "$started_ms")"
  printf '{"tool":"bash","tool_version":"%s","package":"e2e","suite":"%s","version":"%s","duration_ms":%s,"status":"%s","code":"%s","reproduce":"%s"}\n' \
    "$(e2e_json_escape "${BASH_VERSION%% *}")" \
    "$(e2e_json_escape "$suite")" \
    "$(e2e_json_escape "$ASIMPOSIUM_E2E_HARNESS_VERSION")" \
    "$duration_ms" \
    "$(e2e_json_escape "$status")" \
    "$(e2e_json_escape "$code")" \
    "$(e2e_json_escape "$reproduce")"
}

e2e_emit_diagnostic() {
  if [[ "$3" == "fail" ]]; then
    e2e_format_diagnostic "$@" >&2
    return 0
  fi

  e2e_format_diagnostic "$@"
}

e2e_physical_directory() {
  local directory="$1"

  [[ -d "$directory" ]] || return 1
  (cd -P "$directory" 2>/dev/null && pwd -P)
}

e2e_artifacts_root_at_root() {
  local repository_root="$1"
  local create_if_missing="${2:-0}"
  local physical_repository_root
  local e2e_root
  local physical_e2e_root
  local artifacts_root
  local physical_artifacts_root

  physical_repository_root="$(e2e_physical_directory "$repository_root")" || return 1
  e2e_root="$physical_repository_root/e2e"
  physical_e2e_root="$(e2e_physical_directory "$e2e_root")" || return 1
  [[ "$physical_e2e_root" == "$physical_repository_root/e2e" ]] || return 1

  artifacts_root="$physical_e2e_root/artifacts"
  if [[ -e "$artifacts_root" || -L "$artifacts_root" ]]; then
    [[ -d "$artifacts_root" && ! -L "$artifacts_root" ]] || return 1
  else
    [[ "$create_if_missing" == "1" ]] || return 1
    mkdir "$artifacts_root" 2>/dev/null || return 1
  fi
  physical_artifacts_root="$(e2e_physical_directory "$artifacts_root")" || return 1
  [[ "$physical_artifacts_root" == "$physical_e2e_root/artifacts" ]] || return 1
  printf '%s\n' "$physical_artifacts_root"
}

e2e_artifact_directory_identity() {
  local directory="$1"
  local identity

  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  # GNU stat uses -c for file device/inode; BSD/macOS stat uses -f. Try the
  # unambiguous GNU form first because GNU `stat -f` reports filesystem fields,
  # not this directory's inode.
  identity="$(command stat -c '%d:%i' "$directory" 2>/dev/null)" \
    || identity="$(command stat -f '%d:%i' "$directory" 2>/dev/null)" \
    || return 1
  [[ "$identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s\n' "$identity"
}

e2e_artifact_writer_lease_epoch_name() {
  local root_identity="$1"
  local device
  local inode

  [[ "$root_identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  device="${root_identity%%:*}"
  inode="${root_identity##*:}"
  printf 'dev-%s-ino-%s\n' "$device" "$inode"
}

e2e_artifact_writer_lease_root_at_root() {
  local repository_root="$1"
  local create_if_missing="${2:-0}"
  local physical_repository_root
  local physical_e2e_root
  local lease_root
  local physical_lease_root

  physical_repository_root="$(e2e_physical_directory "$repository_root")" || return 1
  physical_e2e_root="$(e2e_physical_directory "$physical_repository_root/e2e")" || return 1
  [[ "$physical_e2e_root" == "$physical_repository_root/e2e" ]] || return 1
  lease_root="$physical_e2e_root/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASES"
  if [[ -e "$lease_root" || -L "$lease_root" ]]; then
    [[ -d "$lease_root" && ! -L "$lease_root" ]] || return 1
  else
    [[ "$create_if_missing" == "1" ]] || return 1
    # Another writer may atomically establish this shared append-only parent
    # after our absence check. Accept only the exact direct directory in that
    # case; every other mkdir failure remains a refusal.
    mkdir "$lease_root" 2>/dev/null \
      || [[ -d "$lease_root" && ! -L "$lease_root" ]] \
      || return 1
  fi
  physical_lease_root="$(e2e_physical_directory "$lease_root")" || return 1
  [[ "$physical_lease_root" == "$lease_root" ]] || return 1
  printf '%s\n' "$physical_lease_root"
}

e2e_artifact_writer_lease_epoch_at_root() {
  local repository_root="$1"
  local root_identity="$2"
  local create_if_missing="${3:-0}"
  local lease_root
  local epoch_name
  local epoch_directory
  local physical_epoch_directory

  lease_root="$(e2e_artifact_writer_lease_root_at_root "$repository_root" "$create_if_missing")" || return 1
  epoch_name="$(e2e_artifact_writer_lease_epoch_name "$root_identity")" || return 1
  epoch_directory="$lease_root/$epoch_name"
  if [[ -e "$epoch_directory" || -L "$epoch_directory" ]]; then
    [[ -d "$epoch_directory" && ! -L "$epoch_directory" ]] || return 1
  else
    [[ "$create_if_missing" == "1" ]] || return 1
    mkdir "$epoch_directory" 2>/dev/null \
      || [[ -d "$epoch_directory" && ! -L "$epoch_directory" ]] \
      || return 1
  fi
  physical_epoch_directory="$(e2e_physical_directory "$epoch_directory")" || return 1
  [[ "$physical_epoch_directory" == "$epoch_directory" ]] || return 1
  printf '%s\n' "$physical_epoch_directory"
}

e2e_acquire_artifact_writer_lease_at_root() {
  local repository_root="$1"
  local root_identity="$2"
  local epoch_directory
  local lease_directory
  local physical_lease_directory
  local lease_identity
  local opened_at
  local counter=0

  ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH=""
  ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY=""
  epoch_directory="$(e2e_artifact_writer_lease_epoch_at_root "$repository_root" "$root_identity" 1)" \
    || return 1
  opened_at="$(date -u +%s 2>/dev/null)" || return 1
  [[ "$opened_at" =~ ^[0-9]+$ ]] || return 1

  while ((counter < 100)); do
    lease_directory="$epoch_directory/lease-$$-$opened_at-$counter-$RANDOM"
    if mkdir "$lease_directory" 2>/dev/null; then
      physical_lease_directory="$(e2e_physical_directory "$lease_directory")" || return 1
      [[ "$physical_lease_directory" == "$lease_directory" ]] || return 1
      lease_identity="$(e2e_artifact_directory_identity "$physical_lease_directory")" || return 1
      ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH="$physical_lease_directory"
      ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY="$lease_identity"
      return 0
    fi
    counter=$((counter + 1))
  done
  return 1
}

e2e_artifact_writer_lease_is_open() {
  local lease_directory="$1"
  local expected_identity="$2"
  local physical_lease_directory
  local closed_marker

  [[ -d "$lease_directory" && ! -L "$lease_directory" ]] || return 1
  physical_lease_directory="$(e2e_physical_directory "$lease_directory")" || return 1
  [[ "$physical_lease_directory" == "$lease_directory" ]] || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_lease_directory")" == "$expected_identity" ]] \
    || return 1
  closed_marker="$physical_lease_directory/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED"
  [[ ! -e "$closed_marker" && ! -L "$closed_marker" ]]
}

e2e_close_artifact_writer_lease() {
  local lease_directory="$1"
  local expected_identity="$2"
  local physical_lease_directory
  local closed_marker
  local physical_closed_marker

  [[ -d "$lease_directory" && ! -L "$lease_directory" ]] || return 1
  physical_lease_directory="$(e2e_physical_directory "$lease_directory")" || return 1
  [[ "$physical_lease_directory" == "$lease_directory" ]] || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_lease_directory")" == "$expected_identity" ]] \
    || return 1
  closed_marker="$physical_lease_directory/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED"
  if [[ -e "$closed_marker" || -L "$closed_marker" ]]; then
    [[ -d "$closed_marker" && ! -L "$closed_marker" ]] || return 1
  else
    mkdir "$closed_marker" 2>/dev/null || return 1
  fi
  physical_closed_marker="$(e2e_physical_directory "$closed_marker")" || return 1
  [[ "$physical_closed_marker" == "$closed_marker" ]]
}

e2e_close_artifact_writer_leases() {
  local index
  local close_status=0

  for ((index = 0; index < ${#ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[@]}; index++)); do
    e2e_close_artifact_writer_lease \
      "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[$index]}" \
      "${ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES[$index]-}" \
      || close_status=1
  done
  return "$close_status"
}

e2e_close_artifact_writer_leases_on_exit() {
  local original_status=$?

  # Some Bash configurations propagate EXIT into command-substitution or
  # parenthesized subshells. Those children inherit a snapshot of the claim
  # arrays but do not own the parent writer's lifetime; closing from there
  # would let maintenance move the root while the entry point is still live.
  if ((BASH_SUBSHELL > 0)); then
    return "$original_status"
  fi
  trap - EXIT
  if ! e2e_close_artifact_writer_leases; then
    [[ "$original_status" -ne 0 ]] || original_status=76
  fi
  exit "$original_status"
}

e2e_leave_artifact_writer_leases_open_on_signal() {
  local signal_exit_code="$1"

  # A signal delivered only to the shell does not prove its foreground child
  # or descendants are gone. Suppress the normal closer and leave the
  # append-only lease open; maintenance must prefer a durable false refusal to
  # moving artifacts underneath work that may still be alive.
  trap - EXIT INT TERM HUP
  exit "$signal_exit_code"
}

# Read-only maintenance census for one physical artifact-root epoch. It never
# reclaims a lease based on PID, age, or mtime: a crash leaves an open lease and
# therefore a permanent safe refusal until an operator explicitly adjudicates
# the append-only record. Malformed nodes anywhere in the registry also fail
# closed; valid open leases block only the root epoch they name.
e2e_artifact_writer_leases_quiescent_at_root() (
  local repository_root="$1"
  local root_identity="$2"
  local lease_root
  local wanted_epoch
  local epoch_directory
  local epoch_name
  local lease_directory
  local lease_name
  local child
  local child_name
  local -a epoch_entries=()
  local -a lease_entries=()
  local -a child_entries=()
  local -a closed_entries=()

  wanted_epoch="$(e2e_artifact_writer_lease_epoch_name "$root_identity")" || return 1
  if ! lease_root="$(e2e_artifact_writer_lease_root_at_root "$repository_root")"; then
    local physical_repository_root
    local physical_e2e_root
    physical_repository_root="$(e2e_physical_directory "$repository_root")" || return 1
    physical_e2e_root="$(e2e_physical_directory "$physical_repository_root/e2e")" || return 1
    [[ "$physical_e2e_root" == "$physical_repository_root/e2e" ]] || return 1
    [[ ! -e "$physical_e2e_root/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASES" \
      && ! -L "$physical_e2e_root/$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASES" ]]
    return
  fi

  shopt -s nullglob dotglob
  epoch_entries=("$lease_root"/*)
  for epoch_directory in "${epoch_entries[@]}"; do
    epoch_name="${epoch_directory##*/}"
    [[ "$epoch_name" =~ ^dev-[0-9]+-ino-[0-9]+$ ]] || return 1
    [[ -d "$epoch_directory" && ! -L "$epoch_directory" ]] || return 1
    [[ "$(e2e_physical_directory "$epoch_directory")" == "$epoch_directory" ]] || return 1

    lease_entries=("$epoch_directory"/*)
    for lease_directory in "${lease_entries[@]}"; do
      lease_name="${lease_directory##*/}"
      [[ "$lease_name" =~ ^lease-[0-9]+-[0-9]+-[0-9]+-[0-9]+$ ]] || return 1
      [[ -d "$lease_directory" && ! -L "$lease_directory" ]] || return 1
      [[ "$(e2e_physical_directory "$lease_directory")" == "$lease_directory" ]] || return 1

      child_entries=("$lease_directory"/*)
      if ((${#child_entries[@]} == 0)); then
        [[ "$epoch_name" != "$wanted_epoch" ]] || return 1
        continue
      fi
      ((${#child_entries[@]} == 1)) || return 1
      child="${child_entries[0]}"
      child_name="${child##*/}"
      [[ "$child_name" == "$ASIMPOSIUM_E2E_ARTIFACT_WRITER_LEASE_CLOSED" ]] || return 1
      [[ -d "$child" && ! -L "$child" ]] || return 1
      [[ "$(e2e_physical_directory "$child")" == "$child" ]] || return 1
      closed_entries=("$child"/*)
      ((${#closed_entries[@]} == 0)) || return 1
    done
  done
)

e2e_artifact_maintenance_absent_at_root() {
  local repository_root="$1"
  local physical_repository_root
  local physical_e2e_root
  local fence

  physical_repository_root="$(e2e_physical_directory "$repository_root")" || return 1
  physical_e2e_root="$(e2e_physical_directory "$physical_repository_root/e2e")" || return 1
  [[ "$physical_e2e_root" == "$physical_repository_root/e2e" ]] || return 1
  fence="$physical_e2e_root/$ASIMPOSIUM_E2E_ARTIFACT_MAINTENANCE_FENCE"
  # Any node at the reserved name is a closed gate. Treating only a regular
  # file as the fence would let a symlink or directory silently disable it.
  [[ ! -e "$fence" && ! -L "$fence" ]]
}

e2e_artifact_claim_matches() {
  local physical_artifacts_root="$1"
  local root_identity="$2"
  local run_id="$3"
  local identity="$4"
  local index

  for ((index = 0; index < ${#ASIMPOSIUM_E2E_CLAIM_RUN_IDS[@]}; index++)); do
    if [[ "${ASIMPOSIUM_E2E_CLAIM_ROOTS[$index]}" == "$physical_artifacts_root" \
      && "${ASIMPOSIUM_E2E_CLAIM_ROOT_IDENTITIES[$index]}" == "$root_identity" \
      && "${ASIMPOSIUM_E2E_CLAIM_RUN_IDS[$index]}" == "$run_id" \
      && "${ASIMPOSIUM_E2E_CLAIM_IDENTITIES[$index]}" == "$identity" ]]; then
      e2e_artifact_writer_lease_is_open \
        "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[$index]-}" \
        "${ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES[$index]-}" \
        && return 0
    fi
  done
  return 1
}

e2e_select_artifact_claim_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local physical_artifacts_root
  local root_identity
  local run_directory
  local physical_run_directory
  local run_identity
  local index

  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT=""
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY=""
  ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY=""
  ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY=""

  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root")" || return 1
  root_identity="$(e2e_artifact_directory_identity "$physical_artifacts_root")" || return 1
  run_directory="$physical_artifacts_root/$run_id"
  physical_run_directory="$(e2e_physical_directory "$run_directory")" || return 1
  [[ "$physical_run_directory" == "$run_directory" && ! -L "$run_directory" ]] || return 1
  run_identity="$(e2e_artifact_directory_identity "$physical_run_directory")" || return 1

  for ((index = 0; index < ${#ASIMPOSIUM_E2E_CLAIM_RUN_IDS[@]}; index++)); do
    if [[ "${ASIMPOSIUM_E2E_CLAIM_ROOTS[$index]}" == "$physical_artifacts_root" \
      && "${ASIMPOSIUM_E2E_CLAIM_ROOT_IDENTITIES[$index]}" == "$root_identity" \
      && "${ASIMPOSIUM_E2E_CLAIM_RUN_IDS[$index]}" == "$run_id" \
      && "${ASIMPOSIUM_E2E_CLAIM_IDENTITIES[$index]}" == "$run_identity" ]] \
      && e2e_artifact_writer_lease_is_open \
        "${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[$index]-}" \
        "${ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES[$index]-}"; then
      e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
      ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT="$physical_artifacts_root"
      ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY="$root_identity"
      ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY="$physical_run_directory"
      ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY="$run_identity"
      ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY="${ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS[$index]}"
      ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY="${ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES[$index]}"
      return 0
    fi
  done
  return 1
}

e2e_artifact_directory_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local physical_artifacts_root
  local root_identity
  local artifact_directory
  local physical_artifact_directory
  local artifact_identity

  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root")" || return 1
  root_identity="$(e2e_artifact_directory_identity "$physical_artifacts_root")" || return 1

  artifact_directory="$physical_artifacts_root/$run_id"
  # Publication may only use a namespace that the entry point atomically
  # claimed before it began product work. Lazily creating or adopting a missing
  # directory here lets two same-run writers blend evidence and lets a writer
  # cross an artifact-root maintenance boundary between work and publication.
  [[ -d "$artifact_directory" && ! -L "$artifact_directory" ]] || return 1
  physical_artifact_directory="$(e2e_physical_directory "$artifact_directory")" || return 1
  [[ "$physical_artifact_directory" == "$physical_artifacts_root/$run_id" ]] || return 1
  artifact_identity="$(e2e_artifact_directory_identity "$physical_artifact_directory")" || return 1
  e2e_artifact_claim_matches "$physical_artifacts_root" "$root_identity" "$run_id" "$artifact_identity" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  printf '%s\n' "$physical_artifact_directory"
}

e2e_claim_artifact_run_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local physical_artifacts_root
  local root_identity
  local artifact_directory
  local physical_artifact_directory
  local artifact_identity
  local lease_directory
  local lease_identity

  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root" 1)" || return 1
  root_identity="$(e2e_artifact_directory_identity "$physical_artifacts_root")" || return 1
  artifact_directory="$physical_artifacts_root/$run_id"
  [[ ! -e "$artifact_directory" && ! -L "$artifact_directory" ]] || return 1
  e2e_acquire_artifact_writer_lease_at_root "$repository_root" "$root_identity" || return 1
  lease_directory="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH"
  lease_identity="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY"

  # The lease is visible before the exclusive run claim. If maintenance won
  # the fence race, close the lease without doing product work. If this writer
  # won, maintenance observes the open matching-epoch lease and cannot move the
  # artifact root until the entry point marks it closed after child reaping.
  if ! e2e_artifact_maintenance_absent_at_root "$repository_root" \
    || [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root" 2>/dev/null || true)" != "$root_identity" ]] \
    || ! e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity"; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi
  if ! mkdir "$artifact_directory" 2>/dev/null; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi
  physical_artifact_directory="$(e2e_physical_directory "$artifact_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  if [[ "$physical_artifact_directory" != "$physical_artifacts_root/$run_id" ]]; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi
  artifact_identity="$(e2e_artifact_directory_identity "$physical_artifact_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  if ! e2e_artifact_maintenance_absent_at_root "$repository_root" \
    || [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root" 2>/dev/null || true)" != "$root_identity" ]] \
    || ! e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity"; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi
  ASIMPOSIUM_E2E_CLAIM_ROOTS+=("$physical_artifacts_root")
  ASIMPOSIUM_E2E_CLAIM_ROOT_IDENTITIES+=("$root_identity")
  ASIMPOSIUM_E2E_CLAIM_RUN_IDS+=("$run_id")
  ASIMPOSIUM_E2E_CLAIM_IDENTITIES+=("$artifact_identity")
  ASIMPOSIUM_E2E_CLAIM_LEASE_PATHS+=("$lease_directory")
  ASIMPOSIUM_E2E_CLAIM_LEASE_IDENTITIES+=("$lease_identity")
}

# Claim one exclusive run below a shared, safe namespace such as
# `e2e/artifacts/s2-krater/<run-id>`. The append-only lease still belongs to the
# top-level artifact-root epoch, so whole-root maintenance sees both direct and
# namespaced writers in the same census.
e2e_claim_artifact_namespaced_run_at_root() {
  local repository_root="$1"
  local namespace="$2"
  local run_id="$3"
  local physical_artifacts_root
  local root_identity
  local namespace_directory
  local physical_namespace_directory
  local namespace_identity
  local run_directory
  local physical_run_directory
  local run_identity
  local lease_directory
  local lease_identity

  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT=""
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY=""
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY=""
  ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY=""
  ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY=""

  e2e_validate_run_id "$namespace" || return 1
  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root" 1)" || return 1
  root_identity="$(e2e_artifact_directory_identity "$physical_artifacts_root")" || return 1
  e2e_acquire_artifact_writer_lease_at_root "$repository_root" "$root_identity" || return 1
  lease_directory="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_PATH"
  lease_identity="$ASIMPOSIUM_E2E_ACQUIRED_LEASE_IDENTITY"

  if ! e2e_artifact_maintenance_absent_at_root "$repository_root" \
    || [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root" 2>/dev/null || true)" != "$root_identity" ]] \
    || ! e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity"; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi

  namespace_directory="$physical_artifacts_root/$namespace"
  if [[ -e "$namespace_directory" || -L "$namespace_directory" ]]; then
    [[ -d "$namespace_directory" && ! -L "$namespace_directory" ]] || {
      e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
      return 1
    }
  elif ! mkdir "$namespace_directory" 2>/dev/null; then
    # Concurrent runs may establish the one shared namespace. Accept only the
    # exact direct directory that both intended to use.
    [[ -d "$namespace_directory" && ! -L "$namespace_directory" ]] || {
      e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
      return 1
    }
  fi
  physical_namespace_directory="$(e2e_physical_directory "$namespace_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  [[ "$physical_namespace_directory" == "$namespace_directory" ]] || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  namespace_identity="$(e2e_artifact_directory_identity "$physical_namespace_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  run_directory="$physical_namespace_directory/$run_id"
  [[ ! -e "$run_directory" && ! -L "$run_directory" ]] || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  if ! e2e_artifact_maintenance_absent_at_root "$repository_root" \
    || [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root" 2>/dev/null || true)" != "$root_identity" ]] \
    || [[ "$(e2e_artifact_directory_identity "$physical_namespace_directory" 2>/dev/null || true)" != "$namespace_identity" ]] \
    || ! e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity" \
    || ! mkdir "$run_directory" 2>/dev/null; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi
  physical_run_directory="$(e2e_physical_directory "$run_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  [[ "$physical_run_directory" == "$run_directory" ]] || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  run_identity="$(e2e_artifact_directory_identity "$physical_run_directory")" || {
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  }
  if ! e2e_artifact_namespaced_run_matches_at_root \
    "$repository_root" "$namespace" "$run_id" \
    "$root_identity" "$namespace_identity" "$run_identity" \
    "$lease_directory" "$lease_identity"; then
    e2e_close_artifact_writer_lease "$lease_directory" "$lease_identity" >/dev/null 2>&1 || true
    return 1
  fi

  # shellcheck disable=SC2034
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT="$physical_artifacts_root"
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY="$root_identity"
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_DIRECTORY="$physical_namespace_directory"
  ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY="$namespace_identity"
  ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY="$physical_run_directory"
  ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY="$run_identity"
  ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY="$lease_directory"
  ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY="$lease_identity"
}

e2e_artifact_namespaced_run_matches_at_root() {
  local repository_root="$1"
  local namespace="$2"
  local run_id="$3"
  local expected_root_identity="$4"
  local expected_namespace_identity="$5"
  local expected_run_identity="$6"
  local lease_directory="$7"
  local lease_identity="$8"
  local physical_artifacts_root
  local namespace_directory
  local physical_namespace_directory
  local run_directory
  local physical_run_directory
  local epoch_directory

  e2e_validate_run_id "$namespace" || return 1
  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root")" || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root")" == "$expected_root_identity" ]] \
    || return 1
  namespace_directory="$physical_artifacts_root/$namespace"
  physical_namespace_directory="$(e2e_physical_directory "$namespace_directory")" || return 1
  [[ "$physical_namespace_directory" == "$namespace_directory" \
    && "$(e2e_artifact_directory_identity "$physical_namespace_directory")" == "$expected_namespace_identity" ]] \
    || return 1
  run_directory="$physical_namespace_directory/$run_id"
  physical_run_directory="$(e2e_physical_directory "$run_directory")" || return 1
  [[ "$physical_run_directory" == "$run_directory" \
    && "$(e2e_artifact_directory_identity "$physical_run_directory")" == "$expected_run_identity" ]] \
    || return 1
  epoch_directory="$(e2e_artifact_writer_lease_epoch_at_root \
    "$repository_root" "$expected_root_identity")" || return 1
  [[ "${lease_directory%/*}" == "$epoch_directory" ]] || return 1
  e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root"
}

# Exclusively claim another run beneath an already-open namespaced writer
# lease. The caller remains the sole lease owner and must keep it open until it
# has proved every child using the returned run capability has settled.
e2e_claim_artifact_namespaced_run_with_lease_at_root() {
  local repository_root="$1"
  local namespace="$2"
  local run_id="$3"
  local expected_root_identity="$4"
  local expected_namespace_identity="$5"
  local lease_directory="$6"
  local lease_identity="$7"
  local physical_artifacts_root
  local physical_namespace_directory
  local run_directory
  local physical_run_directory
  local run_identity
  local epoch_directory

  ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY=""
  ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY=""
  e2e_validate_run_id "$namespace" || return 1
  e2e_validate_run_id "$run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root")" || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root")" == "$expected_root_identity" ]] \
    || return 1
  physical_namespace_directory="$(
    e2e_physical_directory "$physical_artifacts_root/$namespace"
  )" || return 1
  [[ "$physical_namespace_directory" == "$physical_artifacts_root/$namespace" \
    && "$(e2e_artifact_directory_identity "$physical_namespace_directory")" == \
      "$expected_namespace_identity" ]] || return 1
  epoch_directory="$(e2e_artifact_writer_lease_epoch_at_root \
    "$repository_root" "$expected_root_identity")" || return 1
  [[ "${lease_directory%/*}" == "$epoch_directory" ]] || return 1
  e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1

  run_directory="$physical_namespace_directory/$run_id"
  [[ ! -e "$run_directory" && ! -L "$run_directory" ]] || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root" 2>/dev/null || true)" == \
      "$expected_root_identity" \
    && "$(e2e_artifact_directory_identity "$physical_namespace_directory" 2>/dev/null || true)" == \
      "$expected_namespace_identity" ]] || return 1
  e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity" || return 1
  e2e_artifact_maintenance_absent_at_root "$repository_root" || return 1
  mkdir "$run_directory" 2>/dev/null || return 1
  physical_run_directory="$(e2e_physical_directory "$run_directory")" || return 1
  [[ "$physical_run_directory" == "$run_directory" ]] || return 1
  run_identity="$(e2e_artifact_directory_identity "$physical_run_directory")" || return 1
  e2e_artifact_namespaced_run_matches_at_root \
    "$repository_root" "$namespace" "$run_id" \
    "$expected_root_identity" "$expected_namespace_identity" "$run_identity" \
    "$lease_directory" "$lease_identity" || return 1
  # shellcheck disable=SC2034
  ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY="$physical_run_directory"
  ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY="$run_identity"
}

e2e_write_artifact_diagnostic_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local suite="$3"
  local started_ms="$4"
  local status="$5"
  local code="$6"
  local reproduce="$7"
  local physical_artifact_directory
  local diagnostic_path

  physical_artifact_directory="$(e2e_artifact_directory_at_root "$repository_root" "$run_id")" || return 1

  diagnostic_path="$physical_artifact_directory/diagnostics.jsonl"
  [[ ! -L "$diagnostic_path" ]] || return 1
  if [[ -e "$diagnostic_path" && ! -f "$diagnostic_path" ]]; then
    return 1
  fi

  [[ "$(e2e_artifact_directory_at_root "$repository_root" "$run_id" 2>/dev/null || true)" \
    == "$physical_artifact_directory" ]] || return 1
  e2e_format_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce" >> "$diagnostic_path" 2>/dev/null || return 1
  printf 'e2e/artifacts/%s/diagnostics.jsonl\n' "$run_id"
}

e2e_append_artifact_jsonl_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local file_name="$3"
  local record="$4"
  local physical_artifact_directory
  local artifact_path

  [[ "$file_name" =~ ^[a-z0-9][a-z0-9._-]{0,79}\.jsonl$ ]] || return 1
  [[ -n "$record" && "${#record}" -le 16384 ]] || return 1
  [[ "$record" != *$'\n'* && "$record" != *$'\r'* ]] || return 1
  local lower_record
  lower_record="$(printf '%s' "$record" | e2e_ascii_lower)" || return 1
  for forbidden in "flow_v1." "asimp_ag_" "#v1." "https://" "http://" "/users/" '"device_code"' '"user_code"' '"flow_handle"' '"token"' '"cookie"' '"email"' '"authorization"' "bearer " "cookie:" "set-cookie:"; do
    [[ "$lower_record" != *"$forbidden"* ]] || return 1
  done

  physical_artifact_directory="$(e2e_artifact_directory_at_root "$repository_root" "$run_id")" || return 1
  artifact_path="$physical_artifact_directory/$file_name"
  [[ ! -L "$artifact_path" ]] || return 1
  if [[ -e "$artifact_path" && ! -f "$artifact_path" ]]; then
    return 1
  fi
  [[ "$(e2e_artifact_directory_at_root "$repository_root" "$run_id" 2>/dev/null || true)" \
    == "$physical_artifact_directory" ]] || return 1
  printf '%s\n' "$record" >> "$artifact_path" 2>/dev/null || return 1
  printf 'e2e/artifacts/%s/%s\n' "$run_id" "$file_name"
}

e2e_write_artifact_diagnostic() {
  local repository_root

  repository_root="$(e2e_physical_directory "$(dirname "${BASH_SOURCE[0]}")/../..")" || return 1
  e2e_write_artifact_diagnostic_at_root "$repository_root" "$@"
}

e2e_emit_and_optionally_record_at_root() {
  local repository_root="$1"
  local write_artifacts="$2"
  local run_id="$3"
  local suite="$4"
  local started_ms="$5"
  local status="$6"
  local code="$7"
  local reproduce="$8"
  local artifact_write_failed=0

  if [[ "$write_artifacts" == "1" ]]; then
    e2e_write_artifact_diagnostic_at_root "$repository_root" "$run_id" "$suite" "$started_ms" "$status" "$code" "$reproduce" >/dev/null || artifact_write_failed=1
  fi

  e2e_emit_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce"

  if [[ "$artifact_write_failed" -eq 1 ]]; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "ARTIFACT_DIAGNOSTIC_WRITE_FAILED" "$reproduce"
    [[ "$status" == "fail" ]] || return 1
  fi
}

e2e_emit_and_optionally_record() {
  local repository_root

  repository_root="$(e2e_physical_directory "$(dirname "${BASH_SOURCE[0]}")/../..")" || {
    e2e_emit_diagnostic "$3" "$4" "$5" "$6" "$7"
    if [[ "$1" == "1" ]]; then
      e2e_emit_diagnostic "$3" "$4" "fail" "ARTIFACT_DIAGNOSTIC_WRITE_FAILED" "$7"
      [[ "$5" == "fail" ]] || return 1
    fi
    return 0
  }

  e2e_emit_and_optionally_record_at_root "$repository_root" "$@"
}

e2e_probe_public_path() {
  local origin="$1"
  local path="$2"
  local probe_result
  local http_status
  local redirect_url
  local redirected_status
  local curl_status
  local requested_url
  local slash_variant

  requested_url="$origin$path"
  if [[ "$path" == "/" ]]; then
    slash_variant=""
  elif [[ "$path" == */ ]]; then
    slash_variant="${requested_url%/}"
  else
    slash_variant="$requested_url/"
  fi

  probe_result="$(e2e_curl --silent --max-time 15 --connect-timeout 5 --output /dev/null --write-out $'%{http_code}\t%{redirect_url}' "$origin$path" 2>/dev/null)"
  curl_status=$?
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$probe_result" == *$'\t'* && "$probe_result" != *$'\n'* && "$probe_result" != *$'\r'* ]] || return 1
  http_status="${probe_result%%$'\t'*}"
  redirect_url="${probe_result#*$'\t'}"
  [[ "$redirect_url" != *$'\t'* ]] || return 1
  if [[ "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    [[ -z "$redirect_url" ]]
    return
  fi
  case "$http_status" in
    301 | 302 | 307 | 308) ;;
    *) return 1 ;;
  esac
  [[ -n "$redirect_url" && "$redirect_url" != *[[:space:]]* && "$redirect_url" != *"#"* ]] || return 1
  [[ -n "$slash_variant" && "$redirect_url" == "$slash_variant" ]] || return 1

  # One explicit path-preserving same-origin hop satisfies the agent-surface
  # canonicalization contract. It cannot borrow a green preflight from a login
  # page, production, or another host; a second redirect remains a refusal.
  redirected_status="$(e2e_curl --silent --max-time 15 --connect-timeout 5 --output /dev/null --write-out '%{http_code}' "$redirect_url" 2>/dev/null)"
  curl_status=$?
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$redirected_status" =~ ^2[0-9][0-9]$ ]]
}

e2e_run_harness_self_test() {
  local suite="$1"
  local started_ms="$2"
  local reproduce="$3"
  local artifact_path
  local invalid_run_id
  local diagnostic

  artifact_path="$(e2e_artifact_relpath "ops.1-selftest")" || return 1
  [[ "$artifact_path" == "e2e/artifacts/ops.1-selftest" ]] || return 1

  for invalid_run_id in "../escape" "bad/path" "-starts-with-dash" "has space" ""; do
    if e2e_artifact_relpath "$invalid_run_id" >/dev/null; then
      return 1
    fi
  done

  diagnostic="$(e2e_format_diagnostic "$suite" "$started_ms" "pass" "HARNESS_SELF_TEST_OK" "$reproduce")"
  [[ "$diagnostic" == *'"tool":"bash"'* ]] || return 1
  [[ "$diagnostic" == *'"package":"e2e"'* ]] || return 1
  [[ "$diagnostic" == *'"suite":"'* ]] || return 1
  [[ "$diagnostic" == *'"duration_ms":'* ]] || return 1
  [[ "$diagnostic" != *"/Users/"* ]] || return 1
  [[ "$diagnostic" != *"asimp_ag_"* ]] || return 1
  [[ "$diagnostic" != *"#v1."* ]] || return 1

  e2e_emit_diagnostic "$suite" "$started_ms" "pass" "HARNESS_SELF_TEST_OK" "$reproduce"
}
