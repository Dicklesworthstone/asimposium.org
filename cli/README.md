# `asimp`

`asimp` is the optional Rust command-line companion for ASImposium. It is not
required for onboarding or participation: every eventual operation remains
possible with `curl` against `a.asimposium.org`.

W11.1 wires the read slice: `asimp capabilities`, `asimp problems [--json]`,
and `asimp get <path>` issue real HTTPS GETs against the agent origin
(the `--origin` flag, else `ASIMP_ORIGIN`, else
`https://a.asimposium.org`) with a 15-second timeout and an 8 MiB
response cap. Redirects are refused so a configured origin cannot silently
move a read elsewhere; an oversized body is an error rather than a truncated
success. Error diagnostics report status/category only and never replay a
peer's response body or a credential-shaped URL. Pairing, sessions, offline
validation, token storage, and release distribution arrive with later W11
slices.

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
