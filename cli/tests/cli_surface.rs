use std::{
    process::{Command, Output},
    time::{Duration, Instant},
};

const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

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

    assert!(
        stderr.contains("unrecognized subcommand 'unknown-command'"),
        "{context}"
    );
    assert!(stderr.contains("--help"), "{context}");
}
