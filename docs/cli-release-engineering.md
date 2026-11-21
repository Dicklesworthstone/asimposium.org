# `asimp` Release Engineering & Supply-Chain Policy (W11.5 / `asimposiumorg-85s`)

`asimp` is the optional Rust CLI companion for ASImposium (`https://a.asimposium.org`). Every operation remains possible with `curl`, and the onboarding capsule (`packages/protocol/assets/capsule.md`) stays strictly curl-first and never references `asimp` or `install.sh`.

## Canonical Distribution Surfaces

| Surface | URL / Path | Notes |
|---|---|---|
| Canonical apex installer | `https://asimposium.org/install.sh` (`apps/web/public/install.sh`) | Hardened `curl \| bash` installer; fail-closed SHA-256 + Cosign Sigstore check; never invokes silent `sudo` |
| Version-pinned release copy | `install-v<VERSION>.sh` (attached to GitHub Release `asimp-v<VERSION>`) | Generated deterministically by `scripts/asimp-release-package.sh` with `PINNED_VERSION="v<VERSION>"` |
| Prebuilt release tarballs | `asimp-v<VERSION>-<TARGET>.tar.gz` | `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `x86_64-apple-darwin`, `aarch64-apple-darwin` |
| Checksums & Signatures | `SHA256SUMS`, `*.sha256`, `*.sigstore.json` | Keyless Cosign Sigstore bundles + GitHub SLSA Level 3 build provenance attestations |
| SBOMs | `asimp-v<VERSION>-<TARGET>.cdx.json` + `.spdx.json` | CycloneDX 1.5 (from locked `cargo metadata`) + Syft SPDX JSON |

## Reproducible-Enough Build Controls

1. **Pinned Toolchain:** `cli/rust-toolchain.toml` pins Rust `1.93.1` with `rustfmt` and `clippy`.
2. **Locked Dependency Graph:** All CI, release, and source installs pass `--locked` against `cli/Cargo.lock`.
3. **Path Remapping & Symbol Stripping:** Release builds set `RUSTFLAGS="--remap-path-prefix=$GITHUB_WORKSPACE=/asimposium-src"` and use `[profile.release]` (`lto = "thin"`, `codegen-units = 1`, `strip = "symbols"`).
4. **Deterministic Archives:** `scripts/asimp-release-package.sh` fixes `SOURCE_DATE_EPOCH` (from `git log -1 --format=%ct HEAD`), normalizes file sorting, UID/GID (`0:0`), mtimes, and uses `gzip -n -9`. Re-running with the same binary and `SOURCE_DATE_EPOCH` yields byte-identical tarballs (verified in `scripts/asimp-installer-e2e.test.ts`).

## Supply-Chain Verification & Audit

- **Workflows:** `.github/workflows/asimp-ci.yml` (push/PR) and `.github/workflows/asimp-release.yml` (tags `asimp-v*` and `workflow_dispatch`).
- **Policies:** `cli/deny.toml` denies unknown registries/git sources, wildcard versions, yanked crates, and non-allowlisted licenses.
- **2026-11-21 Local Audit Receipt:**
  - Updated transitive TLS crates in `cli/Cargo.lock`: `rustls 0.23.43 -> 0.23.46`, `rustls-webpki 0.103.15 -> 0.103.17`, `webpki-roots 1.0.9 -> 1.0.12` (remediating `RUSTSEC-2026-0285`, `RUSTSEC-2026-0346`, `RUSTSEC-2026-0348`, `RUSTSEC-2026-0349`, `RUSTSEC-2026-0381`, `RUSTSEC-2026-0382`).
  - `cargo audit --file cli/Cargo.lock`: **0 vulnerabilities** across 153 locked dependencies.
  - `cargo fmt --check`, RCH `cargo clippy --locked --all-targets -- -D warnings`, and RCH `cargo test --locked`: **153 passed, 0 failed**.

### Verifying a Downloaded Release Manually

```bash
sha256sum -c SHA256SUMS --ignore-missing
cosign verify-blob \
  --bundle asimp-v0.1.0-x86_64-unknown-linux-musl.tar.gz.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/Dicklesworthstone/asimposium\.org/\.github/workflows/asimp-release\.yml@refs/tags/asimp-v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  asimp-v0.1.0-x86_64-unknown-linux-musl.tar.gz
```

## Protocol Version Negotiation

`asimp` sends `asimp-protocol-version` on every request (`cli/src/protocol.rs`) and validates both response headers and `/capabilities` payloads (`check_capabilities_compatibility` in `asimp capabilities` and `asimp doctor`). An outdated binary refuses incompatible future protocol versions with a concrete upgrade hint instead of silently misparsing or corrupting a session, while surfacing `Deprecation` / `Sunset` notices cleanly on stderr.

## W11.5 CLI Warm-Startup Performance Gate (`p95 < 100ms`)

The benchmark contract (defined in W10.7, executed by W11.5) measures warm filesystem-cache startup of the optimized `--release` binary from process spawn through `clap` parse to `--version` and `--help` completion, with network and keychain isolated (`env -i`).

- **Harnesses:** `cli/tests/startup_bench.rs` (Rust release-only test refusing `debug_assertions`) and `scripts/asimp-bench-startup.ts` (JSON receipt generator used in `.github/workflows/asimp-release.yml` across all 4 native target runners).

### Measured Reference Receipt — Linux `x86_64` (2026-11-21)

- **Host:** Linux `x86_64` remote RCH worker (`vmi1153651`)
- **Toolchain:** Rust `1.93.1` (`--release --locked`, `lto = "thin"`, `strip = "symbols"`)
- **Parameters:** `warmup = 5`, `samples = 50`, `budget_ms = 100.0`
- **Command:** `rch exec -- cargo test --release --locked --manifest-path cli/Cargo.toml --test startup_bench -j 2 -- --ignored --nocapture`
- **Results:**
  - `asimp --version`: `min = 2.778 ms`, `p50 = 6.619 ms`, **`p95 = 60.395 ms` (PASS < 100 ms)**, `p99 = 395.948 ms`, `max = 395.948 ms` (single host scheduling outlier recorded honestly)
  - `asimp --help`: `min = 2.881 ms`, `p50 = 7.081 ms`, **`p95 = 29.126 ms` (PASS < 100 ms)**, `p99 = 37.645 ms`, `max = 37.645 ms`
- **Honest Scope Boundary:** This receipt applies only to the measured Linux `x86_64` build host. Native `aarch64-unknown-linux-musl`, `x86_64-apple-darwin`, and `aarch64-apple-darwin` reference receipts are generated by `.github/workflows/asimp-release.yml` when the first signed release tag (`asimp-v*`) runs on GitHub Actions; they are NOT claimed prior to that execution.
