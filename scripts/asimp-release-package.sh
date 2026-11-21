#!/usr/bin/env bash
#
# Deterministic release packager for `asimp` (W11.5, asimposiumorg-85s).
#
# Produces:
#   - asimp-v<VERSION>-<TARGET>.tar.gz        (deterministic tar + gzip -n)
#   - asimp-v<VERSION>-<TARGET>.tar.gz.sha256 (per-asset SHA-256)
#   - asimp-v<VERSION>-<TARGET>.cdx.json      (CycloneDX 1.5 SBOM from cargo metadata --locked --offline)
#   - install-v<VERSION>.sh                   (version-pinned release copy of apps/web/public/install.sh)
#   - SHA256SUMS                              (combined checksum manifest)
#
# Usage:
#   bash scripts/asimp-release-package.sh \
#     --binary cli/target/release/asimp \
#     --target x86_64-unknown-linux-musl \
#     --version 0.1.0 \
#     --out-dir /path/to/dist

set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BINARY=""
TARGET=""
VERSION=""
OUT_DIR=""
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/asimp-release-package.sh --binary PATH --target TRIPLE --version X.Y.Z --out-dir DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) [[ $# -ge 2 ]] || { echo "ERROR: --binary requires a value" >&2; exit 2; }; BINARY="$2"; shift 2 ;;
    --target) [[ $# -ge 2 ]] || { echo "ERROR: --target requires a value" >&2; exit 2; }; TARGET="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || { echo "ERROR: --version requires a value" >&2; exit 2; }; VERSION="${2#v}"; shift 2 ;;
    --out-dir) [[ $# -ge 2 ]] || { echo "ERROR: --out-dir requires a value" >&2; exit 2; }; OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$BINARY" || -z "$TARGET" || -z "$VERSION" || -z "$OUT_DIR" ]]; then
  echo "ERROR: --binary, --target, --version, and --out-dir are required." >&2
  usage >&2
  exit 2
fi

if [[ ! -f "$BINARY" || ! -x "$BINARY" ]]; then
  echo "ERROR: release binary missing or not executable: $BINARY" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: invalid version: $VERSION" >&2
  exit 2
fi

if [[ -z "$SOURCE_DATE_EPOCH" ]]; then
  SOURCE_DATE_EPOCH=$(git -C "$REPO_ROOT" log -1 --format=%ct HEAD 2>/dev/null || echo "1735689600")
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

TMP_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/asimp-pkg.XXXXXX")"
trap 'rm -rf "$TMP_STAGE"' EXIT

PKG_DIR="asimp-v${VERSION}-${TARGET}"
mkdir -p "${TMP_STAGE}/${PKG_DIR}"
install -m 0755 "$BINARY" "${TMP_STAGE}/${PKG_DIR}/asimp"
install -m 0644 "${REPO_ROOT}/LICENSE" "${TMP_STAGE}/${PKG_DIR}/LICENSE"
install -m 0644 "${REPO_ROOT}/cli/README.md" "${TMP_STAGE}/${PKG_DIR}/README.md"

TARBALL="${OUT_DIR}/asimp-v${VERSION}-${TARGET}.tar.gz"
if tar --version 2>/dev/null | grep -qi "GNU tar"; then
  tar \
    --sort=name \
    --mtime="@${SOURCE_DATE_EPOCH}" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C "$TMP_STAGE" \
    -cf - "$PKG_DIR" | gzip -n -9 > "$TARBALL"
else
  # BSD tar (macOS): normalize mtimes deterministically before archiving.
  python3 - "$TMP_STAGE" "$SOURCE_DATE_EPOCH" <<'PY'
import os, sys
root, ts = sys.argv[1], int(sys.argv[2])
for dirpath, dirnames, filenames in os.walk(root):
    for name in sorted(filenames):
        os.utime(os.path.join(dirpath, name), (ts, ts))
    for name in sorted(dirnames):
        os.utime(os.path.join(dirpath, name), (ts, ts))
os.utime(root, (ts, ts))
PY
  COPYFILE_DISABLE=1 tar --uid 0 --gid 0 -C "$TMP_STAGE" -cf - "$PKG_DIR" | gzip -n -9 > "$TARBALL"
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

TARBALL_SHA="$(sha256_file "$TARBALL")"
printf '%s  %s\n' "$TARBALL_SHA" "$(basename "$TARBALL")" > "${TARBALL}.sha256"

# Generate version-pinned release copy of apps/web/public/install.sh.
PINNED_INSTALLER="${OUT_DIR}/install-v${VERSION}.sh"
python3 - "${REPO_ROOT}/apps/web/public/install.sh" "$PINNED_INSTALLER" "$VERSION" <<'PY'
import pathlib, sys
src, dst, ver = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
text = src.read_text(encoding="utf-8")
needle = 'PINNED_VERSION=""'
if needle not in text:
    raise SystemExit("ERROR: canonical apps/web/public/install.sh missing PINNED_VERSION placeholder")
pinned = text.replace(needle, f'PINNED_VERSION="v{ver}"', 1)
dst.write_text(pinned, encoding="utf-8")
PY
chmod 0755 "$PINNED_INSTALLER"
bash -n "$PINNED_INSTALLER"

# Generate CycloneDX 1.5 JSON SBOM deterministically from locked Cargo metadata.
SBOM_PATH="${OUT_DIR}/asimp-v${VERSION}-${TARGET}.cdx.json"
python3 - "${REPO_ROOT}/cli/Cargo.toml" "$SBOM_PATH" "$VERSION" "$TARGET" "$TARBALL_SHA" "$SOURCE_DATE_EPOCH" <<'PY'
import datetime, json, subprocess, sys

manifest_path, out_path, version, target, tarball_sha, epoch = sys.argv[1:7]
meta = json.loads(
    subprocess.check_output(
        ["cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", manifest_path],
        text=True,
    )
)
ts = datetime.datetime.fromtimestamp(int(epoch), tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

components = []
for pkg in sorted(meta["packages"], key=lambda p: (p["name"], p["version"])):
    if pkg["name"] == "asimp":
        continue
    comp = {
        "type": "library",
        "name": pkg["name"],
        "version": pkg["version"],
        "purl": f"pkg:cargo/{pkg['name']}@{pkg['version']}",
    }
    if pkg.get("license"):
        comp["licenses"] = [{"expression": pkg["license"]}]
    components.append(comp)

bom = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.5",
    "version": 1,
    "metadata": {
        "timestamp": ts,
        "component": {
            "type": "application",
            "name": "asimp",
            "version": version,
            "purl": f"pkg:cargo/asimp@{version}",
            "hashes": [{"alg": "SHA-256", "content": tarball_sha}],
            "properties": [
                {"name": "asimposium:target", "value": target},
                {"name": "asimposium:source_date_epoch", "value": epoch},
            ],
        },
    },
    "components": components,
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(bom, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

# Rebuild combined SHA256SUMS sorted by filename across all release assets in OUT_DIR.
(
  cd "$OUT_DIR"
  : > SHA256SUMS.tmp
  for f in asimp-v*.tar.gz asimp-v*.cdx.json asimp-v*.spdx.json install-v*.sh; do
    [[ -f "$f" ]] || continue
    printf '%s  %s\n' "$(sha256_file "$f")" "$f" >> SHA256SUMS.tmp
  done
  LC_ALL=C sort -k2,2 SHA256SUMS.tmp > SHA256SUMS
  rm -f SHA256SUMS.tmp
)

printf 'PACKAGED_OK target=%s version=%s tarball=%s sha256=%s sbom=%s installer=%s\n' \
  "$TARGET" "$VERSION" "$TARBALL" "$TARBALL_SHA" "$SBOM_PATH" "$PINNED_INSTALLER"
