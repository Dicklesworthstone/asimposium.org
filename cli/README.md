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
cargo check
cargo test
```

The test suite exercises the compiled binary's help/version output and its
unknown-command failure path.
