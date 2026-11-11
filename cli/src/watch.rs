//! Public, read-only event following. The generated contract owns the wire
//! vocabulary; these checks protect transport completeness and cursor movement,
//! not scientific validity. One complete page is retained at a time.

use crate::{
    Cli, CliOutput, Command, FetchError, Fetched, MAX_BODY_BYTES, input_error, resolve_origin,
};
use serde_json::Value;
use std::{io::Write, time::Duration};

#[derive(Debug, clap::Args)]
pub struct WatchArgs {
    /// Public problem ID. Event bodies are read separately through object faces.
    problem: String,
    /// Last completely received page_end.next_cursor; defaults to the beginning.
    #[arg(long, default_value = "0", allow_hyphen_values = true)]
    since: String,
    /// Events per page; the bundled Worker contract supplies the upper bound.
    #[arg(long, default_value = "50", allow_hyphen_values = true)]
    limit: String,
    /// Drain one fixed public snapshot, including all of its pages, then exit.
    #[arg(long)]
    once: bool,
    /// Preserve complete Worker NDJSON pages, including omissions and page_end.
    #[arg(long)]
    json: bool,
}

struct Limits {
    schema: String,
    cursor: u64,
    events: u64,
    omissions: u64,
    event_schema: jsonschema::Validator,
    end_schema: jsonschema::Validator,
}

fn limits() -> Option<Limits> {
    let contract: Value = serde_json::from_str(include_str!(
        "../../packages/contracts/generated/event-tail.schema.json"
    ))
    .ok()?;
    let properties = &contract["properties"];
    Some(Limits {
        schema: properties["ndjson_page_end"]["properties"]["schema"]["const"]
            .as_str()?
            .into(),
        cursor: properties["ndjson_page_end"]["properties"]["next_cursor"]["maximum"].as_u64()?,
        events: properties["response"]["properties"]["events"]["maxItems"].as_u64()?,
        omissions: properties["ndjson_page_end"]["properties"]["omitted"]["maxItems"].as_u64()?,
        event_schema: jsonschema::validator_for(&properties["ndjson_event"]).ok()?,
        end_schema: jsonschema::validator_for(&properties["ndjson_page_end"]).ok()?,
    })
}

fn path(args: &WatchArgs, since: u64, through: Option<u64>) -> String {
    let mut result = format!(
        "/p/{}/events.ndjson?since={since}&limit={}",
        segment(&args.problem),
        args.limit
    );
    if let Some(through) = through {
        result.push_str(&format!("&through={through}"));
    }
    result
}

fn segment(problem: &str) -> String {
    // The accepted ASCII alphabet has no spaces or form-specific characters;
    // this matches the Worker's encodeURIComponent for colon-bearing IDs too.
    url::form_urlencoded::byte_serialize(problem.as_bytes()).collect()
}

fn exact_integer(text: &str, maximum: u64) -> Option<u64> {
    text.parse::<u64>()
        .ok()
        .filter(|n| *n <= maximum && n.to_string() == text)
}

struct Page {
    records: Vec<Value>,
    cursor: u64,
    through: u64,
    more: bool,
}

fn page(
    body: &str,
    args: &WatchArgs,
    since: u64,
    pin: Option<u64>,
    limits: &Limits,
) -> Option<Page> {
    let limit = args.limit.parse::<u64>().ok()?;
    if body.len() as u64 > MAX_BODY_BYTES
        || !body.ends_with('\n')
        || body.lines().count() as u64 > limit + 1
    {
        return None;
    }
    let records: Vec<Value> = body
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .ok()?;
    let end = records.last()?;
    let count = records.len().checked_sub(1)? as u64;
    let cursor = end["next_cursor"].as_u64()?;
    let through = end["through"].as_u64()?;
    let more = end["has_more"].as_bool()?;
    let omitted = end["omitted"].as_array()?;
    if !limits.end_schema.is_valid(end)
        || end["control"] != "page_end"
        || end["schema"] != limits.schema
        || end["problem_id"] != args.problem
        || end["since"].as_u64()? != since
        || count > limit
        || count > limits.events
        || cursor != since.checked_add(count)?
        || cursor > through
        || through > limits.cursor
        || pin.is_some_and(|pin| pin != through)
        || more != (cursor < through)
        || (more && count == 0)
        || omitted.len() as u64 > limits.omissions
        || omitted.iter().any(|v| v.as_str().is_none())
        || end["poll"] != path(args, cursor, None)
        || if more {
            end["next"] != path(args, cursor, Some(through))
        } else {
            !end["next"].is_null()
        }
    {
        return None;
    }
    for (index, record) in records[..records.len() - 1].iter().enumerate() {
        let event = record.get("event")?;
        let omitted = record["body_omitted"].as_str()?;
        if !limits.event_schema.is_valid(record)
            || record["record"] != "event"
            || record["problem_id"] != args.problem
            || record["seq"].as_u64()? != since + index as u64 + 1
            || !(event.is_null() || event.is_object())
            || !matches!(
                omitted,
                "separate_object_face" | "content_unavailable" | "undisclosed_event"
            )
            || event.is_null() != (omitted == "undisclosed_event")
        {
            return None;
        }
    }
    Some(Page {
        records,
        cursor,
        through,
        more,
    })
}

fn failure(since: u64, reason: &str) -> CliOutput {
    CliOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: format!(
            "asimp watch: {reason}\nResume the same watch command with --since {since}. Inspect asimp capabilities on the same origin if this persists.\n"
        ),
    }
}

fn read(
    url: &str,
    since: u64,
    fetch: &mut impl FnMut(&str) -> Result<Fetched, FetchError>,
) -> Result<String, CliOutput> {
    match fetch(url) {
        Ok(response) if response.status == 200 && response.body.len() as u64 <= MAX_BODY_BYTES => {
            Ok(response.body)
        }
        Ok(response) => Err(failure(
            since,
            &format!(
                "unexpected HTTP status {} or oversized response; no page was accepted.",
                response.status
            ),
        )),
        Err(FetchError::Status(status)) => Err(failure(
            since,
            &format!("HTTP {status}; the read was not retried automatically."),
        )),
        Err(_) => Err(failure(
            since,
            "the read failed its transport, encoding or byte bound; no partial page was accepted.",
        )),
    }
}

fn cursor_hint(
    origin: &str,
    since: u64,
    maximum: u64,
    fetch: &mut impl FnMut(&str) -> Result<Fetched, FetchError>,
) -> Result<u64, CliOutput> {
    let body = read(&format!("{origin}/cursor"), since, fetch)?;
    exact_integer(body.trim(), maximum).ok_or_else(|| {
        failure(
            since,
            "the public change hint is invalid; no resume position changed.",
        )
    })
}

/// Streaming entrypoint shared by the executable and the real-HTTP probe.
/// Fetches never acquire bearer/keychain authority. Writes and flushes a whole
/// validated page before advancing; a broken output pipe keeps the preceding
/// cursor so a consumer can discard an incomplete final page and safely resume.
pub fn run_with_io(
    cli: &Cli,
    mut fetch: impl FnMut(&str) -> Result<Fetched, FetchError>,
    output: &mut impl Write,
    mut sleep: impl FnMut(Duration),
) -> CliOutput {
    let Command::Watch(args) = &cli.command else {
        return input_error("Expected the watch command.");
    };
    let Some(limits) = limits() else {
        return input_error("Bundled event-tail contract is unavailable; rebuild asimp.");
    };
    let initial_cursor = exact_integer(&args.since, limits.cursor);
    let page_limit = exact_integer(&args.limit, limits.events).filter(|n| *n > 0);
    if args.problem.is_empty()
        || args.problem.len() > 128
        || !args.problem.as_bytes()[0].is_ascii_alphanumeric()
        || !args
            .problem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || initial_cursor.is_none()
        || page_limit.is_none()
    {
        return input_error(
            "Use a problem ID, an exact nonnegative safe-integer --since cursor, and --limit within the published event-tail bound; no request was sent.",
        );
    }
    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(v) => v,
        Err(_) => {
            return input_error("Choose a valid HTTPS --origin before watching public events.");
        }
    };
    let mut since = initial_cursor.unwrap_or(0);
    let mut pin = None;
    // Read the site-wide invalidation hint BEFORE the initial snapshot so a
    // write racing snapshot completion cannot disappear into a later baseline.
    // It never becomes a problem's since/through cursor.
    let mut hint = if args.once {
        None
    } else {
        match cursor_hint(&origin, since, limits.cursor, &mut fetch) {
            Ok(hint) => Some(hint),
            Err(error) => return error,
        }
    };
    loop {
        // All path bytes come from the validated component and numeric fields.
        // Do not relax the generic raw-GET encoded-path guard for this reader.
        let url = format!("{origin}{}", path(args, since, pin));
        let body = match read(&url, since, &mut fetch) {
            Ok(body) => body,
            Err(error) => return error,
        };
        let Some(page) = page(&body, args, since, pin, &limits) else {
            return failure(
                since,
                "incomplete or inconsistent event page; its bytes and cursor were not accepted.",
            );
        };
        let emitted = if args.json {
            output.write_all(body.as_bytes()).is_ok()
        } else {
            page.records.iter().all(|record| {
                serde_json::to_writer_pretty(&mut *output, record).is_ok()
                    && output.write_all(b"\n").is_ok()
            })
        };
        if !emitted || output.flush().is_err() {
            return failure(
                since,
                "output did not complete; discard any incomplete final page before resuming.",
            );
        }
        since = page.cursor;
        if page.more {
            pin = Some(page.through);
            continue;
        }
        if args.once {
            return CliOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        // No event-tail D1 reads while the site-wide hint is unchanged; at
        // most one cheap GET every two seconds. Cached hints may decrease or
        // reflect unrelated problems. Only a fresh tail defines this problem's
        // head, so wake with an unpinned tail without rewinding its cursor.
        loop {
            sleep(Duration::from_secs(2));
            let observed = match cursor_hint(&origin, since, limits.cursor, &mut fetch) {
                Ok(observed) => observed,
                Err(error) => return error,
            };
            if Some(observed) != hint {
                hint = Some(observed);
                pin = None;
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::json;

    fn cli(extra: &[&str]) -> Cli {
        Cli::try_parse_from(
            [
                vec![
                    "asimp",
                    "--origin",
                    "https://watch.example",
                    "watch",
                    "P-WATCH",
                ],
                extra.to_vec(),
            ]
            .concat(),
        )
        .unwrap()
    }

    fn wire(since: u64, count: u64, through: u64, limit: u16) -> String {
        let mut records = Vec::new();
        for seq in since + 1..=since + count {
            records.push(json!({"record":"event","problem_id":"P-WATCH","seq":seq,"event":null,"body_omitted":"undisclosed_event"}));
        }
        let cursor = since + count;
        let Command::Watch(args) = cli(&[]).command else {
            unreachable!()
        };
        let args = WatchArgs {
            limit: limit.to_string(),
            ..args
        };
        records.push(json!({"control":"page_end","schema":limits().unwrap().schema,"problem_id":"P-WATCH","since":since,"through":through,"next_cursor":cursor,"has_more":cursor<through,"next":if cursor<through {Some(path(&args,cursor,Some(through)))} else {None},"poll":path(&args,cursor,None),"omitted":["Bodies are separate; scientific standing is not asserted."]}));
        records.iter().map(|v| format!("{v}\n")).collect()
    }

    #[test]
    fn once_drains_the_fixed_snapshot_and_preserves_every_wire_byte() {
        let cli = cli(&["--once", "--json", "--limit", "2"]);
        let first = wire(0, 2, 3, 2);
        let second = wire(2, 1, 3, 2);
        let mut requests = Vec::new();
        let mut output = Vec::new();
        let result = run_with_io(
            &cli,
            |url| {
                requests.push(url.to_string());
                Ok(Fetched {
                    status: 200,
                    body: if requests.len() == 1 {
                        first.clone()
                    } else {
                        second.clone()
                    },
                })
            },
            &mut output,
            |_| panic!("once must not poll or sleep"),
        );
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.is_empty() && result.stderr.is_empty());
        assert_eq!(output, format!("{first}{second}").as_bytes());
        assert_eq!(
            requests,
            [
                "https://watch.example/p/P-WATCH/events.ndjson?since=0&limit=2",
                "https://watch.example/p/P-WATCH/events.ndjson?since=2&limit=2&through=3"
            ]
        );
    }

    #[test]
    fn colon_problem_ids_use_the_workers_encoded_component_without_changing_origin() {
        let mut cli = cli(&["--once", "--json"]);
        let Command::Watch(args) = &mut cli.command else {
            unreachable!()
        };
        args.problem = "P-WATCH:ONE".into();
        let mut output = Vec::new();
        let body = wire(0, 1, 1, 50)
            .replace("P-WATCH", "P-WATCH:ONE")
            .replace("/p/P-WATCH:ONE/", "/p/P-WATCH%3AONE/");
        let result = run_with_io(
            &cli,
            |url| {
                assert_eq!(
                    url,
                    "https://watch.example/p/P-WATCH%3AONE/events.ndjson?since=0&limit=50"
                );
                Ok(Fetched {
                    status: 200,
                    body: body.clone(),
                })
            },
            &mut output,
            |_| panic!("no poll"),
        );
        assert_eq!(result.exit_code, 0);
        assert_eq!(output, body.as_bytes());
    }

    #[test]
    fn idle_reads_only_the_global_hint_then_starts_a_new_problem_snapshot() {
        let mut urls = Vec::new();
        let mut sleeps = Vec::new();
        let mut output = Vec::new();
        let first = wire(0, 2, 2, 50);
        let later = wire(2, 1, 3, 50);
        let result = run_with_io(
            &cli(&["--json"]),
            |url| {
                urls.push(url.to_string());
                let body = match urls.len() {
                    1 => "20".into(),
                    2 => first.clone(),
                    3 => "20".into(),
                    4 => "21".into(),
                    5 => later.clone(),
                    _ => return Err(FetchError::Status(503)),
                };
                Ok(Fetched { status: 200, body })
            },
            &mut output,
            |duration| sleeps.push(duration),
        );
        assert_eq!(result.exit_code, 1);
        assert!(result.stderr.contains("--since 3"));
        assert_eq!(sleeps, vec![Duration::from_secs(2); 3]);
        assert_eq!(
            urls,
            [
                "https://watch.example/cursor",
                "https://watch.example/p/P-WATCH/events.ndjson?since=0&limit=50",
                "https://watch.example/cursor",
                "https://watch.example/cursor",
                "https://watch.example/p/P-WATCH/events.ndjson?since=2&limit=50",
                "https://watch.example/cursor"
            ]
        );
        assert_eq!(output, format!("{first}{later}").as_bytes());
    }

    #[test]
    fn incomplete_inconsistent_and_forged_pages_never_cross_the_output_boundary() {
        let good = wire(0, 1, 1, 50);
        let parsed: Vec<Value> = good
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let mut bad = vec![
            String::new(),
            good.lines().next().unwrap().to_string() + "\n",
            good.trim_end().to_owned(),
            "private-body-canary\n".into(),
            good.clone() + "{}\n",
        ];
        let mut malformed = parsed.clone();
        malformed[0]["event"] = json!({});
        malformed[0]["body_omitted"] = json!("separate_object_face");
        bad.push(malformed.iter().map(|v| format!("{v}\n")).collect());
        for (index, field, value) in [
            (0, "body", json!("private-extra-canary")),
            (1, "body", json!("private-extra-canary")),
            (1, "omitted", json!([""])),
        ] {
            let mut malformed = parsed.clone();
            malformed[index][field] = value;
            bad.push(malformed.iter().map(|v| format!("{v}\n")).collect());
        }
        let mut malformed = parsed.clone();
        malformed[1].as_object_mut().unwrap().remove("next");
        bad.push(malformed.iter().map(|v| format!("{v}\n")).collect());
        for (field, value) in [
            ("problem_id", json!("other")),
            ("schema", json!("wrong")),
            ("since", json!(1)),
            ("next_cursor", json!(2)),
            ("through", json!(0)),
            ("has_more", json!(true)),
            ("poll", json!("https://evil.test/token-canary")),
            ("next", json!("https://evil.test")),
            ("omitted", json!(null)),
        ] {
            let mut records = parsed.clone();
            records[1][field] = value;
            bad.push(records.iter().map(|v| format!("{v}\n")).collect());
        }
        for (field, value) in [
            ("seq", json!(2)),
            ("record", json!("page_end")),
            ("problem_id", json!("other")),
            ("body_omitted", json!("separate_object_face")),
        ] {
            let mut records = parsed.clone();
            records[0][field] = value;
            bad.push(records.iter().map(|v| format!("{v}\n")).collect());
        }
        for body in bad {
            let mut output = Vec::new();
            let result = run_with_io(
                &cli(&["--once", "--json"]),
                |_| {
                    Ok(Fetched {
                        status: 200,
                        body: body.clone(),
                    })
                },
                &mut output,
                |_| panic!("invalid page must stop"),
            );
            assert_eq!(result.exit_code, 1);
            assert!(output.is_empty() && result.stdout.is_empty());
            assert!(result.stderr.contains("--since 0"));
            assert!(!result.stderr.contains("canary") && !result.stderr.contains("evil.test"));
        }
    }

    #[test]
    fn cached_global_hint_changes_never_rewind_or_replace_the_problem_cursor() {
        let mut urls = Vec::new();
        let mut sleeps = 0;
        let mut output = Vec::new();
        let first = wire(0, 2, 2, 50);
        let empty = wire(2, 0, 2, 50);
        let result = run_with_io(
            &cli(&["--json"]),
            |url| {
                urls.push(url.to_string());
                let body = match urls.len() {
                    1 => "99".into(),
                    2 => first.clone(),
                    3 => "98".into(),
                    4 => empty.clone(),
                    5 => "99".into(),
                    6 => empty.clone(),
                    7 => "99".into(),
                    _ => return Err(FetchError::Status(503)),
                };
                Ok(Fetched { status: 200, body })
            },
            &mut output,
            |duration| {
                assert_eq!(duration, Duration::from_secs(2));
                sleeps += 1;
            },
        );
        assert_eq!(result.exit_code, 1);
        assert_eq!(sleeps, 4);
        assert!(result.stderr.contains("--since 2"));
        assert_eq!(
            urls.iter()
                .filter(|u| u.contains("events.ndjson?since=2&limit=50"))
                .count(),
            2
        );
        assert!(
            !urls
                .iter()
                .any(|u| u.contains("since=98") || u.contains("through=99"))
        );
        assert_eq!(output, format!("{first}{empty}{empty}").as_bytes());
    }

    #[test]
    fn a_failed_later_page_keeps_the_last_complete_page_and_resume_cursor() {
        let first = wire(0, 1, 2, 1);
        let mut calls = 0;
        let mut output = Vec::new();
        let result = run_with_io(
            &cli(&["--once", "--json", "--limit", "1"]),
            |_| {
                calls += 1;
                Ok(Fetched {
                    status: 200,
                    body: if calls == 1 {
                        first.clone()
                    } else {
                        wire(1, 1, 3, 1)
                    },
                })
            },
            &mut output,
            |_| panic!("no polling"),
        );
        assert_eq!(calls, 2);
        assert_eq!(result.exit_code, 1);
        assert_eq!(output, first.as_bytes());
        assert!(result.stderr.contains("--since 1"));
    }

    #[test]
    fn malformed_global_hint_and_http_failures_stop_without_retries() {
        for cursor in ["02", "1.5", "9007199254740992", "private-canary"] {
            let mut output = Vec::new();
            let mut count = 0;
            let result = run_with_io(
                &cli(&["--json"]),
                |_| {
                    count += 1;
                    Ok(Fetched {
                        status: 200,
                        body: match count {
                            1 => "0".into(),
                            2 => wire(0, 1, 1, 50),
                            _ => cursor.into(),
                        },
                    })
                },
                &mut output,
                |_| {},
            );
            assert_eq!(result.exit_code, 1);
            assert_eq!(count, 3);
            assert!(result.stderr.contains("--since 1"));
            assert!(!result.stderr.contains("canary"));
        }
        for status in [400, 401, 403, 404, 409, 422, 429, 500, 503] {
            let mut count = 0;
            let mut output = Vec::new();
            let result = run_with_io(
                &cli(&["--once"]),
                |_| {
                    count += 1;
                    Err(FetchError::Status(status))
                },
                &mut output,
                |_| panic!("no retry"),
            );
            assert_eq!(result.exit_code, 1);
            assert_eq!(count, 1);
            assert!(output.is_empty());
            assert!(result.stderr.contains(&format!("HTTP {status}")));
        }
    }

    #[test]
    fn invalid_inputs_and_byte_overflow_never_publish_or_acquire_authority() {
        for args in [vec!["--since", "9007199254740992"], vec!["--limit", "201"]] {
            let result = run_with_io(
                &cli(&args),
                |_| panic!("no fetch"),
                &mut Vec::new(),
                |_| panic!("no sleep"),
            );
            assert_eq!(result.exit_code, 2);
        }
        let mut output = Vec::new();
        let result = run_with_io(
            &cli(&["--once"]),
            |_| {
                Ok(Fetched {
                    status: 200,
                    body: "x".repeat(MAX_BODY_BYTES as usize + 1),
                })
            },
            &mut output,
            |_| {},
        );
        assert_eq!(result.exit_code, 1);
        assert!(output.is_empty());
        assert!(
            crate::token_for_command(&cli(&[]).command, || panic!(
                "public watch never reads credentials"
            ))
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn output_failure_cannot_advance_the_resume_cursor_and_human_json_is_safe() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let result = run_with_io(
            &cli(&["--once"]),
            |_| {
                Ok(Fetched {
                    status: 200,
                    body: wire(0, 1, 1, 50),
                })
            },
            &mut Broken,
            |_| {},
        );
        assert_eq!(result.exit_code, 1);
        assert!(result.stderr.contains("--since 0"));
        let mut output = Vec::new();
        let source = wire(0, 1, 1, 50);
        let result = run_with_io(
            &cli(&["--once"]),
            |_| {
                Ok(Fetched {
                    status: 200,
                    body: source.clone(),
                })
            },
            &mut output,
            |_| {},
        );
        assert_eq!(result.exit_code, 0);
        let values = serde_json::Deserializer::from_slice(&output)
            .into_iter::<Value>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let expected = source
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, expected);
    }

    #[test]
    #[ignore = "requires the real Worker journey: event-tails-real-bindings.mjs cli"]
    fn watch_real_http() {
        let input: Value =
            serde_json::from_str(&std::env::var("ASIMP_WATCH_PROBE").expect("real Worker probe"))
                .unwrap();
        let local = url::Url::parse(input["origin"].as_str().unwrap()).unwrap();
        assert_eq!(local.scheme(), "http");
        assert_eq!(local.host_str(), Some("127.0.0.1"));
        let mut args = vec![
            "asimp".into(),
            "--origin".into(),
            "https://watch.example".into(),
            "watch".into(),
            input["problem"].as_str().unwrap().into(),
            "--since".into(),
            input["since"].to_string(),
            "--limit".into(),
            input["limit"].to_string(),
        ];
        if input["live"] != true {
            args.push("--once".into());
        }
        if input["json"] == true {
            args.push("--json".into());
        }
        let parsed = Cli::try_parse_from(args).unwrap();
        let mut output = Vec::new();
        let result = run_with_io(
            &parsed,
            |url| {
                let target = url::Url::parse(url).unwrap();
                assert_eq!(
                    target.origin().ascii_serialization(),
                    "https://watch.example"
                );
                crate::fetch_text(&format!(
                    "{}{}{}",
                    local.as_str().trim_end_matches('/'),
                    target.path(),
                    target.query().map(|q| format!("?{q}")).unwrap_or_default()
                ))
            },
            &mut output,
            |duration| {
                assert_eq!(input["live"], true, "one snapshot cannot poll");
                std::thread::sleep(duration);
            },
        );
        if input["live"] == true {
            use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
            assert_eq!(
                result.exit_code, 1,
                "the deliberately closed bridge ends the live reader"
            );
            assert!(
                result
                    .stderr
                    .contains("Resume the same watch command with --since")
            );
            assert!(!String::from_utf8_lossy(&output).contains(input["canary"].as_str().unwrap()));
            println!("ASIMP_WATCH_BYTES={}", URL_SAFE_NO_PAD.encode(output));
            println!(
                "ASIMP_WATCH_RESUME={}",
                result.stderr.lines().nth(1).unwrap()
            );
            return;
        }
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
        assert!(result.stdout.is_empty() && result.stderr.is_empty());
        let pages = input["pages"].as_array().unwrap();
        if input["json"] == true {
            assert_eq!(
                output,
                pages
                    .iter()
                    .map(|p| p.as_str().unwrap())
                    .collect::<String>()
                    .as_bytes(),
                "full NDJSON including omissions matches curl bytes"
            );
        }
        let actual = serde_json::Deserializer::from_slice(&output)
            .into_iter::<Value>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let expected = pages
            .iter()
            .flat_map(|p| {
                p.as_str()
                    .unwrap()
                    .lines()
                    .map(|l| serde_json::from_str::<Value>(l).unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            actual, expected,
            "every sequence, placeholder, control and omission survives the parsed command"
        );
        assert!(
            !String::from_utf8(output)
                .unwrap()
                .contains(input["canary"].as_str().unwrap())
        );
    }
}
