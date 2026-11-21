//! Subprocess + golden-corpus parity tests for `asimp validate` and `asimp scrub`
//! (W11.3, asimposiumorg-psl).

use asimp::{
    scrub::{FindingKind, scan_body_for_secrets, scan_field_for_credentials},
    validate::validate_bundled,
};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("cli/ has repo parent")
        .to_path_buf()
}

fn asimp_bin() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_asimp"));
    cmd.env("ASIMP_ORIGIN", "https://example.invalid")
        .env_remove("ASIMP_TOKEN");
    cmd
}

fn read_fixture(rel: &str) -> String {
    let path = repo_root()
        .join("packages/contracts/test/fixtures")
        .join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn golden_valid_and_invalid_request_fixtures_match_contract_verdicts() {
    let valid_cases: &[(&str, &str)] = &[
        ("promote", "valid/promote-request.json"),
        ("promote", "valid/promote-workshop-version.json"),
        (
            "sessions/promote_response",
            "valid/promote-review-feedback.json",
        ),
        ("evidence", "valid/evidence-request.json"),
        ("enroll", "valid/enrollment.json"),
        ("device-start", "valid/device-code-start.json"),
        ("batch/plan_request", "valid/batch-commit-plan-request.json"),
        ("batch/plan_result", "valid/batch-commit-plan-response.json"),
        ("batch/event_cause", "valid/batch-event-cause.json"),
        ("contracts-scaffold", "valid/contracts-scaffold.json"),
        (
            "discovery/area_rename_request",
            "valid/admin-area-rename.json",
        ),
        ("discovery/now_query", "valid/discovery-now-query.json"),
        (
            "discovery/honors_query",
            "valid/discovery-honors-query.json",
        ),
        (
            "discovery/fellow_query",
            "valid/discovery-fellow-query.json",
        ),
        (
            "sessions/hypothesis_lifecycle_request",
            "valid/hypothesis-lifecycle-defer.json",
        ),
        (
            "sessions/hypothesis_lifecycle_request",
            "valid/hypothesis-lifecycle-narrow.json",
        ),
        ("sessions/full_pack_query", "valid/full-pack-query.json"),
        ("sessions/full_pack_page", "valid/full-pack-page.json"),
        ("enrollment/mint_request", "valid/enrollment-mint.json"),
        (
            "enrollment/mint_response",
            "valid/enrollment-mint-response.json",
        ),
        (
            "enrollment/sponsor_bootstrap_request",
            "valid/enrollment-bootstrap-request.json",
        ),
        (
            "enrollment/sponsor_enrollment_decision",
            "valid/enrollment-decision-approve.json",
        ),
        (
            "enrollment/sponsor_enrollment_decision_command",
            "valid/enrollment-decision-command-approve.json",
        ),
        (
            "enrollment/sponsor_enrollment_decision_response",
            "valid/enrollment-decision-response.json",
        ),
        (
            "enrollment/device_code_start_response",
            "valid/device-code-start-response.json",
        ),
        (
            "enrollment/operator_fellow_cap_override_request",
            "valid/enrollment-operator-fellow-cap-override-request.json",
        ),
        (
            "enrollment/operator_fellow_cap_override_response",
            "valid/enrollment-operator-fellow-cap-override-response.json",
        ),
        (
            "ledger/claim_face_query",
            "valid/ledger-claim-face-query.json",
        ),
        ("dead-ends/query", "valid/dead-ends-target-query.json"),
        ("dead-end", "valid/record-dead-end-request.json"),
    ];
    for &(target, fixture) in valid_cases {
        let raw = read_fixture(fixture);
        let verdict = validate_bundled(target, &raw, false)
            .unwrap_or_else(|e| panic!("valid fixture {fixture} against {target} errored: {e}"));
        assert!(
            verdict.valid,
            "expected valid for {fixture} against {target}, got code={:?} rule={:?} pointers={:?}",
            verdict.code, verdict.rule, verdict.pointers
        );
        assert!(verdict.canonical_sha256.is_some());
    }

    let invalid_cases: &[(&str, &str)] = &[
        ("promote", "invalid/promote-unknown-kind.json"),
        ("promote", "invalid/promote-workshop-retarget.json"),
        ("promote", "invalid/promote-workshop-version.json"),
        (
            "sessions/promote_response",
            "invalid/promote-review-feedback-negative.json",
        ),
        ("enroll", "invalid/enrollment-invalid-secret.json"),
        ("enroll", "invalid/enrollment-nul-persisted-text.json"),
        (
            "enrollment/device_lookup_request",
            "invalid/device-lookup-lowercase-code.json",
        ),
        (
            "enrollment/mint_request",
            "invalid/enrollment-mint-invalid-budget.json",
        ),
        (
            "enrollment/mint_response",
            "invalid/enrollment-mint-response-plainsecret.json",
        ),
        (
            "enrollment/sponsor_bootstrap_request",
            "invalid/enrollment-bootstrap-request-extra.json",
        ),
        (
            "enrollment/sponsor_enrollment_decision",
            "invalid/enrollment-decision-missing-target.json",
        ),
        (
            "enrollment/sponsor_enrollment_decision_command",
            "invalid/enrollment-decision-command-fractional-step-up.json",
        ),
        (
            "enrollment/operator_fellow_cap_override_request",
            "invalid/enrollment-operator-fellow-cap-override-missing-expected.json",
        ),
        (
            "batch/plan_request",
            "invalid/batch-commit-plan-request-empty.json",
        ),
        (
            "batch/plan_request",
            "invalid/batch-commit-plan-request-invalid-temp-id.json",
        ),
        (
            "batch/plan_request",
            "invalid/batch-commit-plan-request-too-large.json",
        ),
        (
            "batch/event_cause",
            "invalid/batch-event-cause-unbound.json",
        ),
        (
            "contracts-scaffold",
            "invalid/contracts-scaffold-stale.json",
        ),
        (
            "discovery/area_rename_request",
            "invalid/admin-area-rename.json",
        ),
        ("discovery/now_query", "invalid/discovery-now-query.json"),
        (
            "discovery/honors_query",
            "invalid/discovery-honors-query.json",
        ),
        (
            "discovery/fellow_query",
            "invalid/discovery-fellow-query.json",
        ),
        ("sessions/full_pack_query", "invalid/full-pack-query.json"),
        ("sessions/full_pack_page", "invalid/full-pack-page.json"),
        ("dead-ends/query", "invalid/dead-ends-target-query.json"),
        ("dead-end", "invalid/record-dead-end-request.json"),
    ];
    for &(target, fixture) in invalid_cases {
        let raw = read_fixture(fixture);
        let verdict = validate_bundled(target, &raw, false)
            .unwrap_or_else(|e| panic!("invalid fixture {fixture} against {target} errored: {e}"));
        assert!(
            !verdict.valid,
            "expected INVALID for {fixture} against {target}, but validator accepted it!"
        );
        assert!(verdict.code.is_some());
        assert!(verdict.rule.is_some());
    }
}

#[test]
fn cli_validate_and_scrub_never_consult_credentials_or_echo_secrets() {
    let secret = format!("ghp_{}", "z".repeat(36));
    let payload = format!(
        r#"{{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"Draft carrying {secret}"}}"#
    );

    // 1. `asimp scrub --stdin --json` with a malformed ASIMP_TOKEN must still run offline
    //    and never echo either the secret or the env token.
    let mut child = asimp_bin()
        .args(["scrub", "--stdin", "--json"])
        .env("ASIMP_TOKEN", "bad-token-canary\r\nx:bad")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.is_empty());
    assert!(!stdout.contains(&secret));
    assert!(!stdout.contains("bad-token-canary"));
    let parsed: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["code"], "SECRET_SHAPED_CONTENT");
    assert_eq!(parsed["findings"][0]["path"], "statement");
    assert_eq!(parsed["findings"][0]["kind"], "access-token");

    // 2. `asimp validate --stdin --kind promote --scrub --json` catches the P7 secret
    //    without touching ASIMP_TOKEN or leaking the secret.
    let mut child = asimp_bin()
        .args([
            "validate", "--stdin", "--kind", "promote", "--scrub", "--json",
        ])
        .env("ASIMP_TOKEN", "bad-token-canary\r\nx:bad")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains(&secret));
    assert!(!stdout.contains("bad-token-canary"));
    let parsed: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["code"], "SECRET_SHAPED_CONTENT");
    assert_eq!(parsed["rule"], "P7");
}

#[test]
fn cli_validate_supports_list_schemas_and_external_schema_file() {
    let list_out = asimp_bin()
        .args(["validate", "--list-schemas", "--json"])
        .output()
        .unwrap();
    assert!(list_out.status.success());
    let catalog: Value = serde_json::from_slice(&list_out.stdout).unwrap();
    assert_eq!(catalog["schema"], "asimp.validate.catalog.v1");
    assert_eq!(catalog["aliases"]["promote"], "sessions/promote_request");
    assert!(catalog["schemas"].as_array().unwrap().len() >= 27);

    let schema_file = repo_root().join("packages/contracts/generated/sessions.schema.json");
    let valid_fixture =
        repo_root().join("packages/contracts/test/fixtures/valid/promote-request.json");
    let invalid_fixture =
        repo_root().join("packages/contracts/test/fixtures/invalid/promote-unknown-kind.json");

    let ok = asimp_bin()
        .args([
            "validate",
            valid_fixture.to_str().unwrap(),
            "--schema-file",
            schema_file.to_str().unwrap(),
            "--slice",
            "promote_request",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(ok.status.success());
    let ok_json: Value = serde_json::from_slice(&ok.stdout).unwrap();
    assert_eq!(ok_json["valid"], true);

    let bad = asimp_bin()
        .args([
            "validate",
            invalid_fixture.to_str().unwrap(),
            "--schema-file",
            schema_file.to_str().unwrap(),
            "--slice",
            "promote_request",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(1));
    let bad_json: Value = serde_json::from_slice(&bad.stdout).unwrap();
    assert_eq!(bad_json["valid"], false);
}

#[test]
fn cli_validate_and_scrub_fail_closed_on_malformed_inputs_without_reflecting_paths() {
    let missing_canary = Path::new("/nonexistent/private-secret-path-canary.json");
    for args in [
        vec![
            "validate",
            missing_canary.to_str().unwrap(),
            "--kind",
            "promote",
        ],
        vec!["scrub", missing_canary.to_str().unwrap()],
    ] {
        let out = asimp_bin().args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!stderr.contains("private-secret-path-canary"));
    }

    // Invalid JSON fails closed with exit 2 and never echoes input bytes.
    let mut child = asimp_bin()
        .args(["validate", "--stdin", "--kind", "promote", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{not-valid-json-canary-secret}")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("canary-secret"));
}

#[test]
fn scrub_parity_covers_uri_assignments_and_hostile_keys() {
    // Password-bearing URIs
    let uri = "mongodb+srv://reader:synthetic%40encoded%3Apassword@db.example.invalid/research";
    let f = scan_field_for_credentials("body_md", &format!("𝔽 {uri}"));
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].kind, FindingKind::AccessToken);
    assert_eq!(f[0].column, 24);

    // Hostile JSON key containing credential assignment
    let hostile = r#"{"DB_PASSWORD=synthetic-key-value":{"password":"synthetic-value"}}"#;
    let hf = scan_field_for_credentials("request", hostile);
    assert_eq!(
        hf.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(),
        vec!["[key:0]", "[entry:0].password"]
    );

    // Escaped URI inside JSON artifact
    let art =
        r#"{"connection":"postgres:\/\/reader:synthetic-artifact-password@db.invalid/research"}"#;
    assert!(
        scan_body_for_secrets(art)
            .iter()
            .any(|x| x.kind == FindingKind::AccessToken)
    );
}
