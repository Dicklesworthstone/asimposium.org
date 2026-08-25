#!/usr/bin/env bash
# Shared, secret-safe diagnostics for executable E2E entry points.
# This file is sourced by the runners; it intentionally never prints input
# values, origins, credentials, artifact roots, or local absolute paths.

ASIMPOSIUM_E2E_HARNESS_VERSION="0.1.0"
ASIMPOSIUM_E2E_HTTP_USER_AGENT="OpenAI File Downloader, XaiImageApiFetch/1.0"
readonly ASIMPOSIUM_E2E_HTTP_USER_AGENT
ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES=1048576
readonly ASIMPOSIUM_E2E_MAX_RESPONSE_BYTES

# Successful artifact namespace claims are process capabilities. Bash arrays
# survive the command-substitution subshells used by the writer helpers, but
# they are not exported to an independently started shell. Binding the claim to
# the directory's device/inode rejects a replacement observed before a helper
# publishes. This is not an atomic maintenance lease: pathname replacement can
# still race the final append, so whole-root rotation remains forbidden.
# Top-level declarations are global without Bash 4's non-portable `declare -g`.
declare -a ASIMPOSIUM_E2E_CLAIM_ROOTS=()
declare -a ASIMPOSIUM_E2E_CLAIM_RUN_IDS=()
declare -a ASIMPOSIUM_E2E_CLAIM_IDENTITIES=()

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
    printf '%s\n' "$candidate"
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

e2e_format_diagnostic() {
  local suite="$1"
  local started_ms="$2"
  local status="$3"
  local code="$4"
  local reproduce="$5"
  local duration_ms

  duration_ms="$(e2e_elapsed_ms "$started_ms")"
  printf '{"tool":"bash","tool_version":"%s","package":"e2e","suite":"%s","version":"%s","duration_ms":%s,"status":"%s","code":"%s","reproduce":"%s"}\n' \
    "${BASH_VERSION%% *}" \
    "$suite" \
    "$ASIMPOSIUM_E2E_HARNESS_VERSION" \
    "$duration_ms" \
    "$status" \
    "$code" \
    "$reproduce"
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

e2e_artifact_claim_matches() {
  local physical_artifacts_root="$1"
  local run_id="$2"
  local identity="$3"
  local index

  for ((index = 0; index < ${#ASIMPOSIUM_E2E_CLAIM_RUN_IDS[@]}; index++)); do
    if [[ "${ASIMPOSIUM_E2E_CLAIM_ROOTS[$index]}" == "$physical_artifacts_root" \
      && "${ASIMPOSIUM_E2E_CLAIM_RUN_IDS[$index]}" == "$run_id" \
      && "${ASIMPOSIUM_E2E_CLAIM_IDENTITIES[$index]}" == "$identity" ]]; then
      return 0
    fi
  done
  return 1
}

e2e_artifact_directory_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local physical_artifacts_root
  local artifact_directory
  local physical_artifact_directory
  local artifact_identity

  e2e_validate_run_id "$run_id" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root")" || return 1

  artifact_directory="$physical_artifacts_root/$run_id"
  # Publication may only use a namespace that the entry point atomically
  # claimed before it began product work. Lazily creating or adopting a missing
  # directory here lets two same-run writers blend evidence and lets a writer
  # cross an artifact-root maintenance boundary between work and publication.
  [[ -d "$artifact_directory" && ! -L "$artifact_directory" ]] || return 1
  physical_artifact_directory="$(e2e_physical_directory "$artifact_directory")" || return 1
  [[ "$physical_artifact_directory" == "$physical_artifacts_root/$run_id" ]] || return 1
  artifact_identity="$(e2e_artifact_directory_identity "$physical_artifact_directory")" || return 1
  e2e_artifact_claim_matches "$physical_artifacts_root" "$run_id" "$artifact_identity" || return 1
  printf '%s\n' "$physical_artifact_directory"
}

e2e_claim_artifact_run_at_root() {
  local repository_root="$1"
  local run_id="$2"
  local physical_artifacts_root
  local artifact_directory
  local physical_artifact_directory
  local artifact_identity

  e2e_validate_run_id "$run_id" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$repository_root" 1)" || return 1
  artifact_directory="$physical_artifacts_root/$run_id"
  [[ ! -e "$artifact_directory" && ! -L "$artifact_directory" ]] || return 1
  mkdir "$artifact_directory" 2>/dev/null || return 1
  physical_artifact_directory="$(e2e_physical_directory "$artifact_directory")" || return 1
  [[ "$physical_artifact_directory" == "$physical_artifacts_root/$run_id" ]] || return 1
  artifact_identity="$(e2e_artifact_directory_identity "$physical_artifact_directory")" || return 1
  ASIMPOSIUM_E2E_CLAIM_ROOTS+=("$physical_artifacts_root")
  ASIMPOSIUM_E2E_CLAIM_RUN_IDS+=("$run_id")
  ASIMPOSIUM_E2E_CLAIM_IDENTITIES+=("$artifact_identity")
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
  for forbidden in "flow_v1." "asimp_ag_" "#v1." "https://" "/Users/" '"device_code"' '"user_code"' '"flow_handle"' '"token"' '"cookie"' '"email"'; do
    [[ "$record" != *"$forbidden"* ]] || return 1
  done

  physical_artifact_directory="$(e2e_artifact_directory_at_root "$repository_root" "$run_id")" || return 1
  artifact_path="$physical_artifact_directory/$file_name"
  [[ ! -L "$artifact_path" ]] || return 1
  if [[ -e "$artifact_path" && ! -f "$artifact_path" ]]; then
    return 1
  fi
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
