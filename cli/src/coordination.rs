//! Explicit private coordination commands. These use the same authenticated,
//! bounded transport as session work; reads never acknowledge a notice, acquire
//! a lease, follow a next action, or retry a write on the caller's behalf.

use crate::{Command, LedgerWriteArgs, safe_session_segment};

/// Largest cursor that survives the Worker's JSON/JavaScript integer boundary.
const MAX_SAFE_CURSOR: u64 = 9_007_199_254_740_991;

#[derive(Debug, clap::Subcommand)]
pub enum InboxCommand {
    /// Read one private inbox page without acknowledging notices or following next actions.
    List {
        /// Continue after the next_cursor from the previous page; never advanced automatically.
        #[arg(long)]
        since: Option<u64>,
        /// Requested page size, from 1 to 100; omit for the Worker's default.
        #[arg(long)]
        limit: Option<u32>,
        /// Include only notices that have not been acknowledged.
        #[arg(long)]
        unread_only: bool,
        /// Print the complete JSON face instead of Markdown, including cursor and omissions.
        #[arg(long)]
        json: bool,
    },
    /// Acknowledge explicit notice IDs or an until_seq from a JSON file once.
    /// Re-acknowledgment may report a different count; the Worker does not replay ack receipts.
    Ack {
        #[command(flatten)]
        request: LedgerWriteArgs,
    },
}

#[derive(Debug, clap::Subcommand)]
pub enum LeaseCommand {
    /// Read the problem's active leases through your open session, without acquiring one.
    List {
        session: String,
        /// Explicit JSON output; leases always preserve the complete Worker response.
        #[arg(long)]
        json: bool,
    },
    /// Acquire a lease with an explicit object, objective and deliverable in a JSON file.
    Acquire {
        session: String,
        #[command(flatten)]
        request: LedgerWriteArgs,
    },
    /// Release a lease you hold; the JSON file may contain a reason or an empty object.
    Release {
        session: String,
        /// Lease ID or leased object reference returned by the Worker.
        object: String,
        #[command(flatten)]
        request: LedgerWriteArgs,
    },
    /// Challenge a stale lease with a reason in a JSON file; the Worker checks eligibility.
    Challenge {
        session: String,
        /// Lease ID or leased object reference returned by the Worker.
        object: String,
        #[command(flatten)]
        request: LedgerWriteArgs,
    },
}

fn validate_session(session: &str) -> Result<(), String> {
    if safe_session_segment(session) {
        Ok(())
    } else {
        Err("Session ID must be one origin-relative path component, not a URL.".to_owned())
    }
}

/// Build only documented private GET paths. The labels intentionally omit
/// user-supplied session references and cursor values from error output.
pub(crate) fn read_path(command: &Command) -> Result<Option<(String, String)>, String> {
    match command {
        Command::Inbox {
            command:
                InboxCommand::List {
                    since,
                    limit,
                    unread_only,
                    json,
                },
        } => {
            if since.is_some_and(|cursor| cursor > MAX_SAFE_CURSOR) {
                return Err("--since must be an exact non-negative JavaScript-safe integer from the Worker's next_cursor.".to_owned());
            }
            if limit.is_some_and(|value| !(1..=100).contains(&value)) {
                return Err("--limit must be from 1 to 100 for an inbox page.".to_owned());
            }
            let mut parameters = url::form_urlencoded::Serializer::new(String::new());
            if let Some(since) = since {
                parameters.append_pair("since", &since.to_string());
            }
            if let Some(limit) = limit {
                parameters.append_pair("limit", &limit.to_string());
            }
            if *unread_only {
                parameters.append_pair("unread_only", "true");
            }
            let query = parameters.finish();
            let mut path = if *json { "/v1/inbox" } else { "/v1/inbox.md" }.to_owned();
            if !query.is_empty() {
                path.push('?');
                path.push_str(&query);
            }
            Ok(Some((path, "inbox list".to_owned())))
        }
        Command::Lease {
            command: LeaseCommand::List { session, .. },
        } => {
            validate_session(session)?;
            Ok(Some((
                format!("/v1/sessions/{session}/leases"),
                "lease list".to_owned(),
            )))
        }
        _ => Ok(None),
    }
}

/// Override the session-write path only for these explicit commands. Every
/// write still goes through the parent's file/key validation and one POST.
pub(crate) fn write_path(command: &Command) -> Result<Option<String>, String> {
    match command {
        Command::Inbox {
            command: InboxCommand::Ack { .. },
        } => Ok(Some("/v1/inbox/ack".to_owned())),
        Command::Lease {
            command: LeaseCommand::Acquire { session, .. },
        } => {
            validate_session(session)?;
            Ok(Some(format!("/v1/sessions/{session}/leases")))
        }
        Command::Lease {
            command:
                LeaseCommand::Release {
                    session, object, ..
                }
                | LeaseCommand::Challenge {
                    session, object, ..
                },
        } => {
            validate_session(session)?;
            if !safe_session_segment(object) {
                return Err(
                    "Lease or object reference must be one origin-relative path component, not a URL."
                        .to_owned(),
                );
            }
            let action = if matches!(
                command,
                Command::Lease {
                    command: LeaseCommand::Release { .. }
                }
            ) {
                "release"
            } else {
                "challenge"
            };
            Ok(Some(format!(
                "/v1/sessions/{session}/leases/{object}/{action}"
            )))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Cli, FetchError, Fetched, run_cli_with_fetch, run_cli_write, token_for_command};
    use clap::Parser;
    use std::cell::Cell;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(
            [
                vec!["asimp", "--origin", "https://example.test"],
                args.to_vec(),
            ]
            .concat(),
        )
        .unwrap()
    }

    #[test]
    fn inbox_reads_preserve_the_entire_page_and_never_acknowledge_or_follow_actions() {
        let raw = "{\"items\":[{\"next_actions\":[{\"method\":\"POST\",\"url\":\"/v1/inbox/ack\"}]}],\"next_cursor\":92,\"has_more\":true,\"omitted\":[\"limit_reached\"]}\n";
        let calls = Cell::new(0);
        let output = run_cli_with_fetch(
            &cli(&[
                "inbox",
                "list",
                "--since",
                "42",
                "--limit",
                "25",
                "--unread-only",
                "--json",
            ]),
            |url| {
                calls.set(calls.get() + 1);
                assert_eq!(
                    url,
                    "https://example.test/v1/inbox?since=42&limit=25&unread_only=true"
                );
                Ok(Fetched {
                    status: 200,
                    body: raw.to_owned(),
                })
            },
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, raw);
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn inbox_defaults_to_markdown_and_uses_the_workers_defaults() {
        for (args, expected) in [
            (vec!["inbox", "list"], "/v1/inbox.md"),
            (vec!["inbox", "list", "--json"], "/v1/inbox"),
            (
                vec!["inbox", "list", "--since", "0"],
                "/v1/inbox.md?since=0",
            ),
            (
                vec!["inbox", "list", "--limit", "100"],
                "/v1/inbox.md?limit=100",
            ),
            (
                vec!["inbox", "list", "--since", "9007199254740991", "--json"],
                "/v1/inbox?since=9007199254740991",
            ),
        ] {
            let output = run_cli_with_fetch(&cli(&args), |url| {
                assert_eq!(url, format!("https://example.test{expected}"));
                Ok(Fetched {
                    status: 200,
                    body: "complete worker face".to_owned(),
                })
            });
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, "complete worker face");
        }
    }

    #[test]
    fn inexact_cursors_and_unbounded_inbox_pages_never_reach_transport() {
        for args in [
            vec!["inbox", "list", "--since", "9007199254740992"],
            vec!["inbox", "list", "--since", "18446744073709551615"],
            vec!["inbox", "list", "--limit", "0"],
            vec!["inbox", "list", "--limit", "101"],
        ] {
            let output = run_cli_with_fetch(&cli(&args), |_| panic!("invalid query sent"));
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("9007199254740992"));
            assert!(!output.stderr.contains("18446744073709551615"));
        }
        for value in ["-1", "1.5", "1e3", "not-a-number"] {
            assert!(Cli::try_parse_from(["asimp", "inbox", "list", "--since", value]).is_err());
        }
    }

    #[test]
    fn lease_list_keeps_other_holders_objectives_and_lease_ids_intact() {
        let raw = "{\"ok\":true,\"leases\":[{\"lease_id\":\"L-123\",\"fellow_id\":\"F-other\",\"objective\":\"check C-2\",\"deliverable\":\"refutation\",\"parallel_safe\":true}]}";
        for args in [
            vec!["lease", "list", "S-123"],
            vec!["lease", "list", "S-123", "--json"],
        ] {
            let output = run_cli_with_fetch(&cli(&args), |url| {
                assert_eq!(url, "https://example.test/v1/sessions/S-123/leases");
                Ok(Fetched {
                    status: 200,
                    body: raw.to_owned(),
                })
            });
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, raw);
            assert!(output.stderr.is_empty());
        }
    }

    #[test]
    fn coordination_writes_post_the_exact_file_and_key_once() {
        for (args, expected, body) in [
            (
                vec!["inbox", "ack"],
                "/v1/inbox/ack",
                "{\"until_seq\":42}\n",
            ),
            (
                vec!["lease", "acquire", "S-123"],
                "/v1/sessions/S-123/leases",
                "{\"object\":\"C-1\",\"objective\":\"Check boundary\",\"deliverable\":\"Witness\",\"parallel_safe\":false}",
            ),
            (
                vec!["lease", "release", "S-123", "L-123"],
                "/v1/sessions/S-123/leases/L-123/release",
                "{}",
            ),
            (
                vec!["lease", "challenge", "S-123", "C-1"],
                "/v1/sessions/S-123/leases/C-1/challenge",
                "{\"reason\":\"Holder stopped work\"}",
            ),
        ] {
            let command = cli(&[
                args,
                vec![
                    "--file",
                    "private-input.json",
                    "--idempotency-key",
                    "retained-key",
                    "--json",
                ],
            ]
            .concat());
            let calls = Cell::new(0);
            let result = run_cli_write(
                &command,
                |file| {
                    assert_eq!(file, std::path::Path::new("private-input.json"));
                    Ok(body.to_owned())
                },
                |url, key, actual| {
                    calls.set(calls.get() + 1);
                    assert_eq!(url, format!("https://example.test{expected}"));
                    assert_eq!(key, "retained-key");
                    assert_eq!(actual, body);
                    Ok(Fetched {
                        status: 200,
                        body: "{\"complete_receipt\":true}\n".to_owned(),
                    })
                },
            );
            assert_eq!(calls.get(), 1);
            assert_eq!(result.exit_code, 0);
            assert_eq!(result.stdout, "{\"complete_receipt\":true}\n");
            assert!(result.stderr.is_empty());
        }
    }

    #[test]
    fn private_commands_require_credentials_and_writes_require_file_and_key() {
        for args in [
            vec!["inbox", "list"],
            vec!["lease", "list", "S-123"],
            vec![
                "inbox",
                "ack",
                "--file",
                "request.json",
                "--idempotency-key",
                "key",
            ],
            vec![
                "lease",
                "acquire",
                "S-123",
                "--file",
                "request.json",
                "--idempotency-key",
                "key",
            ],
            vec![
                "lease",
                "release",
                "S-123",
                "C-1",
                "--file",
                "request.json",
                "--idempotency-key",
                "key",
            ],
            vec![
                "lease",
                "challenge",
                "S-123",
                "C-1",
                "--file",
                "request.json",
                "--idempotency-key",
                "key",
            ],
        ] {
            let command = cli(&args);
            assert!(command.command.requires_token());
            assert!(
                token_for_command(&command.command, || Err(std::env::VarError::NotPresent))
                    .is_err()
            );
            assert_eq!(
                token_for_command(&command.command, || Ok("asimp_ag_fixture".to_owned())).unwrap(),
                Some("asimp_ag_fixture".to_owned())
            );
        }
        for base in [
            vec!["inbox", "ack"],
            vec!["lease", "acquire", "S-123"],
            vec!["lease", "release", "S-123", "C-1"],
            vec!["lease", "challenge", "S-123", "C-1"],
        ] {
            for missing in [
                vec![],
                vec!["--file", "request.json"],
                vec!["--idempotency-key", "key"],
            ] {
                assert!(
                    Cli::try_parse_from([vec!["asimp"], base.clone(), missing].concat()).is_err()
                );
            }
        }
    }

    #[test]
    fn lease_segments_cannot_redirect_private_requests_or_echo_private_input() {
        for unsafe_id in [
            "",
            ".",
            "..",
            "secret-canary/path",
            "secret-canary?query",
            "secret-canary#fragment",
            "%2f",
            "https://secret-canary.test",
            "secret-canary\\path",
            "secret-canary\n",
        ] {
            let output = run_cli_with_fetch(&cli(&["lease", "list", unsafe_id]), |_| {
                panic!("unsafe lease read reached transport")
            });
            assert_eq!(output.exit_code, 2);
            assert!(!output.stderr.contains("secret-canary"));
            for base in [
                vec!["lease", "acquire", unsafe_id],
                vec!["lease", "release", unsafe_id, "C-1"],
                vec!["lease", "release", "S-123", unsafe_id],
                vec!["lease", "challenge", unsafe_id, "C-1"],
                vec!["lease", "challenge", "S-123", unsafe_id],
            ] {
                let command = cli(&[
                    base,
                    vec!["--file", "request.json", "--idempotency-key", "key"],
                ]
                .concat());
                let output = run_cli_write(
                    &command,
                    |_| panic!("invalid path read private file"),
                    |_, _, _| panic!("invalid path sent"),
                );
                assert_eq!(output.exit_code, 2);
                assert!(output.stdout.is_empty());
                assert!(!output.stderr.contains("secret-canary"));
            }
        }
    }

    #[test]
    fn failed_acknowledgment_never_retries_or_echoes_body_file_and_key() {
        let command = cli(&[
            "inbox",
            "ack",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "private-key-canary",
        ]);
        for failure in [
            FetchError::Network,
            FetchError::Status(409),
            FetchError::Status(503),
        ] {
            let calls = Cell::new(0);
            let output = run_cli_write(
                &command,
                |_| Ok("{\"notice_ids\":[\"private-body-canary\"]}".to_owned()),
                |_, _, _| {
                    calls.set(calls.get() + 1);
                    Err(failure)
                },
            );
            assert_eq!(calls.get(), 1);
            assert_ne!(output.exit_code, 0);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("canary"));
            assert!(output.stderr.contains("Read asimp inbox list --json"));
            assert!(output.stderr.contains("counts are not a replay"));
            assert!(!output.stderr.contains("24h"));
            assert!(!output.stderr.contains("SAME --idempotency-key"));
        }
    }

    #[test]
    fn repeated_acknowledgments_preserve_the_workers_current_counts() {
        let command = cli(&[
            "inbox",
            "ack",
            "--file",
            "ack.json",
            "--idempotency-key",
            "same-key",
            "--json",
        ]);
        for response in [
            "{\"acknowledged_count\":2,\"unacknowledged_count\":1}",
            "{\"acknowledged_count\":0,\"unacknowledged_count\":1}",
        ] {
            let output = run_cli_write(
                &command,
                |_| Ok("{\"until_seq\":42}".to_owned()),
                |url, key, body| {
                    assert_eq!(url, "https://example.test/v1/inbox/ack");
                    assert_eq!(key, "same-key");
                    assert_eq!(body, "{\"until_seq\":42}");
                    Ok(Fetched {
                        status: 200,
                        body: response.to_owned(),
                    })
                },
            );
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, response);
        }
    }

    #[test]
    fn lease_failures_stop_after_one_request_without_acquiring_or_stealing() {
        for args in [
            vec!["lease", "acquire", "S-session-canary"],
            vec!["lease", "release", "S-session-canary", "L-object-canary"],
            vec!["lease", "challenge", "S-session-canary", "C-object-canary"],
        ] {
            let command = cli(&[
                args,
                vec![
                    "--file",
                    "private-file-canary.json",
                    "--idempotency-key",
                    "key-canary",
                ],
            ]
            .concat());
            for failure in [
                FetchError::Network,
                FetchError::Status(302),
                FetchError::Status(401),
                FetchError::Status(403),
                FetchError::Status(404),
                FetchError::Status(409),
                FetchError::Status(422),
                FetchError::Status(503),
            ] {
                let calls = Cell::new(0);
                let output = run_cli_write(
                    &command,
                    |_| Ok("{\"reason\":\"body-canary\"}".to_owned()),
                    |_, key, body| {
                        calls.set(calls.get() + 1);
                        assert_eq!(key, "key-canary");
                        assert_eq!(body, "{\"reason\":\"body-canary\"}");
                        Err(failure)
                    },
                );
                assert_eq!(calls.get(), 1);
                assert_ne!(output.exit_code, 0);
                assert!(output.stdout.is_empty());
                assert!(output.stderr.contains("lease write"));
                assert!(!output.stderr.contains("canary"));
                if output.stderr.contains("HTTP 409") {
                    assert!(output.stderr.contains("asimp lease list"));
                    assert!(output.stderr.contains("challenge does not seize"));
                }
            }
        }
    }

    #[test]
    fn read_and_write_paths_are_separate_even_with_a_saved_token() {
        let list = cli(&["inbox", "list"]);
        assert!(list.command.write_request().is_none());
        assert_eq!(write_path(&list.command).unwrap(), None);
        let ack = cli(&[
            "inbox",
            "ack",
            "--file",
            "request.json",
            "--idempotency-key",
            "key",
        ]);
        assert_eq!(read_path(&ack.command).unwrap(), None);
        let output = run_cli_with_fetch(&ack, |_| panic!("ack sent as a GET"));
        assert_eq!(output.exit_code, 2);
    }

    #[test]
    fn failed_inbox_reads_teach_the_inbox_contract_without_exposing_the_cursor() {
        let command = cli(&["inbox", "list", "--since", "7654321"]);
        for status in [400, 401, 403, 404, 422, 429, 503] {
            let output = run_cli_with_fetch(&command, |_| Err(FetchError::Status(status)));
            assert_eq!(output.exit_code, 1);
            assert!(output.stdout.is_empty());
            assert!(output.stderr.contains(&format!("HTTP {status}")));
            assert!(!output.stderr.contains("7654321"));
            assert!(!output.stderr.contains("session"));
            if matches!(status, 400 | 422) {
                assert!(output.stderr.contains("/schemas/inbox.v1.json"));
            }
        }
    }
}
