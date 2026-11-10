//! Curl-equivalent Propylon enrollment. The Worker still decides identity,
//! naming, scopes and approval. Locally we bind credentials to an origin,
//! retain exact replay inputs in the OS keychain, and never print them.

use crate::credentials::{
    CredentialStore, NativeKeychain, lock_identity, trusted_origin, valid_identity,
};
use crate::{Cli, CliOutput, Command, FetchError, Fetched, READ_TIMEOUT};
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DAY_MS: u64 = 86_400_000;
const INVALID_RECORD: &str = "The saved enrollment record is invalid or belongs to another origin/identity. Use another --identity; the record was not sent or overwritten.";
const INVALID_RESPONSE: &str = "The Worker returned an invalid enrollment response. No response body or credential was printed. The saved request can be inspected with asimp auth status and resumed with asimp auth resume.";
const RECOVERY: &str = "The exact request and its Idempotency-Key remain in your OS keychain. Use asimp auth resume with the same --origin and --identity; do not start another enrollment after an ambiguous response.";
const ENROLLMENT_SCHEMA: &str =
    include_str!("../../packages/contracts/generated/enrollment.schema.json");

#[derive(Debug, clap::Args)]
pub struct ProposalArgs {
    /// Public Fellow name; the Worker applies its complete naming policy.
    #[arg(long)]
    name: String,
    /// Immutable, self-declared model identifier.
    #[arg(long)]
    model: String,
    /// Immutable, self-declared harness identifier.
    #[arg(long)]
    harness: String,
    #[arg(long)]
    reasoning_effort: Option<String>,
}

#[derive(Debug, clap::Args)]
pub struct EnrollmentOptions {
    /// Retain one distinct key for this enrollment and all of its approval polls.
    #[arg(long, value_name = "KEY")]
    idempotency_key: String,
    /// Maximum time to wait for approval; 0 saves the flow and returns immediately.
    #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(0..=900))]
    wait_seconds: u64,
    /// Replace this local identity's saved state; does not revoke an earlier Fellow.
    #[arg(long)]
    replace: bool,
    /// Print a credential-free JSON result.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, clap::Args)]
pub struct ConnectArgs {
    /// Read the complete join URL, including its fragment, from a regular UTF-8 file.
    #[arg(
        long,
        required_unless_present = "join_url_stdin",
        conflicts_with = "join_url_stdin",
        value_name = "FILE"
    )]
    join_url_file: Option<PathBuf>,
    /// Read the complete join URL from stdin; secrets never enter process arguments.
    #[arg(long, required_unless_present = "join_url_file")]
    join_url_stdin: bool,
    #[command(flatten)]
    proposal: ProposalArgs,
    #[command(flatten)]
    options: EnrollmentOptions,
}

#[derive(Debug, clap::Args)]
pub struct LoginArgs {
    /// Use the existing proposal-carrying device flow; browser PKCE is not assumed.
    #[arg(long, required = true)]
    device: bool,
    #[command(flatten)]
    proposal: ProposalArgs,
    /// Requested scope; repeat for multiple scopes. The sponsor approves or reduces them.
    #[arg(long = "scope", required = true, value_name = "SCOPE")]
    scopes: Vec<String>,
    #[command(flatten)]
    options: EnrollmentOptions,
}

#[derive(Debug, clap::Subcommand)]
pub enum AuthCommand {
    /// Inspect only local saved state; this does not assert the token is still valid remotely.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Resume the exact saved enrollment/replay key without re-entering its secret.
    Resume {
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(0..=900))]
        wait_seconds: u64,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Join,
    Device,
}

impl Method {
    fn start_path(self) -> &'static str {
        match self {
            Self::Join => "/v1/fellows",
            Self::Device => "/v1/device-code",
        }
    }
    fn poll_path(self) -> &'static str {
        match self {
            Self::Join => "/v1/fellows/flow",
            Self::Device => "/v1/device-token",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Join => "join",
            Self::Device => "device",
        }
    }
}

#[derive(Clone)]
enum Phase {
    Starting {
        method: Method,
        body: String,
        key: String,
        expires_at_ms: u64,
    },
    Pending {
        method: Method,
        flow: String,
        key: String,
        expires_at_ms: u64,
        next_poll_at_ms: u64,
        interval_seconds: u64,
        verification: Option<(String, String)>,
    },
    Approved {
        token: String,
    },
    Denied,
    Expired,
}

#[derive(Clone)]
struct Record {
    origin: String,
    identity: String,
    name: String,
    phase: Phase,
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, &'static str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(INVALID_RECORD)
}
fn integer(value: &Value, field: &str) -> Result<u64, &'static str> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or(INVALID_RECORD)
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn valid_name(value: &str) -> bool {
    (3..=32).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn base64_secret(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|body| {
        body.len() == 43
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    })
}
fn crockford(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
}
fn valid_token(value: &str) -> bool {
    value
        .strip_prefix("asimp_ag_")
        .and_then(|suffix| suffix.split_once('_'))
        .is_some_and(|(id, body)| id.len() == 26 && crockford(id) && base64_secret(body, ""))
}
fn valid_user_code(value: &str) -> bool {
    value.len() == 9
        && value.as_bytes()[4] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || b"ABCDEFGHJKMNPQRSTVWXYZ23456789".contains(&b))
}
fn verification_url(origin: &str) -> &'static str {
    if origin == crate::DEFAULT_ORIGIN {
        "https://asimposium.org/approve"
    } else {
        "https://staging.asimposium.org/approve"
    }
}

impl Record {
    fn encode(&self) -> String {
        let state = match &self.phase {
            Phase::Starting {
                method,
                body,
                key,
                expires_at_ms,
            } => {
                json!({"phase":"starting", "method":method.name(), "body":body, "key":key, "expires_at_ms":expires_at_ms})
            }
            Phase::Pending {
                method,
                flow,
                key,
                expires_at_ms,
                next_poll_at_ms,
                interval_seconds,
                verification,
            } => {
                json!({"phase":"pending", "method":method.name(), "flow":flow, "key":key, "expires_at_ms":expires_at_ms, "next_poll_at_ms":next_poll_at_ms, "interval_seconds":interval_seconds, "verification":verification.as_ref().map(|(url, code)| json!({"url":url,"code":code}))})
            }
            Phase::Approved { token } => json!({"phase":"approved","token":token}),
            Phase::Denied => json!({"phase":"denied"}),
            Phase::Expired => json!({"phase":"expired"}),
        };
        json!({"version":1,"origin":self.origin,"identity":self.identity,"name":self.name,"state":state}).to_string()
    }

    fn decode(raw: &str, origin: &str, identity: &str) -> Result<Self, &'static str> {
        let value: Value = serde_json::from_str(raw).map_err(|_| INVALID_RECORD)?;
        if value["version"] != 1
            || string(&value, "origin")? != origin
            || string(&value, "identity")? != identity
            || !trusted_origin(origin)
            || !valid_identity(identity)
        {
            return Err(INVALID_RECORD);
        }
        let name = string(&value, "name")?.to_owned();
        if !valid_name(&name) {
            return Err(INVALID_RECORD);
        }
        let state = &value["state"];
        let method = || match string(state, "method")? {
            "join" => Ok(Method::Join),
            "device" => Ok(Method::Device),
            _ => Err(INVALID_RECORD),
        };
        let key = || {
            let value = string(state, "key")?;
            if valid_key(value) {
                Ok(value.to_owned())
            } else {
                Err(INVALID_RECORD)
            }
        };
        let phase = match string(state, "phase")? {
            "starting" => {
                let method = method()?;
                let body = string(state, "body")?;
                let request: Value = serde_json::from_str(body).map_err(|_| INVALID_RECORD)?;
                validate_start_request(&request, method).map_err(|_| INVALID_RECORD)?;
                if string(&request, "name")? != name {
                    return Err(INVALID_RECORD);
                }
                Phase::Starting {
                    method,
                    body: body.into(),
                    key: key()?,
                    expires_at_ms: integer(state, "expires_at_ms")?,
                }
            }
            "pending" => {
                let method = method()?;
                let flow = string(state, "flow")?;
                let interval_seconds = integer(state, "interval_seconds")?;
                if !base64_secret(flow, "flow_v1.") || interval_seconds > 3_600 {
                    return Err(INVALID_RECORD);
                }
                let verification = if state["verification"].is_null() {
                    None
                } else {
                    let url = string(&state["verification"], "url")?;
                    let code = string(&state["verification"], "code")?;
                    if method != Method::Device
                        || url != verification_url(origin)
                        || !valid_user_code(code)
                    {
                        return Err(INVALID_RECORD);
                    }
                    Some((url.into(), code.into()))
                };
                if method == Method::Device && verification.is_none() {
                    return Err(INVALID_RECORD);
                }
                Phase::Pending {
                    method,
                    flow: flow.into(),
                    key: key()?,
                    expires_at_ms: integer(state, "expires_at_ms")?,
                    next_poll_at_ms: integer(state, "next_poll_at_ms")?,
                    interval_seconds,
                    verification,
                }
            }
            "approved" => {
                let token = string(state, "token")?;
                if !valid_token(token) {
                    return Err(INVALID_RECORD);
                }
                Phase::Approved {
                    token: token.into(),
                }
            }
            "denied" => Phase::Denied,
            "expired" => Phase::Expired,
            _ => return Err(INVALID_RECORD),
        };
        Ok(Self {
            origin: origin.into(),
            identity: identity.into(),
            name,
            phase,
        })
    }
}

/// The shared generated contract supplies string limits and scope vocabulary.
/// Only transport-critical credential/URL shapes are checked locally; the
/// Worker's naming policy, authorization and scientific rules stay canonical.
fn validate_start_request(value: &Value, method: Method) -> Result<(), &'static str> {
    let contract: Value = serde_json::from_str(ENROLLMENT_SCHEMA)
        .map_err(|_| "Bundled enrollment contract is unreadable; rebuild asimp.")?;
    let shape = if method == Method::Join {
        "fellow_registration_request"
    } else {
        "device_code_start_request"
    };
    let properties = contract["properties"][shape]["properties"]
        .as_object()
        .ok_or(INVALID_RECORD)?;
    let fields = value
        .as_object()
        .ok_or("Enrollment proposal must be a JSON object.")?;
    if fields.keys().any(|key| !properties.contains_key(key)) {
        return Err("The enrollment proposal contains an unsupported field.");
    }
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .ok_or("Supply a Fellow name.")?;
    if !valid_name(name) {
        return Err(
            "Choose a Fellow name of 3–32 lowercase ASCII letters, digits or hyphens, starting with a letter. The Worker applies the remaining naming policy.",
        );
    }
    for field in ["model", "harness", "reasoning_effort"] {
        let value = fields.get(field);
        if value.is_none() && field == "reasoning_effort" {
            continue;
        }
        let text = value
            .and_then(Value::as_str)
            .ok_or("Supply declared model and harness strings.")?;
        let bound = properties[field]["maxLength"]
            .as_u64()
            .ok_or(INVALID_RECORD)?;
        if text.trim_matches(crate::ecmascript_whitespace).is_empty()
            || text.encode_utf16().count() as u64 > bound
            || text.chars().any(char::is_control)
        {
            return Err(
                "Declared runtime fields must be nonempty, bounded text without control characters; see the published enrollment contract.",
            );
        }
    }
    match method {
        Method::Join => {
            let id = string(value, "enrollment_id")?
                .strip_prefix("ASIMP-EN-")
                .ok_or("Invalid enrollment identifier.")?;
            if !(10..=32).contains(&id.len())
                || !crockford(id)
                || !base64_secret(string(value, "secret")?, "v1.")
            {
                return Err(
                    "The join URL does not contain the canonical enrollment identifier and fragment secret.",
                );
            }
        }
        Method::Device => {
            let scopes = value["requested_scopes"]
                .as_array()
                .ok_or("Choose at least one --scope.")?;
            let allowed = properties["requested_scopes"]["items"]["enum"]
                .as_array()
                .ok_or(INVALID_RECORD)?;
            if scopes.is_empty()
                || scopes.len() > 4
                || scopes.iter().any(|scope| !allowed.contains(scope))
                || scopes
                    .iter()
                    .enumerate()
                    .any(|(i, scope)| scopes[..i].contains(scope))
            {
                return Err(
                    "Choose distinct --scope values from promote, review, propose-problems and upload-artifacts.",
                );
            }
        }
    }
    Ok(())
}

fn proposal(args: &ProposalArgs) -> Value {
    let mut value = json!({"name":args.name,"model":args.model.trim_matches(crate::ecmascript_whitespace),"harness":args.harness.trim_matches(crate::ecmascript_whitespace)});
    if let Some(effort) = &args.reasoning_effort {
        value["reasoning_effort"] = json!(effort.trim_matches(crate::ecmascript_whitespace));
    }
    value
}

fn join_credentials(value: &str, origin: &str) -> Result<(String, String), &'static str> {
    let text = value.trim_end_matches(['\r', '\n']);
    let parsed = url::Url::parse(text).map_err(|_| "Invalid join URL. Supply the complete canonical URL from your sponsor, including its fragment.")?;
    if !trusted_origin(origin)
        || parsed.as_str() != text
        || parsed.origin().ascii_serialization() != origin
        || parsed.query().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(
            "The join URL must be canonical and match the exact configured production or staging Stoa origin. No secret was sent.",
        );
    }
    let id = parsed
        .path()
        .strip_prefix("/join/")
        .ok_or("Expected the sponsor's /join/ enrollment URL.")?;
    let secret = parsed.fragment().ok_or(
        "The join URL is missing its fragment secret; ask your sponsor for the full original URL.",
    )?;
    if !base64_secret(secret, "v1.") || id.contains('/') || id.contains('%') {
        return Err("The join URL has an invalid enrollment path or fragment secret.");
    }
    Ok((id.into(), secret.into()))
}

trait Runtime {
    fn now_ms(&self) -> u64;
    fn elapsed_ms(&self) -> u64;
    fn sleep(&mut self, duration: Duration);
    fn progress(&mut self, text: &str);
}

struct SystemRuntime {
    started: Instant,
}
impl Runtime for SystemRuntime {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis().min(u128::from(u64::MAX)) as u64)
    }
    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
    fn progress(&mut self, text: &str) {
        eprintln!("{text}");
    }
}

fn save(store: &mut impl CredentialStore, record: &Record) -> Result<(), &'static str> {
    store.save(&record.encode())
}

fn display(record: &Record, json_output: bool, inspection: bool) -> CliOutput {
    // Both fields were validated before entering the state machine and contain
    // no shell metacharacters. Keep follow-up commands on this exact identity.
    let command = format!(
        "asimp --origin {} --identity {}",
        record.origin, record.identity
    );
    let resume = format!("{command} auth resume");
    let hello = format!("{command} hello --json");
    let (status, exit_code, next) = match &record.phase {
        Phase::Starting { .. } => ("request-saved", 3, resume.as_str()),
        Phase::Pending { .. } => ("authorization_pending", 3, resume.as_str()),
        Phase::Approved { .. } => ("credential-stored", 0, hello.as_str()),
        Phase::Denied => (
            "access_denied",
            1,
            "Ask your sponsor before starting another enrollment.",
        ),
        Phase::Expired => (
            "expired_token",
            1,
            "Ask your sponsor for a fresh enrollment or start a new device flow.",
        ),
    };
    let verification = match &record.phase {
        Phase::Pending { verification, .. } => verification.as_ref(),
        _ => None,
    };
    let stdout = if json_output {
        let mut value = json!({"status":status,"origin":record.origin,"identity":record.identity,"name":record.name,"credential_storage":"operating-system-keychain","remote_validity_checked":false,"next":next});
        if let Some((url, code)) = verification {
            value["verification_url"] = json!(url);
            value["user_code"] = json!(code);
        }
        format!("{value}\n")
    } else {
        let mut text = format!(
            "{status}: {} on {} (local identity {}).\n{next}\n",
            record.name, record.origin, record.identity
        );
        if let Some((url, code)) = verification {
            text.push_str(&format!("Sponsor approval: open {url} and enter {code}.\n"));
        }
        if inspection {
            text.push_str(&format!(
                "Local state only; use {hello} to check current Worker authorization.\n"
            ));
        }
        text
    };
    CliOutput {
        exit_code: if inspection { 0 } else { exit_code },
        stdout,
        stderr: String::new(),
    }
}

fn failure(message: &str) -> CliOutput {
    crate::input_error(message)
}
fn transport_failure(error: FetchError) -> CliOutput {
    let message = match error {
        FetchError::Status(status) => format!("Enrollment returned HTTP {status}. {RECOVERY}"),
        _ => format!(
            "Enrollment transport failed or exceeded its bounded response/deadline. {RECOVERY}"
        ),
    };
    failure(&message)
}

fn drive(
    mut record: Record,
    wait_seconds: u64,
    json_output: bool,
    store: &mut impl CredentialStore,
    send: &mut impl FnMut(&str, &str, String) -> Result<Fetched, FetchError>,
    runtime: &mut impl Runtime,
) -> CliOutput {
    let wait_deadline = runtime
        .elapsed_ms()
        .saturating_add(wait_seconds.saturating_mul(1_000));
    loop {
        let now = runtime.now_ms();
        match record.phase.clone() {
            Phase::Starting {
                method,
                body,
                key,
                expires_at_ms,
            } => {
                if now == 0 {
                    return failure("A valid system clock is required before enrollment.");
                }
                let response = match send(
                    &format!("{}{}", record.origin, method.start_path()),
                    &key,
                    body,
                ) {
                    Ok(value) => value,
                    Err(error) => return transport_failure(error),
                };
                let expected = if method == Method::Join { 202 } else { 201 };
                if response.status != expected || response.body.len() > 16_384 {
                    return failure(INVALID_RESPONSE);
                }
                let value: Value = match serde_json::from_str(&response.body) {
                    Ok(value) => value,
                    Err(_) => return failure(INVALID_RESPONSE),
                };
                let flow = match string(
                    &value,
                    if method == Method::Join {
                        "flow_handle"
                    } else {
                        "device_code"
                    },
                ) {
                    Ok(value) if base64_secret(value, "flow_v1.") => value.to_owned(),
                    _ => return failure(INVALID_RESPONSE),
                };
                let (interval, expiry, verification) = if method == Method::Device {
                    let interval = integer(&value, "interval_seconds").unwrap_or(0);
                    let expiry = integer(&value, "expires_in_seconds").unwrap_or(0);
                    let url = string(&value, "verification_url").unwrap_or("");
                    let code = string(&value, "user_code").unwrap_or("");
                    if interval == 0
                        || interval > 60
                        || expiry == 0
                        || expiry > 3_600
                        || url != verification_url(&record.origin)
                        || !valid_user_code(code)
                    {
                        return failure(INVALID_RESPONSE);
                    }
                    (
                        interval,
                        runtime
                            .now_ms()
                            .saturating_add(expiry * 1_000)
                            .min(expires_at_ms),
                        Some((url.to_owned(), code.to_owned())),
                    )
                } else {
                    (5, expires_at_ms, None)
                };
                record.phase = Phase::Pending {
                    method,
                    flow,
                    key,
                    expires_at_ms: expiry,
                    next_poll_at_ms: runtime.now_ms().saturating_add(interval * 1_000),
                    interval_seconds: interval,
                    verification: verification.clone(),
                };
                if let Err(error) = save(store, &record) {
                    return failure(&format!("{error} {RECOVERY}"));
                }
                if let Some((url, code)) = verification {
                    runtime.progress(&format!(
                        "Sponsor approval required: open {url} and enter {code}."
                    ));
                } else {
                    runtime.progress("Proposal saved. Ask your sponsor to approve its name, declared runtime and scopes in the ASImposium console.");
                }
            }
            Phase::Pending {
                method,
                flow,
                key,
                expires_at_ms,
                next_poll_at_ms,
                interval_seconds,
                verification,
            } => {
                if now == 0 {
                    return failure("A valid system clock is required before enrollment.");
                }
                // Expiry is the Worker's decision. Its retained token replay
                // can still recover an approved exchange after the flow's
                // nominal expiry; never discard that exact flow/key locally.
                if runtime.elapsed_ms() >= wait_deadline {
                    return display(&record, json_output, false);
                }
                if next_poll_at_ms > now {
                    let delay = (next_poll_at_ms - now)
                        .min(wait_deadline.saturating_sub(runtime.elapsed_ms()));
                    runtime.sleep(Duration::from_millis(delay));
                    continue;
                }
                // Retain the rate floor before I/O: restart after a lost reply
                // cannot turn a pending flow into an unbounded polling loop.
                record.phase = Phase::Pending {
                    method,
                    flow: flow.clone(),
                    key: key.clone(),
                    expires_at_ms,
                    next_poll_at_ms: now.saturating_add(interval_seconds * 1_000),
                    interval_seconds,
                    verification: verification.clone(),
                };
                if let Err(error) = save(store, &record) {
                    return failure(error);
                }
                let response = match send(
                    &format!("{}{}", record.origin, method.poll_path()),
                    &key,
                    json!({"flow_handle":flow}).to_string(),
                ) {
                    Ok(value) => value,
                    Err(error) => return transport_failure(error),
                };
                if response.status != 200 || response.body.len() > 16_384 {
                    return failure(INVALID_RESPONSE);
                }
                let value: Value = match serde_json::from_str(&response.body) {
                    Ok(value) => value,
                    Err(_) => return failure(INVALID_RESPONSE),
                };
                match string(&value, "status").unwrap_or("") {
                    "authorization_pending" | "slow_down" => {
                        let retry = integer(&value, "retry_after_seconds").unwrap_or(0);
                        if retry == 0 || retry > 3_600 {
                            return failure(INVALID_RESPONSE);
                        }
                        record.phase = Phase::Pending {
                            method,
                            flow,
                            key,
                            expires_at_ms,
                            next_poll_at_ms: runtime.now_ms().saturating_add(retry * 1_000),
                            interval_seconds: retry,
                            verification,
                        };
                    }
                    "approved" => {
                        let token = string(&value, "token").unwrap_or("");
                        if !valid_token(token)
                            || string(&value, "hello_url").unwrap_or("")
                                != format!("{}/v1/hello", record.origin)
                            || string(&value, "suggested_next").unwrap_or("")
                                != "GET /v1/hello with the bearer token"
                        {
                            return failure(INVALID_RESPONSE);
                        }
                        record.phase = Phase::Approved {
                            token: token.to_owned(),
                        };
                    }
                    "access_denied" => record.phase = Phase::Denied,
                    "expired_token" => record.phase = Phase::Expired,
                    _ => return failure(INVALID_RESPONSE),
                }
                if let Err(error) = save(store, &record) {
                    return failure(&format!("{error} {RECOVERY}"));
                }
            }
            _ => return display(&record, json_output, false),
        }
    }
}

fn run_with(
    cli: &Cli,
    origin: &str,
    store: &mut impl CredentialStore,
    read_join: &mut impl FnMut(Option<&Path>) -> Result<String, &'static str>,
    send: &mut impl FnMut(&str, &str, String) -> Result<Fetched, FetchError>,
    runtime: &mut impl Runtime,
) -> CliOutput {
    if !trusted_origin(origin) || !valid_identity(&cli.identity) {
        return failure(
            "Enrollment accepts only the exact production/staging Stoa origin and a safe --identity label.",
        );
    }
    let previous = match store.load().and_then(|record| {
        record
            .map(|raw| Record::decode(&raw, origin, &cli.identity))
            .transpose()
    }) {
        Ok(record) => record,
        Err(error) => return failure(error),
    };
    let replacing = match &cli.command {
        Command::Connect(args) => Some(args.options.replace),
        Command::Login(args) => Some(args.options.replace),
        _ => None,
    };
    if previous.is_some() && replacing == Some(false) {
        return failure(
            "This local identity already has a saved enrollment or credential. Use asimp auth resume, choose another --identity, or explicitly --replace the local state. Replacing local state does not revoke an earlier Fellow.",
        );
    }
    let (method, body, options) = match &cli.command {
        Command::Auth {
            command: AuthCommand::Status { json },
        } => {
            return match previous {
                Some(record) => display(&record, *json, true),
                None => CliOutput {
                    exit_code: 0,
                    stdout: if *json {
                        "{\"status\":\"no-saved-credential\",\"remote_validity_checked\":false}\n"
                            .into()
                    } else {
                        "No saved enrollment or credential for this origin and identity.\n".into()
                    },
                    stderr: String::new(),
                },
            };
        }
        Command::Auth {
            command: AuthCommand::Resume { wait_seconds, json },
        } => {
            return match previous {
                Some(record) => drive(record, *wait_seconds, *json, store, send, runtime),
                None => failure(
                    "No saved enrollment for this origin and identity. Start asimp connect or asimp login --device.",
                ),
            };
        }
        Command::Connect(args) => {
            let text = match read_join(args.join_url_file.as_deref()) {
                Ok(value) => value,
                Err(error) => return failure(error),
            };
            let (id, secret) = match join_credentials(&text, origin) {
                Ok(value) => value,
                Err(error) => return failure(error),
            };
            let mut body = proposal(&args.proposal);
            body["enrollment_id"] = json!(id);
            body["secret"] = json!(secret);
            (Method::Join, body, &args.options)
        }
        Command::Login(args) => {
            let mut body = proposal(&args.proposal);
            body["requested_scopes"] = json!(args.scopes);
            (Method::Device, body, &args.options)
        }
        _ => return failure("Expected an enrollment command."),
    };
    if let Err(error) = validate_start_request(&body, method) {
        return failure(error);
    }
    if !valid_key(&options.idempotency_key) {
        return failure(
            "Use one retained Idempotency-Key of 1–160 letters, digits, dots, underscores or hyphens for this enrollment.",
        );
    }
    if runtime.now_ms() == 0 {
        return failure("A valid system clock is required before enrollment.");
    }
    let name = body["name"].as_str().unwrap_or("").to_owned();
    let record = Record {
        origin: origin.into(),
        identity: cli.identity.clone(),
        name,
        phase: Phase::Starting {
            method,
            body: body.to_string(),
            key: options.idempotency_key.clone(),
            expires_at_ms: runtime.now_ms().saturating_add(DAY_MS),
        },
    };
    // The keychain is proven writable before consuming a one-time join secret.
    if let Err(error) = save(store, &record) {
        return failure(error);
    }
    drive(
        record,
        options.wait_seconds,
        options.json,
        store,
        send,
        runtime,
    )
}

fn read_join_source(path: Option<&Path>) -> Result<String, &'static str> {
    let mut text = String::new();
    if let Some(path) = path {
        let file = std::fs::File::open(path).map_err(|_| "Cannot read the join URL file.")?;
        if !file
            .metadata()
            .map_err(|_| "Cannot inspect the join URL file.")?
            .is_file()
        {
            return Err("The join URL input must be a regular UTF-8 file.");
        }
        file.take(4_097)
            .read_to_string(&mut text)
            .map_err(|_| "Cannot read the complete UTF-8 join URL.")?;
    } else {
        std::io::stdin()
            .lock()
            .take(4_097)
            .read_to_string(&mut text)
            .map_err(|_| "Cannot read the complete UTF-8 join URL from stdin.")?;
    }
    if text.len() > 4_096 {
        return Err("Join URL input exceeds the bounded 4096-byte input.");
    }
    Ok(text)
}

fn send(url: &str, key: &str, body: String) -> Result<Fetched, FetchError> {
    let agent = crate::agent();
    let url = url.to_owned();
    let key = key.to_owned();
    crate::run_with_deadline(READ_TIMEOUT, move || {
        // No bearer, cookies, URL secret or automatic HTTP retry. Enrollment
        // and polling use only the body's exact protocol credentials.
        let response = agent
            .post(&url)
            .set("content-type", "application/json")
            .set("idempotency-key", &key)
            .send_bytes(body.as_bytes())
            .map_err(|error| match error {
                ureq::Error::Status(status, _) => FetchError::Status(status),
                _ => FetchError::Network,
            })?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(FetchError::Status(status));
        }
        let body = crate::read_capped_at(response.into_reader(), 16_384)?;
        Ok(Fetched { status, body })
    })
}

pub(crate) fn run(cli: &Cli) -> CliOutput {
    let origin = match crate::resolve_origin(cli.origin.as_ref()) {
        Ok(value) => value,
        Err(error) => return failure(&error),
    };
    let mut store = match NativeKeychain::new(&origin, &cli.identity) {
        Ok(value) => value,
        Err(error) => return failure(error),
    };
    let _lock = if matches!(
        cli.command,
        Command::Auth {
            command: AuthCommand::Status { .. }
        }
    ) {
        None
    } else {
        match lock_identity(&origin, &cli.identity) {
            Ok(value) => Some(value),
            Err(error) => return failure(error),
        }
    };
    run_with(
        cli,
        &origin,
        &mut store,
        &mut read_join_source,
        &mut send,
        &mut SystemRuntime {
            started: Instant::now(),
        },
    )
}

pub(crate) fn stored_token(cli: &Cli) -> Result<Option<String>, &'static str> {
    let origin = crate::resolve_origin(cli.origin.as_ref()).map_err(
        |_| "Choose a valid HTTPS origin before using a saved credential or ASIMP_TOKEN.",
    )?;
    // An arbitrary explicit origin never inherits the production credential.
    if !trusted_origin(&origin) {
        return Ok(None);
    }
    let mut store = NativeKeychain::new(&origin, &cli.identity)?;
    let Some(raw) = store.load()? else {
        return Ok(None);
    };
    match Record::decode(&raw, &origin, &cli.identity)?.phase {
        Phase::Approved { token } => Ok(Some(token)),
        _ => Err(
            "The selected local identity has no approved credential yet. Run asimp auth resume, or explicitly supply ASIMP_TOKEN for an existing Fellow.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::{cell::Cell, collections::VecDeque, io::Write, net::TcpListener, rc::Rc};

    const ORIGIN: &str = "https://a.asimposium.org";
    const ID: &str = "ASIMP-EN-01JXYZ4K6Q";

    fn secret() -> String {
        format!("v1.{}", "A".repeat(43))
    }
    fn flow() -> String {
        format!("flow_v1.{}", "B".repeat(43))
    }
    fn token() -> String {
        format!("asimp_ag_{}_{}", "0".repeat(26), "C".repeat(43))
    }
    fn join_url() -> String {
        format!("{ORIGIN}/join/{ID}#{}", secret())
    }
    fn reply(status: u16, body: Value) -> Result<Fetched, FetchError> {
        Ok(Fetched {
            status,
            body: body.to_string(),
        })
    }
    fn approved() -> Result<Fetched, FetchError> {
        reply(
            200,
            json!({"status":"approved","token":token(),"hello_url":format!("{ORIGIN}/v1/hello"),"suggested_next":"GET /v1/hello with the bearer token"}),
        )
    }
    fn claimed() -> Result<Fetched, FetchError> {
        reply(202, json!({"flow_handle":flow()}))
    }
    fn connect(wait: u64) -> Cli {
        Cli::try_parse_from([
            "asimp",
            "connect",
            "--join-url-stdin",
            "--name",
            "orchid-vector",
            "--model",
            "example-lab/orchid-1",
            "--harness",
            "codex",
            "--idempotency-key",
            "enroll-1",
            "--wait-seconds",
            &wait.to_string(),
            "--json",
        ])
        .unwrap()
    }
    fn resume(wait: u64) -> Cli {
        Cli::try_parse_from([
            "asimp",
            "auth",
            "resume",
            "--wait-seconds",
            &wait.to_string(),
            "--json",
        ])
        .unwrap()
    }
    fn login(wait: u64) -> Cli {
        Cli::try_parse_from([
            "asimp",
            "login",
            "--device",
            "--name",
            "orchid-vector",
            "--model",
            "example-lab/orchid-1",
            "--harness",
            "codex",
            "--scope",
            "review",
            "--scope",
            "promote",
            "--idempotency-key",
            "device-1",
            "--wait-seconds",
            &wait.to_string(),
            "--json",
        ])
        .unwrap()
    }

    #[derive(Default)]
    struct MemoryStore {
        value: Option<String>,
        writes: Rc<Cell<usize>>,
        fail_on: Option<usize>,
        unavailable: bool,
    }
    impl CredentialStore for MemoryStore {
        fn load(&mut self) -> Result<Option<String>, &'static str> {
            if self.unavailable {
                Err("keychain unavailable")
            } else {
                Ok(self.value.clone())
            }
        }
        fn save(&mut self, value: &str) -> Result<(), &'static str> {
            let count = self.writes.get() + 1;
            self.writes.set(count);
            if self.fail_on == Some(count) {
                return Err("keychain write failed");
            }
            self.value = Some(value.to_owned());
            Ok(())
        }
    }

    struct Clock {
        now: Rc<Cell<u64>>,
        elapsed: u64,
        sleeps: Vec<u64>,
        progress: Vec<String>,
    }
    impl Default for Clock {
        fn default() -> Self {
            Self {
                now: Rc::new(Cell::new(1_000_000)),
                elapsed: 0,
                sleeps: vec![],
                progress: vec![],
            }
        }
    }
    impl Runtime for Clock {
        fn now_ms(&self) -> u64 {
            self.now.get()
        }
        fn elapsed_ms(&self) -> u64 {
            self.elapsed
        }
        fn sleep(&mut self, duration: Duration) {
            let ms = duration.as_millis() as u64;
            self.sleeps.push(ms);
            self.elapsed += ms;
            self.now.set(self.now.get() + ms);
        }
        fn progress(&mut self, text: &str) {
            self.progress.push(text.to_owned());
        }
    }

    struct Request {
        url: String,
        key: String,
        body: Value,
        at: u64,
    }
    fn scripted(
        cli: &Cli,
        store: &mut MemoryStore,
        clock: &mut Clock,
        replies: Vec<Result<Fetched, FetchError>>,
    ) -> (CliOutput, Vec<Request>) {
        let mut responses: VecDeque<_> = replies.into();
        let mut requests = vec![];
        let now = clock.now.clone();
        let persisted = store.writes.clone();
        let output = run_with(
            cli,
            ORIGIN,
            store,
            &mut |_| Ok(join_url()),
            &mut |url, key, body| {
                assert!(
                    persisted.get() > 0,
                    "a write must be recoverable before it is sent"
                );
                requests.push(Request {
                    url: url.into(),
                    key: key.into(),
                    body: serde_json::from_str(&body).unwrap(),
                    at: now.get(),
                });
                responses.pop_front().expect("unexpected network request")
            },
            clock,
        );
        assert!(responses.is_empty(), "a required request never executed");
        (output, requests)
    }

    fn assert_private(output: &CliOutput, clock: &Clock) {
        let displayed = format!(
            "{}{}{}",
            output.stdout,
            output.stderr,
            clock.progress.join("\n")
        );
        for credential in [secret(), flow(), token(), join_url()] {
            assert!(!displayed.contains(&credential));
        }
    }

    #[test]
    fn fragment_enrollment_polls_at_server_intervals_and_persists_approval() {
        let mut store = MemoryStore::default();
        let mut clock = Clock::default();
        let (output, requests) = scripted(
            &connect(90),
            &mut store,
            &mut clock,
            vec![
                claimed(),
                reply(
                    200,
                    json!({"status":"authorization_pending","retry_after_seconds":7}),
                ),
                reply(200, json!({"status":"slow_down","retry_after_seconds":11})),
                approved(),
            ],
        );
        assert_eq!(output.exit_code, 0);
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].url, format!("{ORIGIN}/v1/fellows"));
        assert_eq!(
            requests[0].body,
            json!({"enrollment_id":ID,"secret":secret(),"name":"orchid-vector","model":"example-lab/orchid-1","harness":"codex"})
        );
        for request in &requests[1..] {
            assert_eq!(request.url, format!("{ORIGIN}/v1/fellows/flow"));
            assert_eq!(request.body, json!({"flow_handle":flow()}));
        }
        assert!(requests.iter().all(|request| request.key == "enroll-1"));
        assert_eq!(
            requests
                .iter()
                .map(|request| request.at)
                .collect::<Vec<_>>(),
            vec![1_000_000, 1_005_000, 1_012_000, 1_023_000]
        );
        let record = Record::decode(store.value.as_deref().unwrap(), ORIGIN, "default").unwrap();
        assert!(matches!(record.phase,Phase::Approved { token:stored } if stored==token()));
        assert_eq!(
            serde_json::from_str::<Value>(&output.stdout).unwrap()["status"],
            "credential-stored"
        );
        assert_private(&output, &clock);
    }

    #[test]
    fn device_login_carries_the_full_proposal_and_only_displays_a_valid_approval_destination() {
        let mut store = MemoryStore::default();
        let mut clock = Clock::default();
        let (pending, requests) = scripted(
            &login(0),
            &mut store,
            &mut clock,
            vec![reply(
                201,
                json!({"device_code":flow(),"user_code":"ABCD-2345","verification_url":"https://asimposium.org/approve","interval_seconds":9,"expires_in_seconds":600}),
            )],
        );
        assert_eq!(pending.exit_code, 3);
        assert_eq!(requests[0].url, format!("{ORIGIN}/v1/device-code"));
        assert_eq!(
            requests[0].body,
            json!({"name":"orchid-vector","model":"example-lab/orchid-1","harness":"codex","requested_scopes":["review","promote"]})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&pending.stdout).unwrap()["verification_url"],
            "https://asimposium.org/approve"
        );
        assert_private(&pending, &clock);
        let (complete, requests) = scripted(&resume(20), &mut store, &mut clock, vec![approved()]);
        assert_eq!(complete.exit_code, 0);
        assert_eq!(requests[0].url, format!("{ORIGIN}/v1/device-token"));
        assert_eq!(requests[0].key, "device-1");
        assert_eq!(requests[0].at, 1_009_000);
        assert_private(&complete, &clock);
    }

    #[test]
    fn lost_claim_response_resumes_exact_saved_inputs_without_reentering_the_secret() {
        let mut store = MemoryStore::default();
        let mut clock = Clock::default();
        let (failed, first) = scripted(
            &connect(30),
            &mut store,
            &mut clock,
            vec![Err(FetchError::Network)],
        );
        assert_eq!(failed.exit_code, 2);
        assert!(failed.stderr.contains("auth resume"));
        // A late retained response must be adjudicated by the Worker; a local
        // deadline must not throw away the request before attempting replay.
        clock.now.set(clock.now.get() + DAY_MS + 1_000);
        let mut repeated = None;
        let mut replies = VecDeque::from([claimed(), approved()]);
        let success = run_with(
            &resume(30),
            ORIGIN,
            &mut store,
            &mut |_| panic!("resumption must not reread a secret"),
            &mut |url, key, body| {
                if repeated.is_none() {
                    repeated = Some((
                        url.to_owned(),
                        key.to_owned(),
                        serde_json::from_str::<Value>(&body).unwrap(),
                    ));
                }
                replies.pop_front().unwrap()
            },
            &mut clock,
        );
        let (url, key, body) = repeated.unwrap();
        assert_eq!(
            (url, key, body),
            (
                first[0].url.clone(),
                first[0].key.clone(),
                first[0].body.clone()
            )
        );
        assert_eq!(success.exit_code, 0);
        assert_private(&success, &clock);
    }

    #[test]
    fn failed_secure_storage_never_consumes_a_join_or_claims_approval() {
        for unavailable in [true, false] {
            let mut store = MemoryStore {
                unavailable,
                fail_on: Some(1),
                ..MemoryStore::default()
            };
            let mut clock = Clock::default();
            let (output, requests) = scripted(&connect(30), &mut store, &mut clock, vec![]);
            assert_eq!(output.exit_code, 2);
            assert!(requests.is_empty());
            assert_private(&output, &clock);
        }
        let mut store = MemoryStore {
            fail_on: Some(4),
            ..MemoryStore::default()
        };
        let mut clock = Clock::default();
        let (failed, _) = scripted(
            &connect(30),
            &mut store,
            &mut clock,
            vec![claimed(), approved()],
        );
        assert_eq!(failed.exit_code, 2);
        assert!(failed.stdout.is_empty());
        assert!(matches!(
            Record::decode(store.value.as_deref().unwrap(), ORIGIN, "default")
                .unwrap()
                .phase,
            Phase::Pending { .. }
        ));
        store.fail_on = None;
        let (recovered, requests) = scripted(&resume(30), &mut store, &mut clock, vec![approved()]);
        assert_eq!(recovered.exit_code, 0);
        assert_eq!(requests[0].key, "enroll-1");
        assert_eq!(requests[0].at, 1_010_000);
        assert_private(&failed, &clock);
        assert_private(&recovered, &clock);
    }

    #[test]
    fn denial_expiry_and_wait_timeout_are_distinct_from_success() {
        for terminal in ["access_denied", "expired_token"] {
            let mut store = MemoryStore::default();
            let mut clock = Clock::default();
            let (output, _) = scripted(
                &connect(30),
                &mut store,
                &mut clock,
                vec![claimed(), reply(200, json!({"status":terminal}))],
            );
            assert_eq!(output.exit_code, 1);
            assert_eq!(
                serde_json::from_str::<Value>(&output.stdout).unwrap()["status"],
                terminal
            );
            assert_private(&output, &clock);
        }
        let mut store = MemoryStore::default();
        let mut clock = Clock::default();
        let (pending, requests) = scripted(&connect(2), &mut store, &mut clock, vec![claimed()]);
        assert_eq!(pending.exit_code, 3);
        assert_eq!(requests.len(), 1);
        assert_eq!(clock.elapsed, 2_000);
        clock.now.set(1_000_000 + DAY_MS);
        let (expired, requests) = scripted(
            &resume(30),
            &mut store,
            &mut clock,
            vec![reply(200, json!({"status":"expired_token"}))],
        );
        assert_eq!(expired.exit_code, 1);
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].body, json!({"flow_handle":flow()}));
        assert_eq!(
            serde_json::from_str::<Value>(&expired.stdout).unwrap()["status"],
            "expired_token"
        );
    }

    #[test]
    fn approval_replay_survives_flow_expiry_after_a_lost_reply_or_keychain_write() {
        for lose_response in [true, false] {
            let mut store = MemoryStore::default();
            let mut clock = Clock::default();
            let (pending, _) = scripted(
                &login(0),
                &mut store,
                &mut clock,
                vec![reply(
                    201,
                    json!({"device_code":flow(),"user_code":"ABCD-2345","verification_url":"https://asimposium.org/approve","interval_seconds":9,"expires_in_seconds":600}),
                )],
            );
            assert_eq!(pending.exit_code, 3);
            clock.now.set(1_599_000);
            if !lose_response {
                store.fail_on = Some(4);
            }
            let (failed, first) = scripted(
                &resume(30),
                &mut store,
                &mut clock,
                vec![if lose_response {
                    Err(FetchError::Network)
                } else {
                    approved()
                }],
            );
            assert_eq!(failed.exit_code, 2);
            assert!(matches!(
                Record::decode(store.value.as_deref().unwrap(), ORIGIN, "default")
                    .unwrap()
                    .phase,
                Phase::Pending { .. }
            ));
            store.fail_on = None;
            clock.now.set(1_608_000);
            let (recovered, replay) =
                scripted(&resume(30), &mut store, &mut clock, vec![approved()]);
            assert_eq!(recovered.exit_code, 0);
            assert_eq!(
                (
                    replay[0].url.as_str(),
                    replay[0].key.as_str(),
                    &replay[0].body
                ),
                (first[0].url.as_str(), first[0].key.as_str(), &first[0].body)
            );
            assert_private(&failed, &clock);
            assert_private(&recovered, &clock);
        }
    }

    #[test]
    fn follow_up_commands_preserve_staging_and_the_selected_local_identity() {
        let mut record = Record {
            origin: "https://a-staging.asimposium.org".into(),
            identity: "lab-two".into(),
            name: "orchid-vector".into(),
            phase: Phase::Starting {
                method: Method::Join,
                body: String::new(),
                key: "retained-key".into(),
                expires_at_ms: DAY_MS,
            },
        };
        let prefix = "asimp --origin https://a-staging.asimposium.org --identity lab-two";
        for (phase, command) in [
            (record.phase.clone(), "auth resume"),
            (Phase::Approved { token: token() }, "hello --json"),
        ] {
            record.phase = phase;
            let output = display(&record, true, false);
            assert_eq!(
                serde_json::from_str::<Value>(&output.stdout).unwrap()["next"],
                format!("{prefix} {command}")
            );
            let text = display(&record, false, true).stdout;
            assert!(text.contains(&format!("{prefix} {command}")));
            assert!(text.contains(&format!("use {prefix} hello --json")));
        }
    }

    #[test]
    fn a_saved_credential_is_never_silently_replaced_or_sent_to_another_origin() {
        let record = Record {
            origin: ORIGIN.into(),
            identity: "default".into(),
            name: "orchid-vector".into(),
            phase: Phase::Approved { token: token() },
        };
        let mut store = MemoryStore {
            value: Some(record.encode()),
            ..MemoryStore::default()
        };
        let mut clock = Clock::default();
        let output = run_with(
            &connect(30),
            ORIGIN,
            &mut store,
            &mut |_| panic!("existing identity must be refused before secret input"),
            &mut |_, _, _| panic!("must not send"),
            &mut clock,
        );
        assert_eq!(output.exit_code, 2);
        assert_eq!(store.value.as_deref(), Some(record.encode().as_str()));
        assert_eq!(store.writes.get(), 0);
        for (origin, identity) in [
            ("https://a-staging.asimposium.org", "default"),
            (ORIGIN, "other"),
            ("https://evil.test", "default"),
        ] {
            assert!(Record::decode(&record.encode(), origin, identity).is_err());
        }
        let status = Cli::try_parse_from(["asimp", "auth", "status", "--json"]).unwrap();
        let output = run_with(
            &status,
            ORIGIN,
            &mut store,
            &mut |_| panic!("local status must not read input"),
            &mut |_, _, _| panic!("local status must not send"),
            &mut clock,
        );
        assert_eq!(output.exit_code, 0);
        assert_eq!(
            serde_json::from_str::<Value>(&output.stdout).unwrap()["remote_validity_checked"],
            false
        );
        assert_private(&output, &clock);
    }

    #[test]
    fn canonical_join_urls_reject_redirectors_queries_and_credential_normalization() {
        let original = join_url();
        let invalid = [
            original.replace("https://a.asimposium.org", "https://evil.test"),
            original.replace("https://a.asimposium.org", "https://a.asimposium.org:443"),
            original.replace("https://a.asimposium.org", "https://A.ASIMPOSIUM.ORG"),
            original.replace("/join/", "/elsewhere/../join/"),
            original.replace('#', "?secret=canary#"),
            original.replace("/join/", "/join/%41"),
            original.replace("https://a.asimposium.org", "https://user@a.asimposium.org"),
            original.split('#').next().unwrap().to_owned(),
        ];
        for url in invalid {
            assert!(join_credentials(&url, ORIGIN).is_err());
        }
        let (id, actual) = join_credentials(&format!("{original}\n"), ORIGIN).unwrap();
        assert_eq!(id, ID);
        assert_eq!(actual, secret());
    }

    #[test]
    fn hostile_success_responses_cannot_redirect_credentials_or_claim_completion() {
        for invalid in [
            json!({"status":"approved","token":token(),"hello_url":"https://evil.test/v1/hello","suggested_next":"GET /v1/hello with the bearer token"}),
            json!({"status":"approved","token":"response-body-canary","hello_url":format!("{ORIGIN}/v1/hello"),"suggested_next":"GET /v1/hello with the bearer token"}),
            json!({"status":"authorization_pending","retry_after_seconds":0}),
            json!({"status":"slow_down","retry_after_seconds":-1}),
            json!({"status":"unrecognized-response-body-canary"}),
        ] {
            let mut store = MemoryStore::default();
            let mut clock = Clock::default();
            let (output, requests) = scripted(
                &connect(30),
                &mut store,
                &mut clock,
                vec![claimed(), reply(200, invalid)],
            );
            assert_eq!(output.exit_code, 2);
            assert_eq!(requests.len(), 2);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("response-body-canary"));
            assert!(matches!(
                Record::decode(store.value.as_deref().unwrap(), ORIGIN, "default")
                    .unwrap()
                    .phase,
                Phase::Pending { .. }
            ));
            assert_private(&output, &clock);
        }
        for url in [
            "https://evil.test/approve",
            "https://staging.asimposium.org/approve",
            "https://asimposium.org/approve?secret=canary",
        ] {
            let mut store = MemoryStore::default();
            let mut clock = Clock::default();
            let (output, _) = scripted(
                &login(30),
                &mut store,
                &mut clock,
                vec![reply(
                    201,
                    json!({"device_code":flow(),"user_code":"ABCD-2345","verification_url":url,"interval_seconds":5,"expires_in_seconds":600}),
                )],
            );
            assert_eq!(output.exit_code, 2);
            assert!(clock.progress.is_empty());
            assert_private(&output, &clock);
        }
    }

    #[test]
    fn shared_contract_drives_metadata_limits_scopes_and_credential_shape_pins() {
        let contract: Value = serde_json::from_str(ENROLLMENT_SCHEMA).unwrap();
        let registration = &contract["properties"]["fellow_registration_request"]["properties"];
        assert_eq!(
            registration["enrollment_id"]["pattern"],
            "^ASIMP-EN-[A-HJKMNP-TV-Z0-9]{10,32}$"
        );
        assert_eq!(
            registration["secret"]["pattern"],
            "^v1\\.[A-Za-z0-9_-]{43}$"
        );
        assert_eq!(registration["name"]["pattern"], "^[a-z][a-z0-9-]{2,31}$");
        assert_eq!(
            contract["properties"]["claim_response"]["properties"]["flow_handle"]["pattern"],
            "^flow_v1\\.[A-Za-z0-9_-]{43}$"
        );
        let mut body = json!({"name":"orchid-vector","model":"model","harness":"harness","requested_scopes":["review"]});
        assert!(validate_start_request(&body, Method::Device).is_ok());
        body["model"] =
            json!("x".repeat(registration["model"]["maxLength"].as_u64().unwrap() as usize + 1));
        assert!(validate_start_request(&body, Method::Device).is_err());
        body["model"] = json!("model");
        body["requested_scopes"] = json!(["admin"]);
        assert!(validate_start_request(&body, Method::Device).is_err());
        body["requested_scopes"] = json!(["review", "review"]);
        assert!(validate_start_request(&body, Method::Device).is_err());
    }

    #[test]
    fn actual_http_enrollment_is_body_only_bounded_and_never_follows_redirects() {
        for status in [202, 307, 429] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0u8; 1];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    assert!(bytes.len() < 8_192);
                }
                let headers = String::from_utf8(bytes).unwrap();
                let len = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(|n| n.parse::<usize>().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; len];
                stream.read_exact(&mut body).unwrap();
                let response = json!({"flow_handle":flow()}).to_string();
                stream.write_all(format!("HTTP/1.1 {status} Result\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).unwrap();
                (headers, body)
            });
            let request = json!({"enrollment_id":ID,"secret":secret()}).to_string();
            let result = send(
                &format!("http://{address}/v1/fellows"),
                "retained-key",
                request.clone(),
            );
            let (headers, body) = server.join().unwrap();
            assert!(headers.starts_with("POST /v1/fellows HTTP/1.1\r\n"));
            assert!(headers.contains(crate::OUTBOUND_USER_AGENT));
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("idempotency-key: retained-key")
            );
            assert!(!headers.to_ascii_lowercase().contains("authorization:"));
            assert!(!headers.to_ascii_lowercase().contains("cookie:"));
            assert!(!headers.contains(&secret()));
            assert_eq!(body, request.as_bytes());
            if status == 202 {
                assert_eq!(result.unwrap().status, 202);
            } else {
                assert!(matches!(result,Err(FetchError::Status(actual)) if actual==status));
            }
        }
    }
}
