use asimp::{Cli, CliOutput, run_cli_with_fetch};
use clap::Parser;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const CLOSE: &str = "sessions.v1/session_close_request";
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn input_file(bytes: &[u8]) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "asimp-validation-private-path-canary-{}-{timestamp}-{sequence}.json",
        std::process::id()
    ));
    // Retain test evidence; repository policy does not permit file deletion.
    let mut file = std::fs::File::create_new(&path).unwrap();
    file.write_all(bytes).unwrap();
    path
}

fn validate(path: &Path, selector: &str) -> CliOutput {
    let cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "http://private-origin-canary.invalid",
        "validate",
        path.to_str().unwrap(),
        "--schema",
        selector,
        "--json",
    ])
    .unwrap();
    run_cli_with_fetch(&cli, |_| {
        panic!("offline validation attempted an HTTP request")
    })
}

fn parsed(output: &CliOutput) -> Value {
    assert!(output.stderr.is_empty());
    serde_json::from_str(&output.stdout).unwrap()
}

#[test]
fn valid_request_and_opt_in_handoff_accept_all_exact_published_selector_forms() {
    let file = input_file(
        br#"{"handback":"Resume from this source.","shared_handoff":{"synthesis_id":"SYNTH-HANDOFF1","event_id":"E-handoff1"}}"#,
    );
    for selector in [
        CLOSE,
        "/schemas/sessions.v1/session_close_request.json",
        "https://a.asimposium.org/schemas/sessions.v1/session_close_request.json",
    ] {
        let output = validate(&file, selector);
        assert_eq!(output.exit_code, 0, "{}", output.stdout);
        let report = parsed(&output);
        assert_eq!(report["format"], "asimp.validation.v1");
        assert_eq!(report["validation"], "structural");
        assert_eq!(report["structural_valid"], true);
        assert_eq!(report["diagnostics"], json!([]));
        assert_eq!(report["diagnostics_truncated"], false);
        assert_eq!(
            report["schema"],
            "https://a.asimposium.org/schemas/sessions.v1/session_close_request.json"
        );
        assert!(
            report["boundary"]
                .as_str()
                .unwrap()
                .contains("authorization")
        );
        assert!(!output.stdout.contains("private-path-canary"));
    }
}

#[test]
fn schema_constraints_fail_without_printing_values_or_unknown_property_names() {
    for input in [
        json!({}),
        json!({ "handback": 7 }),
        json!({ "handback": "" }),
        json!({ "handback": "private-value-canary", "private-key-canary": "private-value-canary" }),
        json!({ "handback": "Resume.", "shared_handoff": { "synthesis_id": "private-value-canary" } }),
        json!({ "handback": "Resume.", "keep": ["private-value-canary"] }),
    ] {
        let file = input_file(input.to_string().as_bytes());
        let output = validate(&file, CLOSE);
        assert_eq!(output.exit_code, 1, "{}", output.stdout);
        let report = parsed(&output);
        assert_eq!(report["structural_valid"], false);
        let diagnostics = report["diagnostics"].as_array().unwrap();
        assert!(!diagnostics.is_empty());
        assert!(
            diagnostics
                .iter()
                .all(|item| item["schema_path"].as_str().unwrap().starts_with('#'))
        );
        assert!(!output.stdout.contains("canary"));
        assert!(!output.stdout.contains("instance_path"));
    }
}

#[test]
fn unknown_selectors_are_refused_before_reading_a_file_and_are_never_reflected() {
    let missing = Path::new("/unavailable/private-path-canary.json");
    for selector in [
        "private-selector-canary",
        "sessions.v1/private-selector-canary",
        "batch.v1",
        "directives.v1/request",
        "https://private-selector-canary.invalid/schemas/sessions.v1/session_close_request.json",
        "https://a.asimposium.org/schemas/sessions.v1/session_close_request.json?private-selector-canary",
        "/schemas/sessions.v1/session_close_request.json#private-selector-canary",
        "/schemas/sessions.v1/../private-selector-canary.json",
        "/schemas/sessions.v1/%2e%2e/private-selector-canary.json",
        "file:///private-selector-canary.json",
    ] {
        let output = validate(missing, selector);
        assert_eq!(output.exit_code, 2);
        let report = parsed(&output);
        assert_eq!(report["schema"], Value::Null);
        assert_eq!(report["structural_valid"], Value::Null);
        assert_eq!(report["diagnostics"][0]["code"], "unknown_schema");
        assert!(!output.stdout.contains("canary"));
    }
}

#[test]
fn malformed_json_and_unreadable_oversized_or_non_utf8_files_have_safe_errors() {
    for bytes in [
        b"{\"private-key-canary\": \"private-value-canary\"".as_slice(),
        b"{} {}".as_slice(),
        b"".as_slice(),
    ] {
        let output = validate(&input_file(bytes), CLOSE);
        assert_eq!(output.exit_code, 2);
        assert_eq!(parsed(&output)["diagnostics"][0]["code"], "malformed_json");
        assert!(!output.stdout.contains("canary"));
    }
    for path in [
        PathBuf::from("/unavailable/private-path-canary.json"),
        std::env::temp_dir(),
        input_file(&[0xff, 0xfe]),
        input_file(&b" ".repeat(512 * 1024 + 1)),
    ] {
        let output = validate(&path, CLOSE);
        assert_eq!(output.exit_code, 2);
        assert_eq!(parsed(&output)["diagnostics"][0]["code"], "input_file");
        assert!(!output.stdout.contains("canary"));
    }
}

#[test]
fn large_invalid_arrays_keep_diagnostics_bounded_and_mark_omissions() {
    let file = input_file(
        json!({ "handback": "Resume.", "keep": vec!["private-value-canary"; 64] })
            .to_string()
            .as_bytes(),
    );
    let output = validate(&file, CLOSE);
    assert_eq!(output.exit_code, 1);
    let report = parsed(&output);
    assert_eq!(report["diagnostics"].as_array().unwrap().len(), 20);
    assert_eq!(report["diagnostics_truncated"], true);
    assert!(!output.stdout.contains("canary"));
}

#[test]
fn catalog_explicitly_lists_the_bundled_subset_without_network_or_file_access() {
    let cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "private-origin-canary",
        "validate",
        "--list-schemas",
        "--json",
    ])
    .unwrap();
    let output = run_cli_with_fetch(&cli, |_| panic!("catalog attempted an HTTP request"));
    assert_eq!(output.exit_code, 0);
    let report = parsed(&output);
    assert_eq!(report["format"], "asimp.schema_catalog.v1");
    let entries = report["schemas"].as_array().unwrap();
    for selector in [
        "sessions.v1",
        CLOSE,
        "sessions.v1/session_open_request",
        "sessions.v1/workshop_push_request",
        "enrollment.v1/mint_request",
        "problems.v1",
        "inbox.v1/ack_request",
        "ledger.v1/problem_index_entry",
        "moves.v1",
        "problem.v1",
    ] {
        assert!(
            entries.iter().any(|entry| entry["selector"] == selector),
            "missing {selector}"
        );
    }
    assert!(entries.iter().all(|entry| {
        entry["schema"]
            .as_str()
            .unwrap()
            .starts_with("https://a.asimposium.org/schemas/")
    }));
    assert!(!output.stdout.contains("batch.v1"));
    assert!(!output.stdout.contains("directives.v1"));
    let unsupported = report["unsupported_schemas"].as_array().unwrap();
    assert_eq!(unsupported.len(), 5);
    for selector in [
        "enrollment.v1",
        "enrollment.v1/operator_fellow_cap_audit_page_response",
        "enrollment.v1/operator_fellow_cap_override_request",
        "ledger.v1",
        "ledger.v1/problem_face_response",
    ] {
        assert!(!entries.iter().any(|entry| entry["selector"] == selector));
        assert!(
            unsupported.iter().any(
                |entry| entry["selector"] == selector && entry["code"] == "unsupported_pattern"
            )
        );
    }
}

#[test]
fn unsupported_published_patterns_never_become_a_payload_verdict() {
    let missing = Path::new("/unavailable/private-path-canary.json");
    for selector in [
        "enrollment.v1",
        "enrollment.v1/operator_fellow_cap_override_request",
        "https://a.asimposium.org/schemas/ledger.v1/problem_face_response.json",
    ] {
        let output = validate(missing, selector);
        assert_eq!(output.exit_code, 2);
        let report = parsed(&output);
        assert_eq!(report["structural_valid"], Value::Null);
        assert_eq!(report["diagnostics"][0]["code"], "unsupported_schema");
        assert!(
            report["schema"]
                .as_str()
                .unwrap()
                .starts_with("https://a.asimposium.org/schemas/")
        );
        assert!(!output.stdout.contains("canary"));
    }
}

#[test]
fn command_line_requires_file_and_schema_or_a_standalone_catalog_request() {
    for args in [
        vec!["asimp", "validate"],
        vec!["asimp", "validate", "request.json"],
        vec!["asimp", "validate", "--schema", CLOSE],
        vec!["asimp", "validate", "request.json", "--list-schemas"],
        vec!["asimp", "validate", "--schema", CLOSE, "--list-schemas"],
    ] {
        assert!(Cli::try_parse_from(args).is_err());
    }
}

#[test]
fn production_entrypoint_preserves_json_and_exit_codes_without_credentials_or_origin() {
    let valid = input_file(br#"{"handback":"Resume."}"#);
    let invalid = input_file(br#"{"handback":false}"#);
    let malformed = input_file(b"private-json-canary");
    for (file, expected) in [(&valid, 0), (&invalid, 1), (&malformed, 2)] {
        let output = Command::new(env!("CARGO_BIN_EXE_asimp"))
            .args([
                "validate",
                file.to_str().unwrap(),
                "--schema",
                CLOSE,
                "--json",
            ])
            .env("ASIMP_ORIGIN", "http://private-origin-canary.invalid")
            .env("ASIMP_TOKEN", "private-token-canary\r\nx:bad")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(expected));
        assert!(output.stderr.is_empty());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["validation"], "structural");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("canary"));
    }
}

#[test]
fn human_help_and_result_explain_the_structural_boundary() {
    let help = Command::new(env!("CARGO_BIN_EXE_asimp"))
        .args(["validate", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    for expected in [
        "offline",
        "structural",
        "--schema",
        "--list-schemas",
        "--json",
        "512 KiB",
    ] {
        assert!(text.contains(expected), "missing help: {expected}");
    }
    let file = input_file(br#"{"handback":"Resume."}"#);
    let cli = Cli::try_parse_from([
        "asimp",
        "validate",
        file.to_str().unwrap(),
        "--schema",
        CLOSE,
    ])
    .unwrap();
    let output = run_cli_with_fetch(&cli, |_| panic!("offline validation attempted HTTP"));
    assert_eq!(output.exit_code, 0);
    assert!(output.stdout.contains("Structural validation passed."));
    assert!(
        output
            .stdout
            .contains("scientific validity remain separate")
    );
    assert!(!output.stdout.contains("canary"));
}
