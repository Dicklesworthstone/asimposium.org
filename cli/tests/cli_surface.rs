use std::{
    process::{Command, Output},
    time::{Duration, Instant},
};

const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[test]
fn authenticated_read_help_describes_the_existing_session_surface() {
    for args in [
        vec!["hello", "--help"],
        vec!["session", "status", "--help"],
        vec!["pack", "--help"],
    ] {
        let result = invoke(&args);
        assert!(result.output.status.success());
        assert!(String::from_utf8_lossy(&result.output.stdout).contains("--json"));
    }
    let pack = invoke(&["pack", "--help"]);
    let help = String::from_utf8_lossy(&pack.output.stdout);
    for flag in [
        "<SESSION>",
        "--profile",
        "--target",
        "--max-tokens",
        "ASIMP_TOKEN",
    ] {
        assert!(help.contains(flag), "missing help: {flag}");
    }
}

#[test]
fn private_commands_fail_before_network_when_token_is_missing_or_malformed() {
    for args in [
        vec!["hello"],
        vec!["session", "status", "S-1"],
        vec!["pack", "S-1"],
        vec![
            "session",
            "open",
            "P-4DSP",
            "--intent",
            "review",
            "--idempotency-key",
            "op-1",
        ],
        vec![
            "close",
            "S-1",
            "--handback",
            "private-handback-canary",
            "--idempotency-key",
            "op-1",
        ],
        vec![
            "session",
            "open",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "op-1",
        ],
        vec![
            "workshop",
            "push",
            "S-1",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "op-1",
        ],
        vec![
            "promote",
            "S-1",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "op-1",
        ],
        vec![
            "close",
            "S-1",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "op-1",
        ],
    ] {
        for token in [None, Some("secret-canary\r\nx-header: bad")] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_asimp"));
            command.args(&args).env_remove("ASIMP_TOKEN");
            if let Some(token) = token {
                command.env("ASIMP_TOKEN", token);
            }
            let output = command.output().unwrap();
            assert_eq!(output.status.code(), Some(2));
            assert!(output.stdout.is_empty());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains("ASIMP_TOKEN"));
            assert!(!stderr.contains("secret-canary"));
        }
    }
}

#[test]
fn typed_session_help_describes_alternatives_and_rejects_conflicting_inputs() {
    for (args, expected) in [
        (
            vec!["session", "open", "--help"],
            vec!["[PROBLEM]", "--intent", "--file"],
        ),
        (
            vec!["close", "--help"],
            vec!["--handback", "--file", "off argv"],
        ),
        (
            vec!["promote", "--help"],
            vec![
                "[WORKSHOP]",
                "--kind",
                "--statement",
                "--falsifier",
                "--relates-to",
                "--depends-on",
                "--file",
                "out of argv",
            ],
        ),
    ] {
        let output = invoke(&args).output;
        assert!(output.status.success());
        let help = String::from_utf8_lossy(&output.stdout);
        for text in expected {
            assert!(help.contains(text), "missing help: {text}");
        }
    }
    for args in [
        vec!["session", "open", "P-4DSP", "--file", "private-file-canary"],
        vec![
            "session",
            "open",
            "--file",
            "private-file-canary",
            "--intent",
            "review",
        ],
        vec![
            "close",
            "S-1",
            "--file",
            "private-file-canary",
            "--handback",
            "private-handback-canary",
        ],
        vec!["promote", "S-1", "W-1", "--file", "private-file-canary"],
        vec![
            "promote",
            "S-1",
            "--file",
            "private-file-canary",
            "--kind",
            "conjecture",
        ],
        vec![
            "promote",
            "S-1",
            "--file",
            "private-file-canary",
            "--statement",
            "private-statement-canary",
        ],
    ] {
        let output = invoke(&[args, vec!["--idempotency-key", "op-1"]].concat()).output;
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("cannot be used with"));
        assert!(!stderr.contains("canary"));
    }
}

#[test]
fn handback_limit_errors_count_without_echoing_private_text() {
    let text = format!("private-canary{}", "😀".repeat(1000));
    let output = Command::new(env!("CARGO_BIN_EXE_asimp"))
        .args([
            "--origin",
            "https://example.invalid",
            "close",
            "S-1",
            "--handback",
            &text,
            "--idempotency-key",
            "op-1",
        ])
        .env("ASIMP_TOKEN", "asimp_ag_synthetic_canary")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("2014 UTF-16 code units"));
    assert!(!stderr.contains("canary"));
    assert!(!stderr.contains('😀'));
}

#[test]
fn write_help_and_required_inputs_explain_json_files_and_retained_keys() {
    for args in [
        vec!["session", "open"],
        vec!["workshop", "push", "S-1"],
        vec!["promote", "S-1"],
        vec!["close", "S-1"],
    ] {
        let help = invoke(&[args.clone(), vec!["--help"]].concat());
        assert!(help.output.status.success());
        let text = String::from_utf8_lossy(&help.output.stdout);
        for expected in ["--file", "--idempotency-key", "--json", "Retain", "24h"] {
            assert!(text.contains(expected), "missing help: {expected}");
        }
        let missing = invoke(&args);
        assert_eq!(missing.output.status.code(), Some(2));
        let text = String::from_utf8_lossy(&missing.output.stderr);
        assert!(text.contains("--file"));
        assert!(text.contains("--idempotency-key"));
    }
}

#[test]
fn missing_request_file_fails_without_network_or_private_path_disclosure() {
    let output = Command::new(env!("CARGO_BIN_EXE_asimp"))
        .args([
            "--origin",
            "https://example.invalid",
            "session",
            "open",
            "--file",
            "/unavailable-canary/request.json",
            "--idempotency-key",
            "key-canary",
        ])
        .env("ASIMP_TOKEN", "asimp_ag_synthetic_canary")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Cannot read --file"));
    assert!(!stderr.contains("canary"));
}

struct Invocation {
    output: Output,
    duration: Duration,
}

fn invoke(args: &[&str]) -> Invocation {
    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_asimp"))
        .args(args)
        .env("NO_COLOR", "1")
        .output()
        .expect("compiled asimp binary should be runnable by integration tests");

    Invocation {
        output,
        duration: started.elapsed(),
    }
}

fn diagnostic(suite: &str, invocation: &Invocation, reproduction: &str) -> String {
    format!(
        "tool=cargo package=asimp suite={suite} version={PACKAGE_VERSION} duration_ms={} status={} reproduction={reproduction}",
        invocation.duration.as_millis(),
        invocation.output.status
    )
}

#[test]
fn version_surface_names_asimp() {
    let invocation = invoke(&["--version"]);
    let context = diagnostic(
        "cli_surface::version_surface_names_asimp",
        &invocation,
        "cargo test --test cli_surface version_surface_names_asimp",
    );

    assert!(invocation.output.status.success(), "{context}");
    assert_eq!(
        String::from_utf8_lossy(&invocation.output.stdout),
        format!("asimp {PACKAGE_VERSION}\n"),
        "{context}"
    );
    assert!(invocation.output.stderr.is_empty(), "{context}");
}

#[test]
fn help_surface_names_asimp_and_curl_boundary() {
    let invocation = invoke(&["--help"]);
    let context = diagnostic(
        "cli_surface::help_surface_names_asimp_and_curl_boundary",
        &invocation,
        "cargo test --test cli_surface help_surface_names_asimp_and_curl_boundary",
    );
    let stdout = String::from_utf8_lossy(&invocation.output.stdout);

    assert!(invocation.output.status.success(), "{context}");
    assert!(stdout.contains("Usage: asimp"), "{context}");
    assert!(stdout.contains("Curl remains sufficient."), "{context}");
    assert!(invocation.output.stderr.is_empty(), "{context}");
}

#[test]
fn empty_invocation_exits_two_with_clap_help_on_stderr() {
    let invocation = invoke(&[]);
    let context = diagnostic(
        "cli_surface::empty_invocation_exits_two_with_clap_help_on_stderr",
        &invocation,
        "cargo test --test cli_surface empty_invocation_exits_two_with_clap_help_on_stderr",
    );
    let stderr = String::from_utf8_lossy(&invocation.output.stderr);

    assert_eq!(invocation.output.status.code(), Some(2), "{context}");
    assert!(invocation.output.stdout.is_empty(), "{context}");
    assert!(stderr.contains("Usage: asimp"), "{context}");
    assert!(stderr.contains("Curl remains sufficient."), "{context}");
}

#[test]
fn unknown_command_exits_nonzero_with_a_useful_stderr_hint() {
    let invocation = invoke(&["unknown-command"]);
    let context = diagnostic(
        "cli_surface::unknown_command_exits_nonzero_with_a_useful_stderr_hint",
        &invocation,
        "cargo test --test cli_surface unknown_command_exits_nonzero_with_a_useful_stderr_hint",
    );
    let stderr = String::from_utf8_lossy(&invocation.output.stderr);

    assert_eq!(invocation.output.status.code(), Some(2), "{context}");
    assert!(invocation.output.stdout.is_empty(), "{context}");
    assert!(
        stderr.contains("unrecognized subcommand 'unknown-command'"),
        "{context}"
    );
    assert!(stderr.contains("--help"), "{context}");
}

#[test]
fn invalid_origin_refusal_does_not_echo_credentials() {
    let invocation = invoke(&[
        "--origin",
        "https://user:credential-shaped-value@example.test",
        "capabilities",
    ]);
    let context = diagnostic(
        "cli_surface::invalid_origin_refusal_does_not_echo_credentials",
        &invocation,
        "cargo test --test cli_surface invalid_origin_refusal_does_not_echo_credentials",
    );
    let stderr = String::from_utf8_lossy(&invocation.output.stderr);

    assert_eq!(invocation.output.status.code(), Some(2), "{context}");
    assert!(invocation.output.stdout.is_empty(), "{context}");
    assert!(
        stderr.contains("origin must not contain user information"),
        "{context}"
    );
    assert!(!stderr.contains("credential-shaped-value"), "{context}");
    assert!(!stderr.contains("example.test"), "{context}");
}

#[test]
fn search_help_exposes_working_public_options() {
    let invocation = invoke(&["search", "--help"]);
    let stdout = String::from_utf8_lossy(&invocation.output.stdout);
    assert!(invocation.output.status.success());
    assert!(invocation.output.stderr.is_empty());
    for expected in ["<QUERY>", "--json", "--kind", "--limit", "P-EXAMPLE#C-1"] {
        assert!(stdout.contains(expected), "missing help: {expected}");
    }
    assert!(
        !stdout.contains("--cursor"),
        "Worker pagination is not implemented"
    );
}

#[test]
fn search_requires_a_query_before_attempting_network_io() {
    let invocation = invoke(&["search", "--json"]);
    let stderr = String::from_utf8_lossy(&invocation.output.stderr);
    assert_eq!(invocation.output.status.code(), Some(2));
    assert!(invocation.output.stdout.is_empty());
    assert!(stderr.contains("<QUERY>"));
    assert!(stderr.contains("--help"));
}

#[test]
fn capabilities_help_advertises_explicit_json() {
    let invocation = invoke(&["capabilities", "--help"]);
    assert!(invocation.output.status.success());
    assert!(invocation.output.stderr.is_empty());
    assert!(String::from_utf8_lossy(&invocation.output.stdout).contains("--json"));
}
