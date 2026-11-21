//! Idempotent diagnostic doctor (`asimp doctor`, W11.4 / `asimposiumorg-jsj`).
//!
//! Covers every detectable failure class with a concrete, actionable
//! remediation line and never echoes secrets, tokens, or private bodies:
//!   1. Origin & URL validity
//!   2. Connectivity, protocol-version match, Deprecation/Sunset, & server clock skew
//!   3. Token validity & active credential identity (never echoes the secret tail)
//!   4. Local snapshot & spool cursor sanity vs live server head
//!   5. Spool health: permissions, secret-free audit log scan, and exact breakdown
//!      of `unsent`, `retryable` (`in_flight` within 24h), `committed`, `rejected`,
//!      and `unknown_commit` — stating which evidence resolves each state.

use crate::{
    Cli, CliOutput, Command, OUTBOUND_USER_AGENT, READ_TIMEOUT, build_url, enrollment, input_error,
    protocol::{
        DEFAULT_PROTOCOL_VERSION, DeprecationNotice, PROTOCOL_VERSION_HEADER,
        SUPPORTED_PROTOCOL_VERSIONS, check_capabilities_compatibility, inspect_success_headers,
        parse_unsupported_version_problem, resolve_protocol_version,
    },
    resolve_origin, scrub,
    spool::{
        REPLAY_WINDOW_SECONDS, SpoolState, format_utc_rfc3339, load_all_items, now_epoch_s,
        parse_http_date, resolve_spool_dir,
    },
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, clap::Args)]
pub struct DoctorArgs {
    /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
    #[arg(long, value_name = "DIR")]
    pub spool_dir: Option<PathBuf>,

    /// Local snapshot root created by `asimp pull` (default: .asimp).
    #[arg(long, default_value = ".asimp", value_name = "DIR")]
    pub snapshot_dir: PathBuf,

    /// Skip live HTTP probes and inspect only local configuration, snapshots, and spool health.
    #[arg(long)]
    pub offline: bool,

    /// Emit deterministic structured JSON diagnostic report.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
    Skipped,
}

impl CheckStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DoctorFinding {
    pub check: &'static str,
    pub status: CheckStatus,
    pub detail: String,
    pub remediation: Option<String>,
    pub meta: Value,
}

impl DoctorFinding {
    fn to_json(&self) -> Value {
        json!({
            "check": self.check,
            "status": self.status.as_str(),
            "detail": self.detail,
            "remediation": self.remediation,
            "meta": self.meta,
        })
    }
}

#[derive(Debug, Clone)]
pub struct DoctorProbeResponse {
    pub status: u16,
    pub body: String,
    pub server_version: Option<String>,
    pub deprecation: Option<String>,
    pub sunset: Option<String>,
    pub link: Option<String>,
    pub server_epoch_s: Option<u64>,
}

/// Extract ONLY the public non-secret ULID credential identifier segment from
/// `asimp_ag_<26-char-ULID>_<43-char-secret>`. Never returns secret bytes.
pub fn safe_credential_slot_label(token: &str) -> String {
    if let Some(rest) = token.strip_prefix("asimp_ag_")
        && let Some((ulid, secret)) = rest.split_once('_')
        && ulid.len() == 26
        && ulid.bytes().all(|b| b.is_ascii_alphanumeric())
        && !secret.is_empty()
    {
        return format!("cred:{ulid}");
    }
    "cred:custom-shape".to_owned()
}

fn http_probe_get(
    url: &str,
    protocol_version: &str,
    token: Option<&str>,
) -> Option<DoctorProbeResponse> {
    let agent = ureq::AgentBuilder::new()
        .user_agent(OUTBOUND_USER_AGENT)
        .timeout(READ_TIMEOUT)
        .timeout_connect(READ_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .redirects(0)
        .build();
    let mut req = agent
        .get(url)
        .set(PROTOCOL_VERSION_HEADER, protocol_version);
    if let Some(tok) = token {
        req = req.set("authorization", &format!("Bearer {tok}"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return None,
    };
    let status = resp.status();
    let server_version = resp.header(PROTOCOL_VERSION_HEADER).map(str::to_owned);
    let deprecation = resp.header("deprecation").map(str::to_owned);
    let sunset = resp.header("sunset").map(str::to_owned);
    let link = resp.header("link").map(str::to_owned);
    let server_epoch_s = resp.header("date").and_then(parse_http_date);
    let mut buf = Vec::new();
    let _ = resp.into_reader().take(256 * 1024).read_to_end(&mut buf);
    let body = String::from_utf8_lossy(&buf).into_owned();
    Some(DoctorProbeResponse {
        status,
        body,
        server_version,
        deprecation,
        sunset,
        link,
        server_epoch_s,
    })
}

pub fn run(cli: &Cli) -> CliOutput {
    let Command::Doctor(args) = &cli.command else {
        return input_error("Expected the doctor command.");
    };
    if args
        .snapshot_dir
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return input_error("--snapshot-dir must not contain '..' components.");
    }

    let token_state = match std::env::var("ASIMP_TOKEN") {
        Ok(val) => TokenSource::Env(val),
        Err(std::env::VarError::NotUnicode(_)) => TokenSource::InvalidEnv,
        Err(std::env::VarError::NotPresent) => match enrollment::stored_token(cli) {
            Ok(Some(t)) => TokenSource::Keychain(t),
            Ok(None) => TokenSource::Absent,
            Err(msg) => TokenSource::KeychainError(msg.to_owned()),
        },
    };

    run_with_io(cli, token_state, now_epoch_s(), http_probe_get)
}

#[derive(Debug, Clone)]
pub enum TokenSource {
    Env(String),
    Keychain(String),
    Absent,
    InvalidEnv,
    KeychainError(String),
}

pub fn run_with_io(
    cli: &Cli,
    token_source: TokenSource,
    local_epoch_s: u64,
    mut probe: impl FnMut(&str, &str, Option<&str>) -> Option<DoctorProbeResponse>,
) -> CliOutput {
    let Command::Doctor(args) = &cli.command else {
        return input_error("Expected the doctor command.");
    };
    let mut findings: Vec<DoctorFinding> = Vec::new();

    // 1. Origin check
    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(o) => {
            findings.push(DoctorFinding {
                check: "origin",
                status: CheckStatus::Ok,
                detail: format!("Configured HTTPS origin: {o}"),
                remediation: None,
                meta: json!({ "origin": o }),
            });
            Some(o)
        }
        Err(msg) => {
            findings.push(DoctorFinding {
                check: "origin",
                status: CheckStatus::Fail,
                detail: msg,
                remediation: Some(
                    "Pass `--origin https://a.asimposium.org` (or set valid HTTPS `ASIMP_ORIGIN`)."
                        .to_owned(),
                ),
                meta: json!({}),
            });
            None
        }
    };

    // 2. Client protocol version check
    let protocol_version = match resolve_protocol_version(cli.protocol_version.as_ref()) {
        Ok(v) => Some(v),
        Err(msg) => {
            findings.push(DoctorFinding {
                check: "protocol",
                status: CheckStatus::Fail,
                detail: msg,
                remediation: Some(format!(
                    "Omit `--protocol-version` or select one of: {}.",
                    SUPPORTED_PROTOCOL_VERSIONS.join(", ")
                )),
                meta: json!({ "supported_by_client": SUPPORTED_PROTOCOL_VERSIONS }),
            });
            None
        }
    };

    // 3. Connectivity + server protocol match + server clock skew
    let mut server_epoch_s: Option<u64> = None;
    let mut server_global_cursor: Option<u64> = None;

    if args.offline {
        findings.push(DoctorFinding {
            check: "connectivity",
            status: CheckStatus::Skipped,
            detail: "Skipped live connectivity probe (--offline).".to_owned(),
            remediation: None,
            meta: json!({ "offline": true }),
        });
    } else if let (Some(orig), Some(proto)) = (&origin, &protocol_version) {
        let cap_url = build_url(orig, "/capabilities").ok();
        match cap_url.and_then(|u| probe(&u, proto, None)) {
            None => {
                findings.push(DoctorFinding {
                    check: "connectivity",
                    status: CheckStatus::Fail,
                    detail: format!("Cannot reach {orig}/capabilities."),
                    remediation: Some(format!(
                        "Verify network/DNS connectivity to {orig} and run `asimp --origin {orig} capabilities --json`."
                    )),
                    meta: json!({ "origin": orig }),
                });
            }
            Some(resp) => {
                server_epoch_s = resp.server_epoch_s;
                if resp.status == 400
                    && let Some(mismatch) =
                        parse_unsupported_version_problem(proto, resp.status, Some(&resp.body))
                {
                    findings.push(DoctorFinding {
                        check: "protocol",
                        status: CheckStatus::Fail,
                        detail: format!(
                            "Server rejected protocol version '{proto}' (server supports: {}).",
                            mismatch.supported_by_server.join(", ")
                        ),
                        remediation: Some(
                            "Upgrade `asimp` or select a mutually supported `--protocol-version`."
                                .to_owned(),
                        ),
                        meta: json!({
                            "requested": proto,
                            "server_supported": mismatch.supported_by_server,
                        }),
                    });
                } else if resp.status != 200 {
                    findings.push(DoctorFinding {
                        check: "connectivity",
                        status: CheckStatus::Fail,
                        detail: format!("/capabilities returned HTTP {}.", resp.status),
                        remediation: Some(format!(
                            "Check Worker availability on {orig} or retry shortly."
                        )),
                        meta: json!({ "http_status": resp.status }),
                    });
                } else {
                    findings.push(DoctorFinding {
                        check: "connectivity",
                        status: CheckStatus::Ok,
                        detail: format!("Connected to {orig}/capabilities (HTTP 200)."),
                        remediation: None,
                        meta: json!({
                            "http_status": 200,
                            "server_time": resp.server_epoch_s.map(format_utc_rfc3339),
                        }),
                    });
                    match inspect_success_headers(
                        proto,
                        resp.server_version.as_deref(),
                        resp.deprecation.as_deref(),
                        resp.sunset.as_deref(),
                        resp.link.as_deref(),
                    ) {
                        Err(mismatch) => {
                            findings.push(DoctorFinding {
                                check: "protocol",
                                status: CheckStatus::Fail,
                                detail: format!(
                                    "Incompatible server protocol version '{}'.",
                                    mismatch.server_version.as_deref().unwrap_or("<unknown>")
                                ),
                                remediation: Some(format!(
                                    "Upgrade `asimp`; this build supports {}.",
                                    SUPPORTED_PROTOCOL_VERSIONS.join(", ")
                                )),
                                meta: json!({
                                    "server_version": mismatch.server_version,
                                    "client_supported": SUPPORTED_PROTOCOL_VERSIONS,
                                }),
                            });
                        }
                        Ok(Some(notice)) => {
                            findings.push(DoctorFinding {
                                check: "protocol",
                                status: CheckStatus::Warn,
                                detail: DeprecationNotice::render_stderr(&notice).trim().to_owned(),
                                remediation: Some(format!(
                                    "Switch to `--protocol-version {DEFAULT_PROTOCOL_VERSION}` or omit the flag."
                                )),
                                meta: json!({
                                    "protocol_version": notice.protocol_version,
                                    "deprecation": notice.deprecation,
                                    "sunset": notice.sunset,
                                }),
                            });
                        }
                        Ok(None) => {
                            if let Err(mismatch) = check_capabilities_compatibility(&resp.body) {
                                findings.push(DoctorFinding {
                                    check: "protocol",
                                    status: CheckStatus::Fail,
                                    detail: format!(
                                        "/capabilities advertises incompatible versions: {}.",
                                        mismatch.supported_by_server.join(", ")
                                    ),
                                    remediation: Some("Upgrade `asimp` to match the deployed Worker protocol.".to_owned()),
                                    meta: json!({ "server_supported": mismatch.supported_by_server }),
                                });
                            } else {
                                findings.push(DoctorFinding {
                                    check: "protocol",
                                    status: CheckStatus::Ok,
                                    detail: format!("Protocol version '{proto}' matches server."),
                                    remediation: None,
                                    meta: json!({
                                        "negotiated": resp.server_version.as_deref().unwrap_or(proto),
                                        "client_supported": SUPPORTED_PROTOCOL_VERSIONS,
                                    }),
                                });
                            }
                        }
                    }

                    // Server clock skew check (> 5 minutes skew matters for 24h replay window)
                    if let Some(srv_s) = server_epoch_s {
                        let skew_s = srv_s.abs_diff(local_epoch_s);
                        if skew_s > 300 {
                            findings.push(DoctorFinding {
                                check: "clock_skew",
                                status: CheckStatus::Warn,
                                detail: format!(
                                    "Local clock differs from server Date by {skew_s}s; `asimp sync` uses server timestamps for the 24h replay window."
                                ),
                                remediation: Some(
                                    "Synchronize system clock (NTP/chrony) so offline `client_occurred_at` provenance stamps remain accurate."
                                        .to_owned(),
                                ),
                                meta: json!({
                                    "skew_seconds": skew_s,
                                    "server_time": format_utc_rfc3339(srv_s),
                                    "local_time": format_utc_rfc3339(local_epoch_s),
                                }),
                            });
                        }
                    }
                }
            }
        }

        // Probe global cursor `/cursor`
        if let Some(cur_url) = build_url(orig, "/cursor").ok()
            && let Some(resp) = probe(&cur_url, proto, None)
            && resp.status == 200
            && let Ok(val) = resp.body.trim().parse::<u64>()
        {
            server_global_cursor = Some(val);
        }
    }

    // 4. Token validity & active credential identity check
    let active_token: Option<(&str, &'static str)> = match &token_source {
        TokenSource::Env(t) => Some((t.as_str(), "ASIMP_TOKEN")),
        TokenSource::Keychain(t) => Some((t.as_str(), "os-keychain")),
        TokenSource::Absent => {
            findings.push(DoctorFinding {
                check: "auth",
                status: CheckStatus::Warn,
                detail: "No Fellow credential configured (public reads work; writes require enrollment).".to_owned(),
                remediation: Some(
                    "Set `ASIMP_TOKEN` or enroll with `asimp connect --join-url-file ...` / `asimp login --device ...`."
                        .to_owned(),
                ),
                meta: json!({ "configured": false, "max_active_credentials_per_fellow": 3 }),
            });
            None
        }
        TokenSource::InvalidEnv => {
            findings.push(DoctorFinding {
                check: "auth",
                status: CheckStatus::Fail,
                detail: "ASIMP_TOKEN environment variable is not valid UTF-8.".to_owned(),
                remediation: Some(
                    "Unset or export a valid UTF-8 `asimp_ag_...` Fellow token.".to_owned(),
                ),
                meta: json!({ "source": "ASIMP_TOKEN" }),
            });
            None
        }
        TokenSource::KeychainError(msg) => {
            findings.push(DoctorFinding {
                check: "auth",
                status: CheckStatus::Warn,
                detail: format!("OS keychain check failed: {msg}"),
                remediation: Some(
                    "Unlock your OS keychain or supply `ASIMP_TOKEN` explicitly on headless hosts."
                        .to_owned(),
                ),
                meta: json!({ "source": "os-keychain" }),
            });
            None
        }
    };

    if let Some((tok, source)) = active_token {
        let slot_label = safe_credential_slot_label(tok);
        let transport_ok =
            !tok.is_empty() && tok.len() <= 4096 && tok.bytes().all(|b| (33..=126).contains(&b));
        if !transport_ok {
            findings.push(DoctorFinding {
                check: "auth",
                status: CheckStatus::Fail,
                detail: format!("Configured token from {source} contains spaces or control characters."),
                remediation: Some(
                    "Replace the credential with a clean `asimp_ag_...` token (no newlines or whitespace)."
                        .to_owned(),
                ),
                meta: json!({ "source": source, "credential_slot": slot_label }),
            });
        } else if args.offline {
            findings.push(DoctorFinding {
                check: "auth",
                status: CheckStatus::Ok,
                detail: format!(
                    "Token present ({slot_label} via {source}, <= 3 active credentials per Fellow); live `/v1/hello` skipped (--offline)."
                ),
                remediation: None,
                meta: json!({
                    "source": source,
                    "credential_slot": slot_label,
                    "live_verified": false,
                    "max_active_credentials_per_fellow": 3,
                }),
            });
        } else if let (Some(orig), Some(proto)) = (&origin, &protocol_version) {
            let hello_url = build_url(orig, "/v1/hello").ok();
            match hello_url.and_then(|u| probe(&u, proto, Some(tok))) {
                None => {
                    findings.push(DoctorFinding {
                        check: "auth",
                        status: CheckStatus::Fail,
                        detail: format!("Cannot reach {orig}/v1/hello to verify {slot_label}."),
                        remediation: Some(format!(
                            "Verify connectivity to {orig} and re-run `asimp hello --json`."
                        )),
                        meta: json!({ "source": source, "credential_slot": slot_label }),
                    });
                }
                Some(resp) if resp.status == 200 => {
                    let parsed = serde_json::from_str::<Value>(&resp.body).ok();
                    let fellow_id = parsed
                        .as_ref()
                        .and_then(|v| v.pointer("/fellow/fellow_id"))
                        .and_then(Value::as_str);
                    let fellow_name = parsed
                        .as_ref()
                        .and_then(|v| v.pointer("/fellow/name"))
                        .and_then(Value::as_str);
                    let proto_acked = parsed
                        .as_ref()
                        .and_then(|v| v.get("protocol_acknowledged"))
                        .and_then(Value::as_bool);
                    let open_sessions = parsed
                        .as_ref()
                        .and_then(|v| v.get("open_sessions"))
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    let (status, remediation) = if proto_acked == Some(false) {
                        (
                            CheckStatus::Warn,
                            Some("Acknowledge the current protocol digest shown by `asimp hello --json` before promoting.".to_owned()),
                        )
                    } else {
                        (CheckStatus::Ok, None)
                    };
                    findings.push(DoctorFinding {
                        check: "auth",
                        status,
                        detail: format!(
                            "Active credential {slot_label} ({source}) authenticated as {} ({}); open_sessions={open_sessions} (<= 3 active credentials allowed per Fellow).",
                            fellow_id.unwrap_or("<fellow>"),
                            fellow_name.unwrap_or("<unnamed>")
                        ),
                        remediation,
                        meta: json!({
                            "source": source,
                            "credential_slot": slot_label,
                            "fellow_id": fellow_id,
                            "fellow_name": fellow_name,
                            "open_sessions": open_sessions,
                            "protocol_acknowledged": proto_acked,
                            "max_active_credentials_per_fellow": 3,
                        }),
                    });
                }
                Some(resp) if resp.status == 401 || resp.status == 403 => {
                    findings.push(DoctorFinding {
                        check: "auth",
                        status: CheckStatus::Fail,
                        detail: format!(
                            "Credential {slot_label} ({source}) was rejected with HTTP {} (revoked, expired, or paused Fellow).",
                            resp.status
                        ),
                        remediation: Some(
                            "Check sponsor console approval/revocation status or mint a replacement Fellow credential (up to 3 active per Fellow)."
                                .to_owned(),
                        ),
                        meta: json!({
                            "source": source,
                            "credential_slot": slot_label,
                            "http_status": resp.status,
                        }),
                    });
                }
                Some(resp) => {
                    findings.push(DoctorFinding {
                        check: "auth",
                        status: CheckStatus::Warn,
                        detail: format!("/v1/hello returned unexpected HTTP {}.", resp.status),
                        remediation: Some("Retry `asimp hello --json` shortly.".to_owned()),
                        meta: json!({
                            "source": source,
                            "credential_slot": slot_label,
                            "http_status": resp.status,
                        }),
                    });
                }
            }
        }
    }

    // 5. Cursor sanity vs server (local `.asimp/problems/*/meta.json` + spool cursors)
    let spool_dir = resolve_spool_dir(args.spool_dir.as_ref()).ok();
    check_cursors(
        &args.snapshot_dir,
        spool_dir.as_deref(),
        origin.as_deref(),
        protocol_version.as_deref(),
        args.offline,
        server_global_cursor,
        &mut probe,
        &mut findings,
    );

    // 6. Spool health (permissions, secret-free logs, exact 5-state classification)
    let effective_now = server_epoch_s.unwrap_or(local_epoch_s);
    if let Some(dir) = &spool_dir {
        check_spool_health(dir, effective_now, &mut findings);
    } else {
        findings.push(DoctorFinding {
            check: "spool",
            status: CheckStatus::Warn,
            detail: "Cannot resolve default spool directory (~/.asimp/spool).".to_owned(),
            remediation: Some("Pass `--spool-dir <DIR>` or set `ASIMP_SPOOL_DIR`.".to_owned()),
            meta: json!({}),
        });
    }

    let has_fail = findings.iter().any(|f| f.status == CheckStatus::Fail);
    let has_warn = findings.iter().any(|f| f.status == CheckStatus::Warn);
    let exit_code = if has_fail || has_warn { 1 } else { 0 };

    if args.json {
        let doc = json!({
            "schema": "asimp.doctor.v1",
            "ok": !has_fail && !has_warn,
            "has_failures": has_fail,
            "has_warnings": has_warn,
            "findings": findings.iter().map(DoctorFinding::to_json).collect::<Vec<_>>(),
        });
        return CliOutput {
            exit_code,
            stdout: format!(
                "{}\n",
                serde_json::to_string_pretty(&doc).unwrap_or_default()
            ),
            stderr: String::new(),
        };
    }

    let mut out = String::new();
    for f in &findings {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            f.status.as_str().to_uppercase(),
            f.check,
            f.detail
        ));
        if let Some(rem) = &f.remediation {
            out.push_str(&format!("  fix: {rem}\n"));
        }
    }
    CliOutput {
        exit_code,
        stdout: out,
        stderr: String::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn check_cursors(
    snapshot_dir: &Path,
    spool_dir: Option<&Path>,
    origin: Option<&str>,
    protocol_version: Option<&str>,
    offline: bool,
    server_global_cursor: Option<u64>,
    probe: &mut impl FnMut(&str, &str, Option<&str>) -> Option<DoctorProbeResponse>,
    findings: &mut Vec<DoctorFinding>,
) {
    let mut tracked: Vec<(String, u64, &'static str)> = Vec::new();
    let problems_dir = snapshot_dir.join("problems");
    if let Ok(entries) = fs::read_dir(&problems_dir) {
        for entry in entries.flatten() {
            let meta_path = entry.path().join("meta.json");
            if let Ok(raw) = fs::read_to_string(&meta_path)
                && let Ok(v) = serde_json::from_str::<Value>(&raw)
                && let (Some(pid), Some(cur)) = (
                    v.get("problem_id").and_then(Value::as_str),
                    v.get("final_cursor").and_then(Value::as_u64),
                )
            {
                tracked.push((pid.to_owned(), cur, "snapshot"));
            }
        }
    }
    if let Some(dir) = spool_dir
        && let Ok(entries) = fs::read_dir(dir.join("cursors"))
    {
        for entry in entries.flatten() {
            if let Ok(raw) = fs::read_to_string(entry.path())
                && let Ok(v) = serde_json::from_str::<Value>(&raw)
                && let (Some(pid), Some(cur)) = (
                    v.get("problem_id").and_then(Value::as_str),
                    v.get("cursor").and_then(Value::as_u64),
                )
            {
                tracked.push((pid.to_owned(), cur, "spool-cursor"));
            }
        }
    }
    tracked.sort();

    if tracked.is_empty() {
        findings.push(DoctorFinding {
            check: "cursors",
            status: CheckStatus::Ok,
            detail: match server_global_cursor {
                Some(g) => {
                    format!("No local problem cursors stored yet (server global cursor={g}).")
                }
                None => "No local problem cursors stored yet.".to_owned(),
            },
            remediation: None,
            meta: json!({ "tracked_count": 0, "server_global_cursor": server_global_cursor }),
        });
        return;
    }

    let mut anomalies = 0usize;
    let mut behind = 0usize;
    for (pid, local_cursor, kind) in &tracked {
        if offline {
            continue;
        }
        let (Some(orig), Some(proto)) = (origin, protocol_version) else {
            continue;
        };
        let path = format!("/p/{pid}/events.ndjson?since=0&limit=1");
        let Some(url) = build_url(orig, &path).ok() else {
            continue;
        };
        let Some(resp) = probe(&url, proto, None) else {
            continue;
        };
        if resp.status == 200 {
            let server_through = resp
                .body
                .lines()
                .last()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .and_then(|v| v.get("through").and_then(Value::as_u64));
            if let Some(through) = server_through {
                if *local_cursor > through {
                    anomalies += 1;
                    findings.push(DoctorFinding {
                        check: "cursors",
                        status: CheckStatus::Fail,
                        detail: format!(
                            "Local {kind} cursor for {pid} ({local_cursor}) is AHEAD of server head ({through}) — corrupted cursor or wrong origin."
                        ),
                        remediation: Some(format!(
                            "Reset via `asimp pull {pid} --force` or `asimp spool cursor-set {pid} {through}`."
                        )),
                        meta: json!({
                            "problem_id": pid,
                            "kind": kind,
                            "local_cursor": local_cursor,
                            "server_through": through,
                        }),
                    });
                } else if *local_cursor < through {
                    behind += 1;
                    findings.push(DoctorFinding {
                        check: "cursors",
                        status: CheckStatus::Warn,
                        detail: format!(
                            "Local {kind} for {pid} is behind server ({local_cursor} < {through})."
                        ),
                        remediation: Some(format!(
                            "Refresh with `asimp pull {pid}` or `asimp watch {pid} --since {local_cursor} --once`."
                        )),
                        meta: json!({
                            "problem_id": pid,
                            "kind": kind,
                            "local_cursor": local_cursor,
                            "server_through": through,
                        }),
                    });
                }
            }
        }
    }

    if anomalies == 0 && behind == 0 {
        findings.push(DoctorFinding {
            check: "cursors",
            status: CheckStatus::Ok,
            detail: format!(
                "All {} tracked local cursor(s) are sane{}.",
                tracked.len(),
                if offline { " (offline)" } else { " vs server" }
            ),
            remediation: None,
            meta: json!({
                "tracked_count": tracked.len(),
                "server_global_cursor": server_global_cursor,
            }),
        });
    }
}

fn check_spool_health(spool_dir: &Path, effective_now: u64, findings: &mut Vec<DoctorFinding>) {
    // 1. Check Unix permissions if spool dir exists
    #[cfg(unix)]
    if spool_dir.exists() {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(spool_dir) {
            let mode = meta.permissions().mode() & 0o777;
            if (mode & 0o077) != 0 {
                findings.push(DoctorFinding {
                    check: "spool_permissions",
                    status: CheckStatus::Warn,
                    detail: format!(
                        "Spool directory permissions are {:04o}; group/world access should be disabled.",
                        mode
                    ),
                    remediation: Some(format!("Run `chmod 700 {}`.", spool_dir.display())),
                    meta: json!({ "mode_octal": format!("{mode:04o}") }),
                });
            }
        }
    }

    // 2. Verify spool audit logs are secret-free
    let log_path = spool_dir.join("logs").join("spool.jsonl");
    if log_path.is_file()
        && let Ok(raw_log) = fs::read_to_string(&log_path)
    {
        let secret_hits = scrub::scan_field_for_credentials("spool_log", &raw_log);
        if !secret_hits.is_empty() {
            findings.push(DoctorFinding {
                check: "spool_logs",
                status: CheckStatus::Fail,
                detail: format!(
                    "Spool audit log contains {} secret-shaped finding(s)!",
                    secret_hits.len()
                ),
                remediation: Some(
                    "Inspect redacted locations with `asimp scrub <spool>/logs/spool.jsonl`, rotate any leaked credential, and archive/replace the log."
                        .to_owned(),
                ),
                meta: json!({ "secret_findings_count": secret_hits.len() }),
            });
        } else {
            findings.push(DoctorFinding {
                check: "spool_logs",
                status: CheckStatus::Ok,
                detail: "Spool audit log verified secret-free.".to_owned(),
                remediation: None,
                meta: json!({ "secret_findings_count": 0 }),
            });
        }
    }

    // 3. Categorize every spool item into exact truth-table buckets
    let items = match load_all_items(spool_dir) {
        Ok(list) => list,
        Err(msg) => {
            findings.push(DoctorFinding {
                check: "spool",
                status: CheckStatus::Fail,
                detail: msg,
                remediation: Some(
                    "Check filesystem permissions on the spool directory.".to_owned(),
                ),
                meta: json!({}),
            });
            return;
        }
    };

    let mut unsent = 0usize;
    let mut retryable = 0usize;
    let mut expired_in_flight = 0usize;
    let mut committed = 0usize;
    let mut rejected = 0usize;
    let mut unknown_commit = 0usize;

    for item in &items {
        match item.state {
            SpoolState::Unsent => unsent += 1,
            SpoolState::InFlight => {
                let started = item.first_attempted_epoch_s.unwrap_or(item.created_epoch_s);
                if effective_now.saturating_sub(started) >= REPLAY_WINDOW_SECONDS {
                    expired_in_flight += 1;
                } else {
                    retryable += 1;
                }
            }
            SpoolState::Committed => committed += 1,
            SpoolState::Rejected => rejected += 1,
            SpoolState::UnknownCommit => unknown_commit += 1,
        }
    }

    let total_unknown = unknown_commit + expired_in_flight;
    let status = if total_unknown > 0 {
        CheckStatus::Fail
    } else if retryable > 0 || rejected > 0 || unsent > 0 {
        CheckStatus::Warn
    } else {
        CheckStatus::Ok
    };

    let remediation = if total_unknown > 0 {
        Some(
            "One or more writes passed the 24h replay window without confirmation (`unknown_commit`). Run `asimp spool list --state unknown_commit` and `asimp spool show <ID>` to inspect read-only server state (session status / workshop list / watch), then run `asimp spool resolve <ID> --as committed --event-id <EV-ID>` or `--as abandoned`. Never rotate keys blindly."
                .to_owned(),
        )
    } else if retryable > 0 || unsent > 0 {
        Some(
            "Run `asimp sync` to send unsent items and replay in-window retryable items with their exact original idempotency keys."
                .to_owned(),
        )
    } else if rejected > 0 {
        Some(
            "Inspect rejected items with `asimp spool list --state rejected`; fix the payload into a new logical write with a new key (never retry unchanged rejected payloads)."
                .to_owned(),
        )
    } else {
        None
    };

    let evidence_guide = json!({
        "unsent": "Never attempted; resolved by running `asimp sync` (idempotency key assigned on first send even if drafted > 24h ago).",
        "retryable": "Attempted within 24h replay window; resolved by `asimp sync` replaying the exact original idempotency key or matching receipt/event/cursor/object digest.",
        "committed": "Authoritatively confirmed by server 2xx receipt or recorded server_event_id; no action needed.",
        "rejected": "Definitively refused by server (4xx); resolved only by editing into a new logical write with a new idempotency key.",
        "unknown_commit": "24h replay window expired without authoritative match; resolved ONLY by checking read-only server state (session status, workshop list, watch events) and running `asimp spool resolve <ID> --as committed --event-id <EV-ID>` or `--as abandoned`.",
    });

    findings.push(DoctorFinding {
        check: "spool",
        status,
        detail: format!(
            "Spool state: unsent={unsent} retryable={retryable} committed={committed} rejected={rejected} unknown_commit={total_unknown}."
        ),
        remediation,
        meta: json!({
            "unsent": unsent,
            "retryable": retryable,
            "committed": committed,
            "rejected": rejected,
            "unknown_commit": total_unknown,
            "expired_pending_freeze": expired_in_flight,
            "resolution_evidence": evidence_guide,
        }),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spool::{SpoolItem, save_item};
    use clap::Parser;

    #[test]
    fn credential_slot_label_never_echoes_secret_tail() {
        let token = format!(
            "asimp_ag_{}_{}",
            "0123456789ABCDEFGHJKMNPQRS",
            "S".repeat(43)
        );
        let label = safe_credential_slot_label(&token);
        assert_eq!(label, "cred:0123456789ABCDEFGHJKMNPQRS");
        assert!(!label.contains("SSSS"));
    }

    #[test]
    fn doctor_distinguishes_all_five_spool_states_and_never_echoes_tokens() {
        let base = std::env::temp_dir().join(format!("asimp-doctor-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let spool = base.join("spool");
        let snap = base.join("snap");
        fs::create_dir_all(&snap).unwrap();

        let make_item = |id: &str, state: SpoolState, attempted: Option<u64>| SpoolItem {
            id: id.into(),
            origin: "https://example.test".into(),
            path: "/v1/sessions/S-1/promote".into(),
            session_id: Some("S-1".into()),
            problem_id: Some("P-4DSP".into()),
            state,
            idempotency_key: Some(format!("key-{id}")),
            body_json: "{}".into(),
            body_sha256: "0".repeat(64),
            client_occurred_at: "2026-09-10T00:00:00Z".into(),
            created_epoch_s: 1_000,
            first_attempted_epoch_s: attempted,
            first_attempted_clock: attempted.map(|_| "server".into()),
            attempts: u32::from(attempted.is_some()),
            last_http_status: None,
            last_error_code: None,
            receipt_sha256: None,
            server_event_id: None,
            server_object_id: None,
            resolution_note: None,
        };
        save_item(&spool, &make_item("SP-1-unsent", SpoolState::Unsent, None)).unwrap();
        save_item(
            &spool,
            &make_item("SP-2-retry", SpoolState::InFlight, Some(100_000)),
        )
        .unwrap();
        save_item(
            &spool,
            &make_item("SP-3-commit", SpoolState::Committed, Some(90_000)),
        )
        .unwrap();
        save_item(
            &spool,
            &make_item("SP-4-reject", SpoolState::Rejected, Some(90_000)),
        )
        .unwrap();
        save_item(
            &spool,
            &make_item("SP-5-unknown", SpoolState::UnknownCommit, Some(1_000)),
        )
        .unwrap();

        let token = format!(
            "asimp_ag_{}_{}",
            "0123456789ABCDEFGHJKMNPQRS",
            "Z".repeat(43)
        );
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "doctor",
            "--spool-dir",
            spool.to_str().unwrap(),
            "--snapshot-dir",
            snap.to_str().unwrap(),
            "--json",
        ])
        .unwrap();

        let out = run_with_io(
            &cli,
            TokenSource::Env(token.clone()),
            101_000,
            |url, _, _| {
                if url.ends_with("/capabilities") {
                    Some(DoctorProbeResponse {
                    status: 200,
                    body: r#"{"version":"0.2.0-draft","supported_protocol_versions":["0.2.0-draft","0.1.0"]}"#.into(),
                    server_version: Some("0.2.0-draft".into()),
                    deprecation: None,
                    sunset: None,
                    link: None,
                    server_epoch_s: Some(101_000),
                })
                } else if url.ends_with("/v1/hello") {
                    Some(DoctorProbeResponse {
                    status: 200,
                    body: r#"{"fellow":{"fellow_id":"F-1","name":"amber-owl"},"protocol_acknowledged":true,"open_sessions":[]}"#.into(),
                    server_version: Some("0.2.0-draft".into()),
                    deprecation: None,
                    sunset: None,
                    link: None,
                    server_epoch_s: Some(101_000),
                })
                } else {
                    Some(DoctorProbeResponse {
                        status: 200,
                        body: "42".into(),
                        server_version: Some("0.2.0-draft".into()),
                        deprecation: None,
                        sunset: None,
                        link: None,
                        server_epoch_s: Some(101_000),
                    })
                }
            },
        );

        assert_eq!(out.exit_code, 1); // unknown_commit triggers fail finding
        assert!(!out.stdout.contains(&token));
        assert!(!out.stdout.contains("ZZZZ"));
        let doc: Value = serde_json::from_str(&out.stdout).unwrap();
        let spool_finding = doc["findings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["check"] == "spool")
            .expect("spool finding");
        assert_eq!(spool_finding["status"], "fail");
        assert_eq!(spool_finding["meta"]["unsent"], 1);
        assert_eq!(spool_finding["meta"]["retryable"], 1);
        assert_eq!(spool_finding["meta"]["committed"], 1);
        assert_eq!(spool_finding["meta"]["rejected"], 1);
        assert_eq!(spool_finding["meta"]["unknown_commit"], 1);
        assert!(
            spool_finding["remediation"]
                .as_str()
                .unwrap()
                .contains("24h")
        );

        let _ = fs::remove_dir_all(&base);
    }
}
