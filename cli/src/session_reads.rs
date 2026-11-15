//! Bounded recovery reads over the existing Worker contracts. A command reads
//! one page and returns it unchanged; the caller owns continuation and state.

use crate::{Command, WorkshopCommand, safe_session_segment};

const MAX_SAFE_CURSOR: u64 = 9_007_199_254_740_991;

pub(crate) fn read_path(command: &Command) -> Result<(String, String), String> {
    let (session, label, suffix, parameters) = match command {
        Command::Pack {
            session,
            profile,
            max_tokens,
            target,
            since,
            after,
            through,
            ..
        } => {
            if [since, after, through]
                .into_iter()
                .any(|value| value.is_some_and(|cursor| cursor > MAX_SAFE_CURSOR))
            {
                return Err("Pack cursors must be exact non-negative JavaScript-safe integers from the Worker response.".to_owned());
            }
            if since.is_some() && !matches!(profile.as_str(), "orient" | "working") {
                return Err("--since is supported only for orient and working packs; it filters material events while retaining standing context.".to_owned());
            }
            if (after.is_some() || through.is_some()) && profile != "full" {
                return Err("--after and --through require --profile full.".to_owned());
            }
            if after.unwrap_or(0) > 0 && through.is_none() {
                return Err("A full-pack continuation requires the original page's --through cursor; do not mix snapshots.".to_owned());
            }
            if through.is_some_and(|end| after.unwrap_or(0) > end) {
                return Err("--after cannot exceed the captured --through cursor.".to_owned());
            }
            let mut parameters = url::form_urlencoded::Serializer::new(String::new());
            parameters.append_pair("profile", profile);
            if let Some(max_tokens) = max_tokens {
                parameters.append_pair("max_tokens", &max_tokens.to_string());
            }
            if let Some(target) = target {
                parameters.append_pair("target", target);
            }
            for (key, value) in [("since", since), ("after", after), ("through", through)] {
                if let Some(value) = value {
                    parameters.append_pair(key, &value.to_string());
                }
            }
            (session, "session pack", "pack", parameters.finish())
        }
        Command::Workshop {
            command:
                WorkshopCommand::List {
                    session,
                    after,
                    limit,
                    state,
                    ..
                },
        } => {
            if limit.is_some_and(|value| !(1..=100).contains(&value)) {
                return Err(
                    "--limit must be from 1 to 100 for a workshop directory page.".to_owned(),
                );
            }
            let mut parameters = url::form_urlencoded::Serializer::new(String::new());
            if let Some(after) = after {
                parameters.append_pair("after", after);
            }
            if let Some(limit) = limit {
                parameters.append_pair("limit", &limit.to_string());
            }
            if let Some(state) = state {
                parameters.append_pair("state", state);
            }
            (session, "workshop list", "workshop", parameters.finish())
        }
        _ => return Err("Expected a session pack or workshop directory read.".to_owned()),
    };
    if !safe_session_segment(session) {
        return Err("Session ID must be one origin-relative path component, not a URL.".to_owned());
    }
    let mut path = format!("/v1/sessions/{session}/{suffix}");
    if !parameters.is_empty() {
        path.push('?');
        path.push_str(&parameters);
    }
    Ok((path, label.to_owned()))
}

/// The endpoint accepts both create and revise. An explicit revise command
/// must never accidentally create a second draft when its revision pin is
/// missing. The Worker remains responsible for the full schema and authority.
pub(crate) fn is_revision_request(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value
        .get("workshop_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && value
            .get("base_version")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|version| (1..=MAX_SAFE_CURSOR).contains(&version))
}

#[cfg(test)]
mod tests {
    use crate::{Cli, FetchError, Fetched, run_cli_with_fetch, run_cli_write};
    use clap::Parser;

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
    fn pack_continuations_keep_the_snapshot_and_the_entire_control_record() {
        let body = "{\"items\":[{\"kind\":\"full-pack-page\",\"body\":\"{\\\"through\\\":80,\\\"next_after\\\":40,\\\"has_more\\\":true}\"}],\"omitted\":[{\"reason\":\"budget_exceeded\"}]}\n";
        for (args, query) in [
            (
                vec!["pack", "S-1", "--since", "17"],
                "profile=working&since=17",
            ),
            (
                vec!["pack", "S-1", "--profile", "orient", "--since", "0"],
                "profile=orient&since=0",
            ),
            (vec!["pack", "S-1", "--profile", "full"], "profile=full"),
            (
                vec![
                    "pack",
                    "S-1",
                    "--profile",
                    "full",
                    "--after",
                    "20",
                    "--through",
                    "80",
                    "--max-tokens",
                    "8000",
                ],
                "profile=full&max_tokens=8000&after=20&through=80",
            ),
            (
                vec![
                    "pack",
                    "S-1",
                    "--profile",
                    "full",
                    "--after",
                    "0",
                    "--through",
                    "0",
                ],
                "profile=full&after=0&through=0",
            ),
        ] {
            let result = run_cli_with_fetch(&cli(&args), |url| {
                assert_eq!(
                    url,
                    format!("https://example.test/v1/sessions/S-1/pack?{query}")
                );
                Ok(Fetched {
                    status: 200,
                    body: body.to_owned(),
                })
            });
            assert_eq!(result.exit_code, 0);
            assert_eq!(result.stdout, body);
            assert!(result.stderr.is_empty());
        }
    }

    #[test]
    fn invalid_or_mixed_pack_windows_never_reach_the_worker() {
        for args in [
            vec!["pack", "S-1", "--since", "9007199254740992"],
            vec!["pack", "S-1", "--profile", "review", "--since", "0"],
            vec!["pack", "S-1", "--after", "0"],
            vec!["pack", "S-1", "--profile", "full", "--after", "20"],
            vec![
                "pack",
                "S-1",
                "--profile",
                "full",
                "--after",
                "21",
                "--through",
                "20",
            ],
            vec![
                "pack",
                "S-1",
                "--profile",
                "full",
                "--through",
                "9007199254740992",
            ],
        ] {
            let result =
                run_cli_with_fetch(&cli(&args), |_| panic!("invalid cursor reached transport"));
            assert_eq!(result.exit_code, 2);
            assert!(result.stdout.is_empty());
        }
        assert!(
            Cli::try_parse_from(["asimp", "pack", "S-1", "--since", "1", "--through", "2"])
                .is_err()
        );
    }

    #[test]
    fn workshop_directory_keeps_opaque_parameters_inside_the_query() {
        let response = "{\"items\":[],\"next_after\":\"W-next\",\"omitted\":[\"source_unavailable\",\"page_limit\"]}\n";
        let result = run_cli_with_fetch(
            &cli(&[
                "workshop",
                "list",
                "S-1",
                "--after",
                "W-1&other=private",
                "--limit",
                "2",
                "--state",
                "archived",
                "--json",
            ]),
            |url| {
                assert_eq!(
                    url,
                    "https://example.test/v1/sessions/S-1/workshop?after=W-1%26other%3Dprivate&limit=2&state=archived"
                );
                Ok(Fetched {
                    status: 200,
                    body: response.to_owned(),
                })
            },
        );
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, response);
        for args in [
            vec!["workshop", "list", "S-1", "--limit", "0"],
            vec!["workshop", "list", "S-1", "--limit", "101"],
            vec!["workshop", "list", "private/../escape"],
        ] {
            let result = run_cli_with_fetch(&cli(&args), |_| panic!("unsafe directory read"));
            assert_eq!(result.exit_code, 2);
            assert!(!result.stderr.contains("private/../escape"));
        }
    }

    #[test]
    fn revision_pins_reach_the_existing_write_path_unchanged() {
        let parsed = cli(&[
            "workshop",
            "revise",
            "S-1",
            "--file",
            "private.json",
            "--idempotency-key",
            "edit-1",
        ]);
        for action in ["edit", "keep", "archive", "discard"] {
            let body =
                format!(r#"{{"workshop_id":"W-existing","base_version":3,"action":"{action}"}}"#);
            let output = run_cli_write(
                &parsed,
                |_| Ok(body.clone()),
                |url, key, actual| {
                    assert_eq!(url, "https://example.test/v1/sessions/S-1/workshop");
                    assert_eq!(key, "edit-1");
                    assert_eq!(actual, body);
                    Ok(Fetched {
                        status: 200,
                        body: "exact revision receipt".to_owned(),
                    })
                },
            );
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, "exact revision receipt");
        }
        for body in [
            r#"{"type":"note","title":"private-canary","body_md":"new draft"}"#,
            r#"{"workshop_id":"W-existing","base_version":0}"#,
            r#"{"workshop_id":"W-existing","base_version":9007199254740992}"#,
            "private malformed JSON",
        ] {
            let output = run_cli_write(
                &parsed,
                |_| Ok(body.to_owned()),
                |_, _, _| panic!("revision became a create"),
            );
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("private-canary"));
        }
    }

    #[test]
    fn lost_revision_response_never_retries_or_exposes_private_inputs() {
        let parsed = cli(&[
            "workshop",
            "revise",
            "S-private",
            "--file",
            "private.json",
            "--idempotency-key",
            "private-key",
        ]);
        let output = run_cli_write(
            &parsed,
            |_| Ok(r#"{"workshop_id":"W-private","base_version":1}"#.to_owned()),
            |_, _, _| Err(FetchError::Network),
        );
        assert_eq!(output.exit_code, 2);
        assert!(output.stdout.is_empty());
        assert!(output.stderr.contains("SAME --idempotency-key"));
        for private in ["S-private", "W-private", "private.json", "private-key"] {
            assert!(!output.stderr.contains(private));
        }
    }
}
