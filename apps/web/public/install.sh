#!/usr/bin/env bash
#
# asimp installer — optional Rust CLI companion for ASImposium (https://asimposium.org)
# Curl remains sufficient for all ASImposium operations; this CLI is strictly optional.
#
# Canonical one-liner install (with cache buster):
#   curl -fsSL "https://asimposium.org/install.sh?$(date +%s)" | bash
#
# Or without cache buster:
#   curl -fsSL https://asimposium.org/install.sh | bash
#
# Options:
#   --version vX.Y.Z           Install a specific release version (default: pinned or latest)
#   --dest DIR                 Install directory (default: ~/.local/bin)
#   --system                   Target /usr/local/bin (refuses unless writable; never runs sudo silently)
#   --easy-mode                Append --dest to ~/.bashrc / ~/.zshrc if missing from PATH
#   --verify                   Run `asimp --version` post-install check (enabled by default)
#   --from-source              Build from local source checkout with cargo --locked --release
#   --offline TARBALL          Install airgapped from a local release tarball
#   --checksum-file FILE       SHA256SUMS or .sha256 file (for --offline or custom mirrors)
#   --release-base-url URL     Override GitHub Releases base URL (HTTPS, or loopback HTTP for local tests)
#   --require-sigstore         Fail closed if cosign or Sigstore bundle is unavailable
#   --insecure-skip-verify     Skip SHA-256 and Sigstore verification (not recommended)
#   --force                    Reinstall even if the requested version is already installed
#   --quiet                    Suppress non-error output
#   --no-gum                   Disable gum formatting and use plain ANSI output
#   --help, -h                 Show usage and exit
#

set -euo pipefail
shopt -s lastpipe 2>/dev/null || true
umask 022

readonly REPO_OWNER="Dicklesworthstone"
readonly REPO_NAME="asimposium.org"
readonly BINARY_NAME="asimp"
readonly CANONICAL_INSTALLER_URL="https://asimposium.org/install.sh"
readonly DEFAULT_RELEASE_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"
readonly DEFAULT_COSIGN_IDENTITY_RE="^https://github\\.com/${REPO_OWNER}/${REPO_NAME}/\\.github/workflows/asimp-release\\.yml@refs/tags/asimp-v.*$"
readonly DEFAULT_COSIGN_OIDC_ISSUER="https://token.actions.githubusercontent.com"

# Populated automatically in version-pinned release copies (install-vX.Y.Z.sh).
PINNED_VERSION=""

VERSION="${ASIMP_VERSION:-}"
if [[ -n "${ASIMP_INSTALL_DEST:-}" ]]; then
  DEST="$ASIMP_INSTALL_DEST"
elif [[ -n "${HOME:-}" ]]; then
  DEST="${HOME%/}/.local/bin"
else
  DEST=""
fi
RELEASE_BASE="${ASIMP_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE}"
COSIGN_IDENTITY_RE="${ASIMP_COSIGN_IDENTITY_RE:-$DEFAULT_COSIGN_IDENTITY_RE}"
COSIGN_OIDC_ISSUER="${ASIMP_COSIGN_OIDC_ISSUER:-$DEFAULT_COSIGN_OIDC_ISSUER}"
EASY_MODE=0
DO_VERIFY=1
FROM_SOURCE=0
OFFLINE_TARBALL=""
CHECKSUM_FILE=""
REQUIRE_SIGSTORE=0
INSECURE_SKIP_VERIFY=0
FORCE_INSTALL=0
QUIET=0
NO_GUM=0

HAS_GUM=0
if command -v gum >/dev/null 2>&1 && [[ -t 1 ]]; then
  HAS_GUM=1
fi

TMP_DIR=""
LOCK_DIR=""
LOCK_OWNED=0
STAGED_BIN=""
OS=""
ARCH=""
TARGET=""
PROXY_ARGS=()
CHECKSUM_STATUS="not-run"
SIGSTORE_STATUS="skipped"
INSTALL_MODE="release-binary"

usage() {
  cat <<'EOF'
asimp installer — optional Rust CLI companion for ASImposium

Usage:
  curl -fsSL https://asimposium.org/install.sh | bash
  curl -fsSL https://asimposium.org/install.sh | bash -s -- [OPTIONS]

Options:
  --version vX.Y.Z           Install specific release tag/version (e.g. v0.1.0 or 0.1.0)
  --dest DIR                 Install destination directory (default: ~/.local/bin)
  --system                   Install to /usr/local/bin (never invokes silent sudo)
  --easy-mode                Add install directory to ~/.bashrc / ~/.zshrc if not on PATH
  --verify                   Verify installed binary via `asimp --version` (default: on)
  --from-source              Build from local cli/Cargo.toml checkout via cargo --locked --release
  --offline TARBALL          Install airgapped from a local release .tar.gz
  --checksum-file FILE       SHA256SUMS or .sha256 file to verify against
  --release-base-url URL     Override releases base URL (HTTPS or loopback HTTP only)
  --require-sigstore         Require cosign + Sigstore bundle verification (fail closed)
  --insecure-skip-verify     Skip SHA-256 and Sigstore verification (NOT recommended)
  --force                    Reinstall even if the same version is already installed
  --quiet                    Suppress informational output (errors still print)
  --no-gum                   Force plain ANSI output even when gum is installed
  -h, --help                 Print this help message and exit

Note:
  asimp is strictly optional; curl against https://a.asimposium.org remains sufficient.
EOF
}

info() {
  [[ "$QUIET" -eq 1 ]] && return 0
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 ]]; then
    gum style --foreground 39 "-> $*"
  else
    printf '\033[0;34m->\033[0m %s\n' "$*"
  fi
}

ok() {
  [[ "$QUIET" -eq 1 ]] && return 0
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 ]]; then
    gum style --foreground 42 "✓ $*"
  else
    printf '\033[0;32m✓\033[0m %s\n' "$*"
  fi
}

warn() {
  [[ "$QUIET" -eq 1 ]] && return 0
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 ]]; then
    gum style --foreground 214 "! $*" >&2
  else
    printf '\033[1;33m!\033[0m %s\n' "$*" >&2
  fi
}

err() {
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 ]]; then
    gum style --foreground 196 "✗ $*" >&2
  else
    printf '\033[0;31m✗\033[0m %s\n' "$*" >&2
  fi
}

run_with_spinner() {
  local title="$1"
  shift
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 && "$QUIET" -eq 0 ]]; then
    gum spin --spinner dot --title "$title" -- "$@"
  else
    info "$title"
    "$@"
  fi
}

strip_ansi() {
  printf '%s' "$1" | sed -E 's/\x1B\[[0-9;]*[[:alpha:]]//g'
}

draw_box() {
  [[ "$QUIET" -eq 1 ]] && return 0
  local color="$1"
  shift
  local lines=("$@")
  local max_len=0
  local line clean len
  for line in "${lines[@]}"; do
    clean=$(strip_ansi "$line")
    len=${#clean}
    if (( len > max_len )); then
      max_len=$len
    fi
  done
  local border=""
  local i
  for (( i = 0; i < max_len + 2; i++ )); do
    border+="═"
  done
  printf '\033[%sm╔%s╗\033[0m\n' "$color" "$border"
  for line in "${lines[@]}"; do
    clean=$(strip_ansi "$line")
    local pad=$(( max_len - ${#clean} ))
    local spaces=""
    for (( i = 0; i < pad; i++ )); do
      spaces+=" "
    done
    printf '\033[%sm║\033[0m %s%s \033[%sm║\033[0m\n' "$color" "$line" "$spaces" "$color"
  done
  printf '\033[%sm╚%s╝\033[0m\n' "$color" "$border"
}

print_banner() {
  [[ "$QUIET" -eq 1 ]] && return 0
  if [[ "$HAS_GUM" -eq 1 && "$NO_GUM" -eq 0 ]]; then
    gum style \
      --border normal --border-foreground 39 \
      --padding "0 1" --margin "1 0" \
      "$(gum style --foreground 42 --bold 'asimp installer')" \
      "$(gum style --foreground 245 'Optional Rust CLI companion for ASImposium (curl remains sufficient)')"
  else
    draw_box "0;36" \
      "asimp installer" \
      "Optional Rust CLI companion for ASImposium (curl remains sufficient)"
  fi
}

cleanup() {
  if [[ -n "${STAGED_BIN:-}" && -e "$STAGED_BIN" ]]; then
    rm -f "$STAGED_BIN"
  fi
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ "${LOCK_OWNED:-0}" -eq 1 && -n "${LOCK_DIR:-}" && -d "$LOCK_DIR" ]]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        [[ $# -ge 2 ]] || { err "--version requires a value"; exit 2; }
        VERSION="$2"
        shift 2
        ;;
      --dest)
        [[ $# -ge 2 ]] || { err "--dest requires a directory path"; exit 2; }
        DEST="$2"
        shift 2
        ;;
      --system)
        DEST="/usr/local/bin"
        shift
        ;;
      --easy-mode)
        EASY_MODE=1
        shift
        ;;
      --verify)
        DO_VERIFY=1
        shift
        ;;
      --from-source)
        FROM_SOURCE=1
        shift
        ;;
      --offline)
        [[ $# -ge 2 ]] || { err "--offline requires a tarball path"; exit 2; }
        OFFLINE_TARBALL="$2"
        shift 2
        ;;
      --checksum-file)
        [[ $# -ge 2 ]] || { err "--checksum-file requires a file path"; exit 2; }
        CHECKSUM_FILE="$2"
        shift 2
        ;;
      --release-base-url)
        [[ $# -ge 2 ]] || { err "--release-base-url requires a URL"; exit 2; }
        RELEASE_BASE="$2"
        shift 2
        ;;
      --require-sigstore)
        REQUIRE_SIGSTORE=1
        shift
        ;;
      --insecure-skip-verify)
        INSECURE_SKIP_VERIFY=1
        shift
        ;;
      --force)
        FORCE_INSTALL=1
        shift
        ;;
      --quiet)
        QUIET=1
        shift
        ;;
      --no-gum)
        NO_GUM=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "Unknown option: $1"
        usage >&2
        exit 2
        ;;
    esac
  done
}

validate_release_base_url() {
  local base="$1"
  if [[ "$base" == https://* ]]; then
    return 0
  fi
  if [[ "$base" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]]; then
    return 0
  fi
  err "Refusing insecure --release-base-url (must be https:// or loopback http:// for local tests): $base"
  exit 2
}

setup_proxy() {
  PROXY_ARGS=()
  if [[ -n "${HTTPS_PROXY:-}" ]]; then
    PROXY_ARGS=(--proxy "$HTTPS_PROXY")
    info "Using HTTPS proxy from HTTPS_PROXY"
  elif [[ -n "${HTTP_PROXY:-}" ]]; then
    PROXY_ARGS=(--proxy "$HTTP_PROXY")
    info "Using HTTP proxy from HTTP_PROXY"
  fi
}

detect_platform() {
  local raw_os raw_arch
  raw_os="${ASIMP_INSTALL_OS:-$(uname -s)}"
  raw_arch="${ASIMP_INSTALL_ARCH:-$(uname -m)}"

  OS=$(printf '%s' "$raw_os" | tr '[:upper:]' '[:lower:]')
  case "$raw_arch" in
    x86_64|amd64) ARCH="x86_64" ;;
    arm64|aarch64) ARCH="aarch64" ;;
    *) ARCH="$raw_arch" ;;
  esac

  if [[ "$OS" == "linux" ]] && [[ -r /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null; then
    warn "WSL detected; installing static Linux musl binary"
  fi

  case "${OS}-${ARCH}" in
    linux-x86_64)   TARGET="x86_64-unknown-linux-musl" ;;
    linux-aarch64)  TARGET="aarch64-unknown-linux-musl" ;;
    darwin-x86_64)  TARGET="x86_64-apple-darwin" ;;
    darwin-aarch64) TARGET="aarch64-apple-darwin" ;;
    *)
      if [[ "$FROM_SOURCE" -eq 1 ]]; then
        TARGET="source-${OS}-${ARCH}"
        warn "No prebuilt release artifact for ${OS}/${ARCH}; proceeding with --from-source"
      else
        err "Unsupported or ambiguous platform '${raw_os}/${raw_arch}'."
        err "Supported prebuilt targets: linux/x86_64, linux/aarch64, darwin/x86_64, darwin/aarch64."
        err "Use --from-source on a Rust 1.93.1+ checkout, or use curl directly against https://a.asimposium.org."
        exit 2
      fi
      ;;
  esac
}

validate_version_token() {
  local raw="$1"
  local normalized="${raw#asimp-}"
  normalized="${normalized#v}"
  if [[ ! "$normalized" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    err "Refusing malformed version token: '$raw'"
    exit 2
  fi
  printf '%s' "$normalized"
}

resolve_version() {
  if [[ -n "$VERSION" ]]; then
    VERSION=$(validate_version_token "$VERSION")
    return 0
  fi
  if [[ -n "$PINNED_VERSION" ]]; then
    VERSION=$(validate_version_token "$PINNED_VERSION")
    return 0
  fi
  if [[ -n "$OFFLINE_TARBALL" ]]; then
    local base
    base=$(basename "$OFFLINE_TARBALL")
    if [[ "$base" =~ ^asimp-v([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)- ]]; then
      VERSION="${BASH_REMATCH[1]}"
      return 0
    fi
    VERSION="offline"
    return 0
  fi
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    if [[ -f "cli/Cargo.toml" ]]; then
      VERSION=$(awk '
        /^\[package\]/ { in_pkg=1; next }
        /^\[/ { in_pkg=0 }
        in_pkg && /^version[[:space:]]*=/ {
          gsub(/^version[[:space:]]*=[[:space:]]*"/, "")
          gsub(/".*$/, "")
          print; exit
        }
      ' cli/Cargo.toml)
    fi
    VERSION="${VERSION:-source}"
    return 0
  fi

  if [[ "$RELEASE_BASE" == "$DEFAULT_RELEASE_BASE" ]]; then
    local api_ver=""
    api_ver=$(curl -fsSL --connect-timeout 5 "${PROXY_ARGS[@]}" \
      "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" 2>/dev/null \
      | grep -m 1 '"tag_name":' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/' || true)
    if [[ -n "$api_ver" ]]; then
      VERSION=$(validate_version_token "$api_ver")
      return 0
    fi
    local redir_ver=""
    redir_ver=$(curl -fsSL --connect-timeout 5 -o /dev/null -w '%{url_effective}' "${PROXY_ARGS[@]}" \
      "${RELEASE_BASE}/latest" 2>/dev/null \
      | sed -E 's|.*/tag/||' || true)
    if [[ -n "$redir_ver" && "$redir_ver" != "${RELEASE_BASE}/latest" ]]; then
      VERSION=$(validate_version_token "$redir_ver")
      return 0
    fi
  else
    local manifest_ver=""
    manifest_ver=$(curl -fsSL --connect-timeout 5 "${PROXY_ARGS[@]}" \
      "${RELEASE_BASE%/}/latest-version.txt" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ -n "$manifest_ver" ]]; then
      VERSION=$(validate_version_token "$manifest_ver")
      return 0
    fi
  fi

  err "Unable to resolve latest asimp release version."
  err "Pass --version vX.Y.Z explicitly, use --offline TARBALL, or build locally with --from-source."
  exit 1
}

acquire_lock() {
  local lock_parent="${TMPDIR:-/tmp}"
  [[ -d "$lock_parent" && -w "$lock_parent" ]] || lock_parent="${HOME:-/tmp}"
  local candidate_lock="${lock_parent%/}/asimp-install.lock"

  if mkdir "$candidate_lock" 2>/dev/null; then
    LOCK_DIR="$candidate_lock"
    LOCK_OWNED=1
    printf '%s\n' "$$" > "${LOCK_DIR}/pid"
    return 0
  fi

  local existing_pid=""
  if [[ -r "${candidate_lock}/pid" ]]; then
    existing_pid=$(tr -cd '0-9' < "${candidate_lock}/pid" || true)
  fi
  if [[ -n "$existing_pid" ]] && ! kill -0 "$existing_pid" 2>/dev/null; then
    warn "Clearing stale installer lock (dead PID ${existing_pid})"
    rm -rf "$candidate_lock"
    if mkdir "$candidate_lock" 2>/dev/null; then
      LOCK_DIR="$candidate_lock"
      LOCK_OWNED=1
      printf '%s\n' "$$" > "${LOCK_DIR}/pid"
      return 0
    fi
  fi

  err "Another asimp install is currently running (lock: ${candidate_lock}). Wait for it to finish and retry."
  exit 1
}

preflight_checks() {
  if [[ -z "$DEST" ]]; then
    err "Install destination --dest is empty (HOME is unset); pass --dest DIR explicitly."
    exit 2
  fi

  if [[ "$DEST" == "/usr/local/bin" && "$(id -u)" -ne 0 && ! -w "$DEST" ]]; then
    err "Refusing to install into /usr/local/bin without write permission (this installer never runs sudo silently)."
    err "Install to a user directory with --dest \"\${HOME}/.local/bin\" or run explicitly as root."
    exit 1
  fi

  if [[ -e "$DEST" && ! -d "$DEST" ]]; then
    err "Destination path exists and is not a directory: $DEST"
    exit 1
  fi

  if [[ ! -d "$DEST" ]]; then
    if ! mkdir -p "$DEST" 2>/dev/null; then
      err "Cannot create destination directory '$DEST' (this installer never runs sudo silently)."
      exit 1
    fi
  fi

  if [[ ! -w "$DEST" ]]; then
    err "Destination directory '$DEST' is not writable (this installer never runs sudo silently)."
    err "Choose a writable directory with --dest DIR."
    exit 1
  fi

  local probe_file="${DEST}/.asimp-write-probe.$$"
  if ! ( : > "$probe_file" ) 2>/dev/null; then
    err "Write permission probe failed in '$DEST' (never running silent sudo)."
    exit 1
  fi
  rm -f "$probe_file"

  if command -v df >/dev/null 2>&1; then
    local avail_kb=""
    avail_kb=$(df -Pk "$DEST" 2>/dev/null | awk 'NR==2 {print $4}' || true)
    if [[ -n "$avail_kb" && "$avail_kb" =~ ^[0-9]+$ ]] && (( avail_kb < 10240 )); then
      err "Insufficient free disk space in '$DEST' (${avail_kb} KiB available; need at least 10240 KiB)."
      exit 1
    fi
  fi

  if [[ -z "$OFFLINE_TARBALL" && "$FROM_SOURCE" -eq 0 ]]; then
    if ! command -v curl >/dev/null 2>&1; then
      err "curl is required to download release artifacts."
      exit 1
    fi
  fi
  if [[ "$FROM_SOURCE" -eq 0 ]]; then
    if ! command -v tar >/dev/null 2>&1; then
      err "tar is required to extract release archives."
      exit 1
    fi
  fi
}

check_existing_install() {
  local installed_bin="${DEST}/${BINARY_NAME}"
  if [[ ! -x "$installed_bin" ]]; then
    return 1
  fi
  local current_ver=""
  current_ver=$("$installed_bin" --version 2>/dev/null | awk '{print $2}' || true)
  if [[ -n "$current_ver" && "$current_ver" == "$VERSION" && "$FORCE_INSTALL" -eq 0 ]]; then
    ok "asimp ${VERSION} is already installed at ${installed_bin}"
    info "Pass --force to reinstall."
    maybe_add_path
    print_summary "$installed_bin"
    exit 0
  fi
  if [[ -n "$current_ver" ]]; then
    info "Existing asimp ${current_ver} found at ${installed_bin}; upgrading to ${VERSION}"
  fi
  return 1
}

compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 1
  fi
}

extract_expected_sha256() {
  local checksum_doc="$1"
  local artifact_name="$2"
  local match=""
  match=$(awk -v target="$artifact_name" '
    {
      hash = $1
      name = $2
      sub(/^\*/, "", name)
      sub(/^.*\//, "", name)
      if (name == target || (NF == 1 && hash ~ /^[0-9a-fA-F]{64}$/)) {
        print tolower(hash)
        exit
      }
    }
  ' "$checksum_doc")
  printf '%s' "$match"
}

verify_checksum() {
  local archive="$1"
  local checksum_doc="$2"
  local artifact_name="$3"

  if [[ "$INSECURE_SKIP_VERIFY" -eq 1 ]]; then
    warn "Skipping SHA-256 verification because --insecure-skip-verify was explicitly supplied"
    CHECKSUM_STATUS="skipped-insecure"
    return 0
  fi

  if [[ ! -r "$checksum_doc" ]]; then
    err "Checksum file missing or unreadable: $checksum_doc"
    err "Refusing to install an unverified artifact."
    return 1
  fi

  local expected actual
  expected=$(extract_expected_sha256 "$checksum_doc" "$artifact_name")
  if [[ -z "$expected" || ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    err "Could not find a valid SHA-256 digest for '${artifact_name}' in '${checksum_doc}'."
    return 1
  fi

  if ! actual=$(compute_sha256 "$archive"); then
    err "Neither sha256sum nor shasum is available; refusing unverified install."
    return 1
  fi
  actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')

  if [[ "$actual" != "$expected" ]]; then
    err "SHA-256 checksum mismatch for ${artifact_name}!"
    err "  Expected: ${expected}"
    err "  Got:      ${actual}"
    err "Refusing to install or replace ${DEST}/${BINARY_NAME}."
    return 1
  fi

  ok "SHA-256 checksum verified (${actual:0:16}...)"
  CHECKSUM_STATUS="verified"
  return 0
}

verify_sigstore() {
  local archive="$1"
  local bundle_file="$2"

  if [[ "$INSECURE_SKIP_VERIFY" -eq 1 ]]; then
    SIGSTORE_STATUS="skipped-insecure"
    return 0
  fi

  if ! command -v cosign >/dev/null 2>&1; then
    if [[ "$REQUIRE_SIGSTORE" -eq 1 ]]; then
      err "--require-sigstore set, but cosign is not installed."
      return 1
    fi
    info "cosign not installed; relying on verified SHA-256 checksum"
    SIGSTORE_STATUS="cosign-not-installed"
    return 0
  fi

  if [[ ! -s "$bundle_file" ]]; then
    if [[ "$REQUIRE_SIGSTORE" -eq 1 ]]; then
      err "--require-sigstore set, but Sigstore bundle is missing."
      return 1
    fi
    warn "Sigstore bundle not found for artifact; relying on verified SHA-256 checksum"
    SIGSTORE_STATUS="bundle-absent"
    return 0
  fi

  if cosign verify-blob \
      --bundle "$bundle_file" \
      --certificate-identity-regexp "$COSIGN_IDENTITY_RE" \
      --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
      "$archive" >/dev/null 2>&1; then
    ok "Sigstore keyless signature verified"
    SIGSTORE_STATUS="verified"
    return 0
  fi

  err "Sigstore signature verification FAILED for $(basename "$archive")."
  return 1
}

download_resumable() {
  local url="$1"
  local out_file="$2"
  curl -fsSL --connect-timeout 10 --retry 3 --retry-delay 1 -C - "${PROXY_ARGS[@]}" "$url" -o "$out_file"
}

validate_tarball_entries() {
  local archive="$1"
  local line entry mode_char
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    mode_char="${line:0:1}"
    if [[ "$mode_char" != "-" && "$mode_char" != "d" ]]; then
      err "Refusing non-regular member (symlink/hardlink/device) in release archive: $line"
      return 1
    fi
  done < <(tar -tvzf "$archive")

  while IFS= read -r entry; do
    if [[ "$entry" == /* || "$entry" =~ (^|/)\.\.(/|$) ]]; then
      err "Refusing unsafe path in release archive: $entry"
      return 1
    fi
  done < <(tar -tzf "$archive")
}

install_staged_binary() {
  local src_bin="$1"
  local final_bin="${DEST}/${BINARY_NAME}"
  local staged_bin="${DEST}/.${BINARY_NAME}.staged.$$"

  if [[ ! -f "$src_bin" || -L "$src_bin" ]]; then
    err "Extracted binary is missing or is a symlink: $src_bin"
    return 1
  fi

  STAGED_BIN="$staged_bin"
  install -m 0755 "$src_bin" "$staged_bin"

  if [[ "$DO_VERIFY" -eq 1 ]]; then
    local out_ver=""
    if ! out_ver=$("$staged_bin" --version 2>&1); then
      rm -f "$staged_bin"
      STAGED_BIN=""
      err "Post-stage verification failed: staged binary did not execute --version cleanly."
      return 1
    fi
    ok "Verified executable: ${out_ver}"
  fi

  mv -f "$staged_bin" "$final_bin"
  STAGED_BIN=""
  ok "Installed ${BINARY_NAME} to ${final_bin}"
}

extract_and_install_archive() {
  local archive="$1"
  local extract_dir="${TMP_DIR}/extract"
  mkdir -p "$extract_dir"

  validate_tarball_entries "$archive"
  tar -xzf "$archive" -C "$extract_dir"

  local candidate=""
  if [[ -f "${extract_dir}/${BINARY_NAME}" ]]; then
    candidate="${extract_dir}/${BINARY_NAME}"
  else
    candidate=$(find "$extract_dir" -maxdepth 3 -type f -name "$BINARY_NAME" | head -n 1 || true)
  fi

  if [[ -z "$candidate" ]]; then
    err "Archive did not contain an '${BINARY_NAME}' executable."
    return 1
  fi

  install_staged_binary "$candidate"
}

install_offline() {
  INSTALL_MODE="offline-tarball"
  local archive="$OFFLINE_TARBALL"
  if [[ ! -f "$archive" || -L "$archive" ]]; then
    err "Offline tarball not found or is a symlink: $archive"
    exit 1
  fi
  local artifact_name
  artifact_name=$(basename "$archive")

  local checksum_doc="$CHECKSUM_FILE"
  if [[ -z "$checksum_doc" ]]; then
    if [[ -f "${archive}.sha256" ]]; then
      checksum_doc="${archive}.sha256"
    elif [[ -f "$(dirname "$archive")/SHA256SUMS" ]]; then
      checksum_doc="$(dirname "$archive")/SHA256SUMS"
    fi
  fi

  verify_checksum "$archive" "$checksum_doc" "$artifact_name"

  local bundle_file="${archive}.sigstore.json"
  verify_sigstore "$archive" "$bundle_file"

  extract_and_install_archive "$archive"
}

install_from_release() {
  INSTALL_MODE="release-binary"
  local tag="asimp-v${VERSION}"
  local artifact_name="asimp-v${VERSION}-${TARGET}.tar.gz"
  local base_dl="${RELEASE_BASE%/}/download/${tag}"
  local archive_path="${TMP_DIR}/${artifact_name}"
  local checksum_path="${TMP_DIR}/SHA256SUMS"
  local bundle_path="${TMP_DIR}/${artifact_name}.sigstore.json"

  info "Downloading ${artifact_name} (target: ${TARGET})"
  if ! download_resumable "${base_dl}/${artifact_name}" "$archive_path"; then
    err "Failed to download ${base_dl}/${artifact_name}"
    err "Check available releases at https://github.com/${REPO_OWNER}/${REPO_NAME}/releases or build with --from-source."
    exit 1
  fi

  if [[ -n "$CHECKSUM_FILE" ]]; then
    checksum_path="$CHECKSUM_FILE"
  else
    if ! curl -fsSL --connect-timeout 10 --retry 3 --retry-delay 1 "${PROXY_ARGS[@]}" \
        "${base_dl}/SHA256SUMS" -o "$checksum_path" 2>/dev/null; then
      if ! curl -fsSL --connect-timeout 10 --retry 3 --retry-delay 1 "${PROXY_ARGS[@]}" \
          "${base_dl}/${artifact_name}.sha256" -o "$checksum_path" 2>/dev/null; then
        if [[ "$INSECURE_SKIP_VERIFY" -eq 0 ]]; then
          err "Failed to download SHA256SUMS or ${artifact_name}.sha256; refusing unverified install."
          exit 1
        fi
      fi
    fi
  fi

  verify_checksum "$archive_path" "$checksum_path" "$artifact_name"

  if [[ "$INSECURE_SKIP_VERIFY" -eq 0 ]] && command -v cosign >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 "${PROXY_ARGS[@]}" \
      "${base_dl}/${artifact_name}.sigstore.json" -o "$bundle_path" 2>/dev/null || true
  fi
  verify_sigstore "$archive_path" "$bundle_path"

  extract_and_install_archive "$archive_path"
}

install_from_source() {
  INSTALL_MODE="source-build"
  if ! command -v cargo >/dev/null 2>&1; then
    err "cargo is required for --from-source."
    exit 1
  fi
  if [[ ! -f "cli/Cargo.toml" ]]; then
    err "--from-source must be run from the repository root containing cli/Cargo.toml."
    exit 1
  fi
  run_with_spinner "Building asimp from source (cargo build --release --locked)" \
    cargo build --release --locked --manifest-path cli/Cargo.toml
  CHECKSUM_STATUS="source-locked"
  SIGSTORE_STATUS="source-locked"
  install_staged_binary "cli/target/release/${BINARY_NAME}"
}

maybe_add_path() {
  case ":${PATH:-}:" in
    *:"${DEST}":*)
      return 0
      ;;
    *)
      if [[ "$EASY_MODE" -eq 1 && -n "${HOME:-}" ]]; then
        local rc updated=0
        for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
          if [[ -e "$rc" && -w "$rc" ]]; then
            if ! grep -Fq "export PATH=\"${DEST}:\$PATH\"" "$rc" 2>/dev/null; then
              # shellcheck disable=SC2016
              printf '\n# Added by asimp installer (%s)\nexport PATH="%s:$PATH"\n' \
                "$CANONICAL_INSTALLER_URL" "$DEST" >> "$rc"
              ok "Added ${DEST} to ${rc}"
              updated=1
            fi
          fi
        done
        if [[ "$updated" -eq 0 ]]; then
          warn "Add ${DEST} to your PATH: export PATH=\"${DEST}:\$PATH\""
        fi
      else
        warn "${DEST} is not currently on PATH. Add it with: export PATH=\"${DEST}:\$PATH\""
      fi
      ;;
  esac
}

print_summary() {
  local installed_bin="$1"
  [[ "$QUIET" -eq 1 ]] && return 0
  draw_box "0;32" \
    "asimp installation complete" \
    "Binary:    ${installed_bin}" \
    "Version:   ${VERSION} (${TARGET})" \
    "Mode:      ${INSTALL_MODE}" \
    "SHA-256:   ${CHECKSUM_STATUS} | Sigstore: ${SIGSTORE_STATUS}" \
    "Quick check: asimp capabilities --json  |  asimp doctor --json" \
    "Uninstall: rm -f \"${installed_bin}\""
}

main() {
  parse_args "$@"
  print_banner
  validate_release_base_url "$RELEASE_BASE"
  setup_proxy
  detect_platform
  resolve_version
  acquire_lock
  preflight_checks

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/asimp-install.XXXXXX")

  if [[ "$FROM_SOURCE" -eq 0 && -z "$OFFLINE_TARBALL" ]]; then
    check_existing_install || true
  fi

  if [[ -n "$OFFLINE_TARBALL" ]]; then
    install_offline
  elif [[ "$FROM_SOURCE" -eq 1 ]]; then
    install_from_source
  else
    install_from_release
  fi

  maybe_add_path
  print_summary "${DEST}/${BINARY_NAME}"
}

main "$@"
