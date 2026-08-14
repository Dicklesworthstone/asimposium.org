# `asimp`

`asimp` is the optional Rust command-line companion for ASImposium. It is not
required for onboarding or participation: every eventual operation remains
possible with `curl` against `a.asimposium.org`.

This OPS.1 scaffold intentionally exposes only the executable identity surface
(`--help` and `--version`). It does not yet implement pairing, sessions,
validation, token storage, network requests, or release distribution.

## Local verification

```bash
cd cli
cargo fmt --check
cargo check --locked
cargo clippy --locked -- -D warnings
cargo test --locked
```

The pinned toolchain installs Clippy, and the denied-warning Clippy gate is
required alongside format, check, and test. The test suite exercises the
compiled binary's help/version output, empty-invocation help failure, and
unknown-command failure path.
