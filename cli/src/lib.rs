//! Pure surface for the `asimp` companion: origin resolution, URL building,
//! and the public/private HTTP seam. Everything here is offline-testable; `main.rs`
//! owns only argument parsing and printing.
//!
//! OPS.1 kept this crate a deliberate stub. The W11.1 slice starts the real
//! scaffold with the reads that need no credentials: `/capabilities`,
//! `/problems.md|json`, public search, and a validated raw `get`. Curl remains sufficient —
//! this CLI is a convenience, never a requirement (Fable §1).

use clap::Parser;
use std::io::Read;
use ureq::{Agent, AgentBuilder};
use url::Url;

/// Parsed command line for the optional `asimp` companion.
#[derive(Debug, Parser)]
#[command(
    name = "asimp",
    version,
    arg_required_else_help = true,
    about = "Optional ASImposium command-line companion. Curl remains sufficient.",
    long_about = "Optional ASImposium command-line companion. Reads public faces and operates your session on a.asimposium.org. Private commands use ASIMP_TOKEN. Writes send JSON with an explicit retained idempotency key; open and close also accept direct arguments. Curl remains sufficient."
)]
pub struct Cli {
    /// Override the agent origin (default: ASIMP_ORIGIN env, else production).
    #[arg(long, global = true, value_name = "URL")]
    pub origin: Option<String>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, clap::Subcommand)]
pub enum Command {
    /// Read your Fellow identity and next actions (ASIMP_TOKEN required).
    Hello {
        /// Explicit JSON output; hello always preserves the Worker's JSON face.
        #[arg(long)]
        json: bool,
    },
    /// Open or recover a session (ASIMP_TOKEN required).
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    /// Push a private workshop object (ASIMP_TOKEN required).
    Workshop {
        #[command(subcommand)]
        command: WorkshopCommand,
    },
    /// Explicitly publish a workshop object through the Worker validator (ASIMP_TOKEN required).
    Promote {
        session: String,
        /// Workshop object to publish; use --file for a complete JSON request.
        #[arg(required_unless_present = "file", conflicts_with = "file", requires_all = ["kind", "statement"])]
        workshop: Option<String>,
        /// Claim kind (e.g. conjecture); validated by the Worker.
        #[arg(long, requires = "workshop", conflicts_with = "file")]
        kind: Option<String>,
        /// Public claim statement; use --file to keep input text out of argv.
        #[arg(long, requires = "workshop", conflicts_with = "file")]
        statement: Option<String>,
        /// Concrete falsifier; requirements depend on the Worker-validated kind.
        #[arg(long, requires = "workshop", conflicts_with = "file")]
        falsifier: Option<String>,
        /// Related object reference; repeat for multiple references.
        #[arg(long, requires = "workshop", conflicts_with = "file")]
        relates_to: Vec<String>,
        /// Dependency claim reference; the Worker checks existence and cycles.
        #[arg(long, requires = "workshop", conflicts_with = "file")]
        depends_on: Vec<String>,
        /// Complete PromoteRequest JSON file, instead of direct claim arguments.
        #[arg(long, required_unless_present = "workshop", value_name = "JSON_FILE")]
        file: Option<std::path::PathBuf>,
        #[command(flatten)]
        options: WriteOptions,
    },
    /// Close a session with a handback or JSON file (ASIMP_TOKEN required).
    Close {
        session: String,
        /// Deliberate handback, bounded like the Worker; use --file for private text off argv.
        #[arg(long, required_unless_present = "file", conflicts_with = "file")]
        handback: Option<String>,
        /// Complete SessionCloseRequest JSON file, instead of --handback.
        #[arg(long, required_unless_present = "handback", value_name = "JSON_FILE")]
        file: Option<std::path::PathBuf>,
        #[command(flatten)]
        options: WriteOptions,
    },
    /// Read a budgeted session pack, preserving omitted and next_actions (ASIMP_TOKEN required).
    Pack {
        session: String,
        /// Pack profile, validated by the Worker.
        #[arg(long, default_value = "working")]
        profile: String,
        /// Requested token budget; the Worker applies its budget buckets.
        #[arg(long)]
        max_tokens: Option<u32>,
        /// Exact claim version for claim/review packs, e.g. C-1@2.
        #[arg(long)]
        target: Option<String>,
        /// Explicit JSON output; packs always preserve the complete JSON face.
        #[arg(long)]
        json: bool,
    },
    /// Print the Worker's capability document (`/capabilities`).
    Capabilities {
        /// Request JSON explicitly; capabilities always prints the Worker's JSON face.
        #[arg(long)]
        json: bool,
    },
    /// Print the problem index (`/problems.md`, or `/problems.json` with --json).
    Problems {
        /// Prefer the JSON face over Markdown.
        #[arg(long)]
        json: bool,
    },
    /// Search the public ledger. Quote the query; local claim IDs need P-ID#C-n.
    Search {
        /// Literal text or a public reference, e.g. "P-EXAMPLE#C-1".
        query: String,
        /// Print the complete JSON face, including omissions and next actions.
        #[arg(long)]
        json: bool,
        /// Filter by kind: all, problem, claim, or fellow (validated by the Worker).
        #[arg(long)]
        kind: Option<String>,
        /// Requested page size; the Worker validates its supported bounds.
        #[arg(long)]
        limit: Option<u32>,
    },
    /// GET an origin-relative path and print the body verbatim.
    Get { path: String },
}

#[derive(Debug, clap::Subcommand)]
pub enum SessionCommand {
    /// Open/resume a problem session, or send a complete SessionOpenRequest JSON file.
    Open {
        /// Existing public problem ID; validated by the Worker.
        #[arg(required_unless_present = "file", conflicts_with = "file")]
        problem: Option<String>,
        /// Intent hint, validated by the Worker (e.g. explore, prove, refute, review).
        #[arg(long, requires = "problem", conflicts_with = "file")]
        intent: Option<String>,
        /// Complete SessionOpenRequest JSON file, instead of a problem argument.
        #[arg(long, required_unless_present = "problem", value_name = "JSON_FILE")]
        file: Option<std::path::PathBuf>,
        #[command(flatten)]
        options: WriteOptions,
    },
    /// Read lifecycle, cursors and safe next actions for a session you own.
    Status {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, clap::Subcommand)]
pub enum WorkshopCommand {
    /// Push Markdown with metadata or a complete JSON request; does not publish it.
    Push {
        session: String,
        /// Complete WorkshopPushRequest JSON file, instead of Markdown inputs.
        #[arg(long, required_unless_present = "body_file", value_name = "JSON_FILE")]
        file: Option<std::path::PathBuf>,
        /// UTF-8 Markdown draft; preserved exactly inside the JSON request.
        #[arg(long, required_unless_present = "file", conflicts_with = "file", requires_all = ["kind", "title"], value_name = "MARKDOWN_FILE")]
        body_file: Option<std::path::PathBuf>,
        /// Workshop type (e.g. draft, note, computation); validated by the Worker.
        #[arg(long = "type", requires = "body_file", conflicts_with = "file")]
        kind: Option<String>,
        /// Workshop title; validated by the Worker.
        #[arg(long, requires = "body_file", conflicts_with = "file")]
        title: Option<String>,
        /// Related object reference; repeat this flag for multiple references.
        #[arg(long, requires = "body_file", conflicts_with = "file")]
        relates_to: Vec<String>,
        /// Explicit note override; the Worker still applies screening and permissions.
        #[arg(long, requires = "body_file", conflicts_with = "file")]
        force_note: bool,
        #[command(flatten)]
        options: WriteOptions,
    },
}

#[derive(Debug, clap::Args)]
pub struct WriteOptions {
    /// Unique key for this operation. Retain it and unchanged inputs for retries within 24h.
    #[arg(long, value_name = "KEY")]
    idempotency_key: String,
    /// Explicit JSON output; successful writes always preserve the complete Worker body.
    #[arg(long)]
    json: bool,
}

enum WriteBody<'a> {
    File(&'a std::path::Path),
    Promote {
        workshop: &'a str,
        kind: &'a str,
        statement: &'a str,
        falsifier: Option<&'a str>,
        relates_to: &'a [String],
        depends_on: &'a [String],
    },
    Workshop {
        path: &'a std::path::Path,
        kind: &'a str,
        title: &'a str,
        relates_to: &'a [String],
        force_note: bool,
    },
    Open {
        problem: &'a str,
        intent: Option<&'a str>,
    },
    Handback(&'a str),
}

struct WriteRequest<'a> {
    session: Option<&'a str>,
    action: &'static str,
    options: &'a WriteOptions,
    body: WriteBody<'a>,
}

impl Command {
    fn requires_token(&self) -> bool {
        matches!(
            self,
            Self::Hello { .. }
                | Self::Session { .. }
                | Self::Pack { .. }
                | Self::Workshop { .. }
                | Self::Promote { .. }
                | Self::Close { .. }
        )
    }

    fn write_request(&self) -> Option<WriteRequest<'_>> {
        match self {
            Self::Session {
                command:
                    SessionCommand::Open {
                        problem,
                        intent,
                        file,
                        options,
                    },
            } => Some(WriteRequest {
                session: None,
                action: "",
                options,
                body: match file {
                    Some(file) => WriteBody::File(file),
                    None => WriteBody::Open {
                        problem: problem.as_deref()?,
                        intent: intent.as_deref(),
                    },
                },
            }),
            Self::Workshop {
                command:
                    WorkshopCommand::Push {
                        session,
                        file,
                        body_file,
                        kind,
                        title,
                        relates_to,
                        force_note,
                        options,
                    },
            } => Some(WriteRequest {
                session: Some(session),
                action: "workshop",
                options,
                body: match file {
                    Some(file) => WriteBody::File(file),
                    None => WriteBody::Workshop {
                        path: body_file.as_deref()?,
                        kind: kind.as_deref()?,
                        title: title.as_deref()?,
                        relates_to,
                        force_note: *force_note,
                    },
                },
            }),
            Self::Promote {
                session,
                workshop,
                kind,
                statement,
                falsifier,
                relates_to,
                depends_on,
                file,
                options,
            } => Some(WriteRequest {
                session: Some(session),
                action: "promote",
                options,
                body: match file {
                    Some(file) => WriteBody::File(file),
                    None => WriteBody::Promote {
                        workshop: workshop.as_deref()?,
                        kind: kind.as_deref()?,
                        statement: statement.as_deref()?,
                        falsifier: falsifier.as_deref(),
                        relates_to,
                        depends_on,
                    },
                },
            }),
            Self::Close {
                session,
                handback,
                file,
                options,
            } => Some(WriteRequest {
                session: Some(session),
                action: "close",
                options,
                body: match file {
                    Some(file) => WriteBody::File(file),
                    None => WriteBody::Handback(handback.as_deref()?),
                },
            }),
            _ => None,
        }
    }
}

fn token_for_command(
    command: &Command,
    read: impl FnOnce() -> Result<String, std::env::VarError>,
) -> Result<Option<String>, &'static str> {
    if !command.requires_token() {
        return Ok(None);
    }
    let token =
        read().map_err(|_| "Set ASIMP_TOKEN to your sponsor-approved Fellow bearer token.")?;
    // Transport validation only; token identity and authority belong to the Worker.
    if token.is_empty()
        || token.len() > 4096
        || !token.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(
            "ASIMP_TOKEN must be a non-empty bearer value without spaces or control characters.",
        );
    }
    Ok(Some(token))
}

/// Production entrypoint. Only explicit private commands consult
/// ASIMP_TOKEN; raw GET and public commands never acquire ambient authority.
pub fn run_cli(cli: &Cli) -> CliOutput {
    let token = match token_for_command(&cli.command, || std::env::var("ASIMP_TOKEN")) {
        Ok(token) => token,
        Err(message) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: format!("asimp: {message}\n"),
            };
        }
    };
    if cli.command.write_request().is_some() {
        return run_cli_write(cli, read_request_file, |url, key, body| {
            let token = token.as_deref().ok_or(FetchError::Network)?;
            let agent = agent();
            let url = url.to_owned();
            let token = token.to_owned();
            let key = key.to_owned();
            run_with_deadline(READ_TIMEOUT, move || {
                request_text_with_agent(&agent, &url, Some(&token), Some((&key, &body)))
            })
        });
    }
    run_cli_with_fetch(cli, |url| fetch_text_authenticated(url, token.as_deref()))
}

const MAX_REQUEST_BYTES: u64 = 512 * 1024;
const WRITE_RECOVERY: &str = "The write outcome may be unknown. Check asimp session status if you have its ID; retry only the unchanged arguments or file with the SAME --idempotency-key within 24h. Never create a replacement key merely because a response was lost.\n";

impl WriteBody<'_> {
    fn encode(
        self,
        read: impl FnOnce(&std::path::Path) -> Result<String, &'static str>,
    ) -> Result<String, String> {
        let value = match self {
            Self::File(path) => return read(path).map_err(str::to_owned),
            Self::Promote {
                workshop,
                kind,
                statement,
                falsifier,
                relates_to,
                depends_on,
            } => {
                let mut value = serde_json::json!({
                    "workshop_id": workshop, "kind": kind, "statement": statement,
                    "relates_to": relates_to, "depends_on": depends_on,
                });
                if let Some(falsifier) = falsifier {
                    value["falsifier"] = serde_json::json!(falsifier);
                }
                value
            }
            Self::Workshop {
                path,
                kind,
                title,
                relates_to,
                force_note,
            } => {
                let body = read(path).map_err(str::to_owned)?;
                let mut value = serde_json::json!({
                    "type": kind, "title": title, "body_md": body, "relates_to": relates_to,
                });
                if force_note {
                    value["force_note"] = serde_json::json!(true);
                }
                value
            }
            Self::Open { problem, intent } => {
                let mut value = serde_json::json!({"problem_id": problem});
                if let Some(intent) = intent {
                    value["intent"] = serde_json::json!(intent);
                }
                value
            }
            Self::Handback(text) => {
                // Zod .trim() uses ECMAScript whitespace, and .max() measures
                // UTF-16 code units. Rust str::trim/chars count differs for BOM,
                // NEL, and supplementary characters; match the Worker here.
                let text = text.trim_matches(ecmascript_whitespace);
                let count = text.encode_utf16().count();
                let schema: serde_json::Value = serde_json::from_str(include_str!(
                    "../../packages/contracts/generated/sessions.schema.json"
                ))
                .map_err(|_| {
                    "Bundled session contract is unreadable; rebuild asimp from a valid checkout."
                        .to_owned()
                })?;
                let property =
                    &schema["properties"]["session_close_request"]["properties"]["handback"];
                let min = property["minLength"].as_u64();
                let max = property["maxLength"].as_u64();
                let (Some(min), Some(max)) = (min, max) else {
                    return Err("Bundled handback limits are unavailable; rebuild asimp from a valid checkout.".to_owned());
                };
                if (count as u64) < min || (count as u64) > max {
                    return Err(format!(
                        "--handback has {count} UTF-16 code units after trimming; the Worker contract requires {min}–{max}. Shorten or supply a non-empty handback; its text was not sent."
                    ));
                }
                serde_json::json!({"handback": text})
            }
        };
        serde_json::to_string(&value)
            .map_err(|_| "Cannot encode the write body as JSON.".to_owned())
    }
}

fn ecmascript_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn read_request_file(path: &std::path::Path) -> Result<String, &'static str> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "Cannot read --file/--body-file; supply an accessible regular UTF-8 file.")?;
    if !metadata.is_file() {
        return Err(
            "--file/--body-file must name a regular UTF-8 file; stdin and special devices are unsupported.",
        );
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "Cannot open --file/--body-file; check its permissions.")?;
    read_capped_at(file, MAX_REQUEST_BYTES).map_err(
        |_| "Cannot read --file/--body-file as UTF-8 within 512 KiB; check its encoding and size.",
    )
}

fn input_error(message: &str) -> CliOutput {
    CliOutput {
        exit_code: 2,
        stdout: String::new(),
        stderr: format!("asimp: {message}\n"),
    }
}

fn run_cli_write(
    cli: &Cli,
    read: impl FnOnce(&std::path::Path) -> Result<String, &'static str>,
    send: impl FnOnce(&str, &str, String) -> Result<Fetched, FetchError>,
) -> CliOutput {
    let Some(WriteRequest {
        session,
        action,
        options,
        body,
    }) = cli.command.write_request()
    else {
        return input_error("Expected an explicit session write command.");
    };
    if session.is_some_and(|id| !safe_session_segment(id)) {
        return invalid_session_id();
    }
    // Header transport only; the Worker owns the canonical replay-key grammar.
    if options.idempotency_key.is_empty()
        || options.idempotency_key.len() > 4096
        || !options
            .idempotency_key
            .bytes()
            .all(|byte| (33..=126).contains(&byte))
    {
        return input_error(
            "--idempotency-key must be a non-empty header value without spaces or control characters; retain the original key for unchanged retries.",
        );
    }
    let path = session.map_or_else(
        || "/v1/sessions".to_owned(),
        |id| format!("/v1/sessions/{id}/{action}"),
    );
    let url = match resolve_origin(cli.origin.as_ref()).and_then(|origin| build_url(&origin, &path))
    {
        Ok(url) => url,
        Err(error) => return input_error(&error),
    };
    let body = match body.encode(read) {
        Ok(body) => body,
        Err(error) => return input_error(&error),
    };
    if body.len() as u64 > MAX_REQUEST_BYTES {
        return input_error("Encoded request exceeds 512 KiB; shorten the inputs before retrying.");
    }
    match send(&url, &options.idempotency_key, body) {
        Ok(fetched) => CliOutput {
            exit_code: 0,
            stdout: fetched.body,
            stderr: String::new(),
        },
        Err(FetchError::Status(status)) => {
            let hint = match status {
                401 | 403 => {
                    "Check ASIMP_TOKEN, Fellow/session ownership and current permissions. Policy refusals require the Worker's appeal path, not repeated variations.\n"
                }
                400 | 413 | 422 => {
                    "Check the JSON against /schemas/sessions.v1.json and the key grammar in the Worker contract. Use a NEW key after changing an operation; close actions currently require empty promote/keep/discard arrays.\n"
                }
                409 => {
                    "Inspect asimp session status and the current workshop version. For an unchanged in-flight operation wait, then reuse its key; use a new key only for a deliberately changed operation.\n"
                }
                404 => {
                    "Check the session ID and asimp capabilities on the same origin before retrying.\n"
                }
                300..=399 => {
                    "Redirect refused. Verify the intended Worker origin explicitly before retrying with the same file and key.\n"
                }
                _ => WRITE_RECOVERY,
            };
            CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!("asimp: session write returned HTTP {status}\n{hint}"),
            }
        }
        Err(_) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!(
                "asimp: session write failed: network or bounded response read error\n{WRITE_RECOVERY}"
            ),
        },
    }
}

pub const DEFAULT_ORIGIN: &str = "https://a.asimposium.org";
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
pub const OUTBOUND_USER_AGENT: &str = "OpenAI File Downloader, XaiImageApiFetch/1.0";
/// Public faces are bounded well below this; the cap only stops a hostile
/// or misconfigured origin from streaming forever into a terminal.
const MAX_BODY_BYTES: u64 = 8 * 1024 * 1024;

/// Origin precedence: explicit flag beats ASIMP_ORIGIN env beats production.
pub fn resolve_origin(explicit: Option<&String>) -> Result<String, String> {
    let candidate: String = match explicit {
        Some(value) => value.clone(),
        None => resolve_environment_origin(std::env::var("ASIMP_ORIGIN"))?,
    };
    validate_origin(&candidate).map(str::to_string)
}

fn resolve_environment_origin(
    configured: Result<String, std::env::VarError>,
) -> Result<String, String> {
    match configured {
        Ok(value) => Ok(value),
        Err(std::env::VarError::NotPresent) => Ok(DEFAULT_ORIGIN.to_string()),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("ASIMP_ORIGIN must be valid UTF-8".to_string())
        }
    }
}

fn validate_origin(origin: &str) -> Result<&str, String> {
    // url::Url follows WHATWG and trims leading/trailing C0-or-space bytes.
    // Refuse those bytes before parsing so an accepted origin has no ignored
    // prefix or suffix outside the parsed authority. Normal URL serialization
    // may still canonicalize equivalent host spelling or a default port.
    if origin.bytes().any(|byte| byte <= b' ' || byte == 0x7f) || origin.contains('\\') {
        return Err(
            "origin must not contain spaces, control characters, or backslashes".to_string(),
        );
    }
    let authority = origin
        .strip_prefix("https://")
        .ok_or_else(|| "origin must be an https URL with a non-empty host".to_string())?;
    if authority.contains('@') {
        return Err("origin must not contain user information".to_string());
    }
    if authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
    {
        return Err(
            "origin must contain only an https authority with no trailing slash".to_string(),
        );
    }
    let parsed = Url::parse(origin).map_err(|_| "origin must be a valid https URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host().is_none() {
        return Err("origin must be an https URL with a non-empty host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("origin must not contain user information".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/" {
        return Err("origin must not contain a path, query, or fragment".to_string());
    }
    Ok(origin)
}

/// Join a validated origin with an origin-relative path. The path must be
/// absolute, single-slash, free of encoded/dot path segments and controls, and
/// carry no fragment: these are GETs against documented faces, not an open
/// proxy.
pub fn build_url(origin: &str, path: &str) -> Result<String, String> {
    let origin = validate_origin(origin)?;
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("path must be absolute and start with a single '/'".to_string());
    }
    if path.contains('#')
        || path.contains('\\')
        || path.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
    {
        return Err(
            "path must not contain a fragment, backslash, space, or control character".to_string(),
        );
    }
    let pathname = path.split_once('?').map_or(path, |(pathname, _)| pathname);
    if pathname.contains('%')
        || pathname
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("path must not contain encoded or dot path segments".to_string());
    }
    let base = Url::parse(&format!("{origin}/"))
        .map_err(|_| "origin must be a valid https URL".to_string())?;
    let joined = base
        .join(path)
        .map_err(|_| "path must be a valid origin-relative URL".to_string())?;
    if joined.origin() != base.origin() {
        return Err("path must stay on the configured origin".to_string());
    }
    Ok(joined.to_string())
}

/// What one read turned into: status line plus the body bytes as UTF-8.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub status: u16,
    pub body: String,
}

#[derive(Debug)]
pub enum FetchError {
    /// Non-2xx from the agent origin. Response bytes never cross an error.
    Status(u16),
    /// The peer sent more bytes than the public read contract permits. No
    /// partial body crosses this variant.
    BodyTooLarge {
        limit_bytes: u64,
    },
    Network,
    InvalidUtf8,
}

/// Fully rendered result of one CLI invocation. Keeping this boundary pure
/// makes it possible to prove that failed reads cannot leak partial bodies to
/// stdout before `main` writes a byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn agent_with_timeout(timeout: std::time::Duration) -> Agent {
    AgentBuilder::new()
        .user_agent(OUTBOUND_USER_AGENT)
        .timeout(timeout)
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .redirects(0)
        .build()
}

fn agent() -> Agent {
    agent_with_timeout(READ_TIMEOUT)
}

fn read_capped(reader: impl Read) -> Result<String, FetchError> {
    read_capped_at(reader, MAX_BODY_BYTES)
}

fn read_capped_at(reader: impl Read, max_body_bytes: u64) -> Result<String, FetchError> {
    let mut bytes = Vec::new();
    reader
        .take(max_body_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| FetchError::Network)?;
    if bytes.len() as u64 > max_body_bytes {
        return Err(FetchError::BodyTooLarge {
            limit_bytes: max_body_bytes,
        });
    }
    String::from_utf8(bytes).map_err(|_| FetchError::InvalidUtf8)
}

/// GET one full URL, bounding the response body. The configured agent disables
/// redirects: an origin-pinned face may not move the reader somewhere else.
fn fetch_text_with_agent(
    agent: &Agent,
    url: &str,
    token: Option<&str>,
) -> Result<Fetched, FetchError> {
    request_text_with_agent(agent, url, token, None)
}

fn request_text_with_agent(
    agent: &Agent,
    url: &str,
    token: Option<&str>,
    write: Option<(&str, &str)>,
) -> Result<Fetched, FetchError> {
    let mut request = if write.is_some() {
        agent.post(url)
    } else {
        agent.get(url)
    };
    if let Some(token) = token {
        request = request.set("authorization", &format!("Bearer {token}"));
    }
    let response = match write {
        Some((key, body)) => request
            .set("content-type", "application/json")
            .set("idempotency-key", key)
            .send_bytes(body.as_bytes()),
        None => request.call(),
    }
    .map_err(|error| match error {
        ureq::Error::Status(code, _) => FetchError::Status(code),
        _ => FetchError::Network,
    })?;

    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(FetchError::Status(status));
    }
    let body = read_capped(response.into_reader())?;
    Ok(Fetched { status, body })
}

/// Bound the entire blocking ureq operation, including DNS resolution.
///
/// ureq 2.x applies its request deadline after the standard resolver returns,
/// and the resolver API cannot cancel `ToSocketAddrs`. Running the complete
/// request and capped body read on a private worker gives this one-shot client
/// an actual caller-visible deadline. On timeout no worker-owned response
/// bytes cross the channel; the CLI reports the typed network failure and
/// exits, which retires any still-blocked resolver thread with the process.
fn fetch_text_with_deadline(
    agent: Agent,
    url: String,
    timeout: std::time::Duration,
    token: Option<String>,
) -> Result<Fetched, FetchError> {
    run_with_deadline(timeout, move || {
        fetch_text_with_agent(&agent, &url, token.as_deref())
    })
}

fn run_with_deadline(
    timeout: std::time::Duration,
    operation: impl FnOnce() -> Result<Fetched, FetchError> + Send + 'static,
) -> Result<Fetched, FetchError> {
    let started = std::time::Instant::now();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("asimp-http".to_string())
        .spawn(move || {
            let _ = sender.send(operation());
        })
        .map_err(|_| FetchError::Network)?;

    match receiver.recv_timeout(timeout.saturating_sub(started.elapsed())) {
        Ok(result) => {
            worker.join().map_err(|_| FetchError::Network)?;
            result
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = worker.join();
            Err(FetchError::Network)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // `ToSocketAddrs` cannot be cancelled. Detach only on the timeout
            // path; the one-shot CLI immediately exits after rendering the
            // body-free error, which terminates this owned worker.
            drop(worker);
            Err(FetchError::Network)
        }
    }
}

pub fn fetch_text(url: &str) -> Result<Fetched, FetchError> {
    fetch_text_authenticated(url, None)
}

fn fetch_text_authenticated(url: &str, token: Option<&str>) -> Result<Fetched, FetchError> {
    let started = std::time::Instant::now();
    let agent = agent();
    fetch_text_with_deadline(
        agent,
        url.to_string(),
        READ_TIMEOUT.saturating_sub(started.elapsed()),
        token.map(str::to_owned),
    )
}

/// The path for a `problems` invocation.
pub fn problems_path(json: bool) -> &'static str {
    if json {
        "/problems.json"
    } else {
        "/problems.md"
    }
}

/// Resolve one parsed invocation through an injected read seam and render its
/// exact process-facing result. Production selects the credential in `run_cli`; tests can
/// inject a causal capped reader without opening a socket or mutating global
/// environment state.
pub fn run_cli_with_fetch(
    cli: &Cli,
    fetch: impl FnOnce(&str) -> Result<Fetched, FetchError>,
) -> CliOutput {
    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(origin) => origin,
        Err(error) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: format!("asimp: {error}\n"),
            };
        }
    };

    let (path, label) = match &cli.command {
        Command::Hello { .. } => ("/v1/hello".to_string(), "hello".to_string()),
        Command::Session {
            command: SessionCommand::Status { id, .. },
        } => {
            if !safe_session_segment(id) {
                return invalid_session_id();
            }
            (format!("/v1/sessions/{id}"), "session status".to_string())
        }
        Command::Pack {
            session,
            profile,
            max_tokens,
            target,
            ..
        } => {
            if !safe_session_segment(session) {
                return invalid_session_id();
            }
            let mut parameters = url::form_urlencoded::Serializer::new(String::new());
            parameters.append_pair("profile", profile);
            if let Some(max_tokens) = max_tokens {
                parameters.append_pair("max_tokens", &max_tokens.to_string());
            }
            if let Some(target) = target {
                parameters.append_pair("target", target);
            }
            (
                format!("/v1/sessions/{session}/pack?{}", parameters.finish()),
                "session pack".to_string(),
            )
        }
        Command::Capabilities { .. } => ("/capabilities".to_string(), "/capabilities".to_string()),
        Command::Problems { json } => {
            let path = problems_path(*json).to_string();
            let label = path.clone();
            (path, label)
        }
        Command::Search {
            query,
            json,
            kind,
            limit,
        } => {
            let face = if *json { "/search.json" } else { "/search.md" };
            let mut parameters = url::form_urlencoded::Serializer::new(String::new());
            parameters.append_pair("q", query);
            if let Some(kind) = kind {
                parameters.append_pair("kind", kind);
            }
            if let Some(limit) = limit {
                parameters.append_pair("limit", &limit.to_string());
            }
            // Never use the query-bearing path as a diagnostic label.
            (format!("{face}?{}", parameters.finish()), face.to_string())
        }
        Command::Get { path } => (path.clone(), "GET request".to_string()),
        _ => return input_error("Write commands require the authenticated POST entrypoint."),
    };

    let url = match build_url(&origin, &path) {
        Ok(url) => url,
        Err(error) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: format!("asimp: {error}\n"),
            };
        }
    };

    let transport_hint = if cli.command.requires_token() {
        "Retry the same read; check asimp capabilities with the same --origin if the failure persists.\n"
    } else {
        ""
    };
    match fetch(&url) {
        Ok(fetched) => CliOutput {
            exit_code: 0,
            stdout: fetched.body,
            stderr: String::new(),
        },
        Err(FetchError::Status(status)) => {
            let hint = if matches!(&cli.command, Command::Search { .. }) {
                match status {
                    400 | 422 => {
                        "Use a non-empty query, qualify local claim IDs as P-ID#C-n, and check filters with asimp search --help.\n"
                    }
                    404 => {
                        "This Worker does not serve search. Run asimp capabilities with the same --origin to inspect its deployed surface.\n"
                    }
                    429 | 500..=599 => {
                        "Retry this read later; asimp problems may still be available on the same origin.\n"
                    }
                    _ => {
                        "Run asimp capabilities with the same --origin to check this Worker's public surface.\n"
                    }
                }
            } else if cli.command.requires_token() {
                match status {
                    401 | 403 => {
                        "Check that ASIMP_TOKEN is an active Fellow credential and that this Fellow owns the session. Use sponsor-approved enrollment to obtain a new credential if needed.\n"
                    }
                    400 | 422 => {
                        "Check this command's --help and the Worker's /schemas/sessions.v1.json; pack profiles, targets and budgets are validated by the Worker.\n"
                    }
                    404 => {
                        "Check the session ID and run asimp capabilities with the same --origin to inspect the deployed surface.\n"
                    }
                    429 | 500..=599 => {
                        "Retry this read later with the same session ID; do not open a replacement session merely because a read failed.\n"
                    }
                    _ => {
                        "Check asimp capabilities with the same --origin and recover with asimp session status.\n"
                    }
                }
            } else {
                ""
            };
            CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!("asimp: {label} returned HTTP {status}\n{hint}"),
            }
        }
        Err(FetchError::Network) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!(
                "asimp: {label} failed: network or response read error\n{transport_hint}"
            ),
        },
        Err(FetchError::InvalidUtf8) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!(
                "asimp: {label} failed: response body is not valid UTF-8\n{transport_hint}"
            ),
        },
        Err(FetchError::BodyTooLarge { limit_bytes }) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!(
                "asimp: {label} failed: response exceeds the {limit_bytes}-byte limit\n{transport_hint}"
            ),
        },
    }
}

fn safe_session_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['/', '?', '#', '%', '\\'])
        && value != "."
        && value != ".."
}

fn invalid_session_id() -> CliOutput {
    CliOutput {
        exit_code: 2,
        stdout: String::new(),
        stderr: "asimp: session ID must be one origin-relative path component, not a URL.\n"
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use clap::error::ErrorKind;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn markdown_workshop_preserves_text_and_encodes_metadata_without_a_second_schema() {
        for extra in [
            vec![],
            vec![
                "--relates-to",
                "C-1",
                "--relates-to",
                "H-2\",\"admin\":true",
                "--force-note",
            ],
        ] {
            let cli = Cli::try_parse_from(
                [
                    vec![
                        "asimp",
                        "--origin",
                        "https://example.test",
                        "workshop",
                        "push",
                        "S-123",
                        "--body-file",
                        "draft.md",
                        "--type",
                        "future-kind",
                        "--title",
                        "Quoted \"title\"\n😀",
                        "--idempotency-key",
                        "retained-key",
                    ],
                    extra.clone(),
                ]
                .concat(),
            )
            .unwrap();
            assert!(cli.command.requires_token());
            let draft = "\u{feff}  # Draft\r\n\nA \\\"quote\\\" 😀\u{0001}\n  ";
            let result = run_cli_write(
                &cli,
                |path| {
                    assert_eq!(path, std::path::Path::new("draft.md"));
                    Ok(draft.to_owned())
                },
                |url, key, body| {
                    assert_eq!(url, "https://example.test/v1/sessions/S-123/workshop");
                    assert_eq!(key, "retained-key");
                    let mut expected = serde_json::json!({"type":"future-kind", "title":"Quoted \"title\"\n😀", "body_md":draft, "relates_to":[]});
                    if !extra.is_empty() {
                        expected["relates_to"] = serde_json::json!(["C-1", "H-2\",\"admin\":true"]);
                        expected["force_note"] = serde_json::json!(true);
                    }
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                        expected
                    );
                    // Unknown types deliberately reach the canonical Worker validator.
                    Err(FetchError::Status(422))
                },
            );
            assert_eq!(result.exit_code, 1);
            assert!(result.stdout.is_empty());
            assert!(!result.stderr.contains("Quoted"));
        }
    }

    #[test]
    fn markdown_workshop_requires_complete_exclusive_inputs() {
        for args in [
            vec![],
            vec!["--body-file", "draft.md"],
            vec!["--body-file", "draft.md", "--type", "draft"],
            vec!["--body-file", "draft.md", "--title", "Title"],
            vec![
                "--file",
                "request.json",
                "--body-file",
                "draft.md",
                "--type",
                "draft",
                "--title",
                "Title",
            ],
            vec!["--file", "request.json", "--type", "draft"],
            vec!["--file", "request.json", "--title", "Title"],
            vec!["--file", "request.json", "--relates-to", "C-1"],
            vec!["--file", "request.json", "--force-note"],
        ] {
            assert!(
                Cli::try_parse_from(
                    [
                        vec![
                            "asimp",
                            "workshop",
                            "push",
                            "S-123",
                            "--idempotency-key",
                            "retained-key"
                        ],
                        args.clone()
                    ]
                    .concat()
                )
                .is_err(),
                "accepted incompatible/incomplete input: {args:?}"
            );
        }
    }

    #[test]
    fn markdown_workshop_read_failure_and_encoded_size_limit_stop_before_network() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "workshop",
            "push",
            "S-123",
            "--body-file",
            "private-canary.md",
            "--type",
            "draft",
            "--title",
            "Title",
            "--idempotency-key",
            "retained-key",
        ])
        .unwrap();
        for read in [
            Err("Cannot read input file."),
            Ok("\u{0001}".repeat(100_000)),
        ] {
            let output = run_cli_write(
                &cli,
                |_| read,
                |_, _, _| panic!("failed/oversized input reached network"),
            );
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("canary"));
        }
    }

    #[test]
    fn inline_session_inputs_encode_exact_json_without_reading_files() {
        for (args, path, expected) in [
            (
                vec![
                    "promote",
                    "S-123",
                    "W-abcdefghijklmnopqrstuvwxyz",
                    "--kind",
                    "conjecture",
                    "--statement",
                    "  Every even integer is divisible by two.  ",
                ],
                "/v1/sessions/S-123/promote",
                serde_json::json!({"workshop_id":"W-abcdefghijklmnopqrstuvwxyz", "kind":"conjecture", "statement":"  Every even integer is divisible by two.  ", "relates_to":[], "depends_on":[]}),
            ),
            (
                vec![
                    "promote",
                    "S-123",
                    "W-X\",\"admin\":true",
                    "--kind",
                    "future-kind",
                    "--statement",
                    "Claim \"x\\y\"\n😀",
                    "--falsifier",
                    "Counterexample\n😀",
                    "--relates-to",
                    "C-1",
                    "--relates-to",
                    "H-2",
                    "--depends-on",
                    "C-3",
                    "--depends-on",
                    "C-4\",\"admin\":true",
                ],
                "/v1/sessions/S-123/promote",
                serde_json::json!({"workshop_id":"W-X\",\"admin\":true", "kind":"future-kind", "statement":"Claim \"x\\y\"\n😀", "falsifier":"Counterexample\n😀", "relates_to":["C-1","H-2"], "depends_on":["C-3","C-4\",\"admin\":true"]}),
            ),
            (
                vec!["session", "open", "P-4DSP"],
                "/v1/sessions",
                serde_json::json!({"problem_id":"P-4DSP"}),
            ),
            (
                vec!["session", "open", "P-4DSP", "--intent", "review"],
                "/v1/sessions",
                serde_json::json!({"problem_id":"P-4DSP", "intent":"review"}),
            ),
            (
                vec![
                    "close",
                    "S-123",
                    "--handback",
                    "  C-1: inspect \"x\\y\"\nNext: 😀\u{0007}  ",
                ],
                "/v1/sessions/S-123/close",
                serde_json::json!({"handback":"C-1: inspect \"x\\y\"\nNext: 😀\u{0007}"}),
            ),
            // No duplicate intent/ID schema: unknown values reach the Worker,
            // but JSON metacharacters cannot add fields or alter the endpoint.
            (
                vec![
                    "session",
                    "open",
                    "P-X\",\"admin\":true",
                    "--intent",
                    "future\nintent",
                ],
                "/v1/sessions",
                serde_json::json!({"problem_id":"P-X\",\"admin\":true", "intent":"future\nintent"}),
            ),
        ] {
            let cli = Cli::try_parse_from(
                [
                    vec!["asimp", "--origin", "https://example.test"],
                    args,
                    vec!["--idempotency-key", "same-operation", "--json"],
                ]
                .concat(),
            )
            .unwrap();
            let mut attempts = Vec::new();
            for _ in 0..2 {
                let result = run_cli_write(
                    &cli,
                    |_| panic!("inline input must not read a file"),
                    |url, key, body| {
                        assert_eq!(url, format!("https://example.test{path}"));
                        assert_eq!(key, "same-operation");
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                            expected
                        );
                        attempts.push(body);
                        Ok(Fetched {
                            status: 201,
                            body: "{\"session_id\":\"S-123\"}\n".to_owned(),
                        })
                    },
                );
                assert_eq!(result.exit_code, 0);
                assert_eq!(result.stdout, "{\"session_id\":\"S-123\"}\n");
                assert!(result.stderr.is_empty());
            }
            assert_eq!(
                attempts[0], attempts[1],
                "unchanged input must retain exact replay bytes"
            );
        }
    }

    #[test]
    fn handback_limits_match_worker_utf16_and_ecmascript_trimming() {
        for (input, expected) in [
            ("😀".repeat(1000), Some("😀".repeat(1000))),
            ("😀".repeat(1001), None),
            (
                format!("{}😀", "x".repeat(1998)),
                Some(format!("{}😀", "x".repeat(1998))),
            ),
            (format!("{}😀", "x".repeat(1999)), None),
            (
                format!("\u{feff} {} \u{feff}", "x".repeat(2000)),
                Some("x".repeat(2000)),
            ),
            ("\u{feff}\t\r\n\u{00a0}\u{2028}\u{3000}".to_owned(), None),
            // NEL is Rust whitespace but is deliberately NOT JS .trim() whitespace.
            ("\u{0085}".to_owned(), Some("\u{0085}".to_owned())),
            ("".to_owned(), None),
        ] {
            let cli = Cli::try_parse_from([
                "asimp",
                "--origin",
                "https://example.test",
                "close",
                "S-123",
                "--handback",
                &input,
                "--idempotency-key",
                "op-unicode",
            ])
            .unwrap();
            let mut sent = false;
            let result = run_cli_write(
                &cli,
                |_| panic!("inline handback read a file"),
                |_, _, body| {
                    sent = true;
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                        serde_json::json!({"handback":expected.as_ref().unwrap()})
                    );
                    Ok(Fetched {
                        status: 200,
                        body: "{}".to_owned(),
                    })
                },
            );
            assert_eq!(sent, expected.is_some());
            if expected.is_some() {
                assert_eq!(result.exit_code, 0);
            } else {
                assert_eq!(result.exit_code, 2);
                assert!(result.stdout.is_empty());
                assert!(result.stderr.contains("UTF-16 code units after trimming"));
                assert!(!result.stderr.contains('😀'));
            }
        }
    }

    #[test]
    fn typed_writes_match_existing_contract_fixtures() {
        let open: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/test/fixtures/valid/session-open.json"
        ))
        .unwrap();
        let close: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/test/fixtures/valid/session-close.json"
        ))
        .unwrap();
        let encoded = WriteBody::Open {
            problem: open["problem_id"].as_str().unwrap(),
            intent: open["intent"].as_str(),
        }
        .encode(|_| panic!("not a file"))
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
            open
        );
        let encoded = WriteBody::Handback(close["handback"].as_str().unwrap())
            .encode(|_| panic!("not a file"))
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(result, serde_json::json!({"handback": close["handback"]}));
        let workshop: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/test/fixtures/valid/workshop-push.json"
        ))
        .unwrap();
        let refs: Vec<String> = workshop["relates_to"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        let encoded = WriteBody::Workshop {
            path: std::path::Path::new("draft.md"),
            kind: workshop["type"].as_str().unwrap(),
            title: workshop["title"].as_str().unwrap(),
            relates_to: &refs,
            force_note: false,
        }
        .encode(|_| Ok(workshop["body_md"].as_str().unwrap().to_owned()))
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
            workshop
        );
        let mut promote: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/test/fixtures/valid/promote-request.json"
        ))
        .unwrap();
        let refs: Vec<String> = promote["relates_to"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        let encoded = WriteBody::Promote {
            workshop: promote["workshop_id"].as_str().unwrap(),
            kind: promote["kind"].as_str().unwrap(),
            statement: promote["statement"].as_str().unwrap(),
            falsifier: promote["falsifier"].as_str(),
            relates_to: &refs,
            depends_on: &[],
        }
        .encode(|_| panic!("typed promote read a file"))
        .unwrap();
        // The canonical fixture omits depends_on; its schema default is [].
        promote["depends_on"] = serde_json::json!([]);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
            promote
        );
    }

    #[test]
    fn typed_promotion_rejects_incomplete_or_mixed_inputs() {
        for args in [
            vec![],
            vec!["W-1"],
            vec!["W-1", "--kind", "conjecture"],
            vec!["W-1", "--statement", "Claim"],
            vec![
                "--file",
                "request.json",
                "W-1",
                "--kind",
                "conjecture",
                "--statement",
                "Claim",
            ],
            vec!["--file", "request.json", "--kind", "conjecture"],
            vec!["--file", "request.json", "--statement", "Claim"],
            vec!["--file", "request.json", "--falsifier", "Counterexample"],
            vec!["--file", "request.json", "--relates-to", "C-1"],
            vec!["--file", "request.json", "--depends-on", "C-2"],
        ] {
            assert!(
                Cli::try_parse_from(
                    [
                        vec!["asimp", "promote", "S-123", "--idempotency-key", "op-1"],
                        args.clone()
                    ]
                    .concat()
                )
                .is_err(),
                "accepted incomplete/mixed promotion: {args:?}"
            );
        }
    }

    #[test]
    fn typed_promotion_size_failure_never_sends_or_echoes_claim() {
        let statement = format!("private-canary{}", "\u{0001}".repeat(100_000));
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "promote",
            "S-123",
            "W-1",
            "--kind",
            "conjecture",
            "--statement",
            &statement,
            "--idempotency-key",
            "op-1",
        ])
        .unwrap();
        let result = run_cli_write(
            &cli,
            |_| panic!("typed promote read a file"),
            |_, _, _| panic!("oversized promotion reached network"),
        );
        assert_eq!(result.exit_code, 2);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("Encoded request exceeds 512 KiB"));
        assert!(!result.stderr.contains("canary"));
    }

    #[test]
    fn write_commands_send_exact_json_and_retain_the_key_on_manual_retry() {
        let cases = [
            (vec!["session", "open"], "/v1/sessions", "session-open.json"),
            (
                vec!["workshop", "push", "S-123"],
                "/v1/sessions/S-123/workshop",
                "workshop-push.json",
            ),
            (
                vec![
                    "workshop",
                    "push",
                    "S-123",
                    "--type",
                    "draft",
                    "--title",
                    "Markdown draft",
                ],
                "/v1/sessions/S-123/workshop",
                "../../../../../cli/README.md",
            ),
            (
                vec!["promote", "S-123"],
                "/v1/sessions/S-123/promote",
                "promote-request.json",
            ),
            (
                vec![
                    "promote",
                    "S-123",
                    "W-abcdefghijklmnopqrstuvwxyz",
                    "--kind",
                    "conjecture",
                    "--statement",
                    "Every even integer is divisible by two.",
                    "--falsifier",
                    "An even integer with nonzero remainder modulo two.",
                ],
                "/v1/sessions/S-123/promote",
                "promote-request.json",
            ),
            (
                vec!["close", "S-123"],
                "/v1/sessions/S-123/close",
                "session-close.json",
            ),
        ];
        for (args, expected_path, fixture) in cases {
            let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../packages/contracts/test/fixtures/valid")
                .join(fixture);
            let markdown = args.contains(&"--type");
            let typed_promote = args.contains(&"--kind");
            let mut args = [vec!["asimp", "--origin", "https://example.test"], args].concat();
            if !typed_promote {
                args.extend([
                    if markdown { "--body-file" } else { "--file" },
                    file.to_str().unwrap(),
                ]);
            }
            args.extend(["--idempotency-key", "retained-operation-1", "--json"]);
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(cli.command.requires_token());
            let source = std::fs::read_to_string(&file).unwrap();
            let expected_body = if typed_promote {
                serde_json::to_string(&serde_json::json!({"workshop_id":"W-abcdefghijklmnopqrstuvwxyz", "kind":"conjecture", "statement":"Every even integer is divisible by two.", "falsifier":"An even integer with nonzero remainder modulo two.", "relates_to":[], "depends_on":[]})).unwrap()
            } else if markdown {
                serde_json::to_string(&serde_json::json!({"type":"draft", "title":"Markdown draft", "body_md":source, "relates_to":[]})).unwrap()
            } else {
                source
            };
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            // This server records requests, not D1 commits: it proves transport
            // parity and caller-retained replay input, not exactly-once storage.
            let server = thread::spawn(move || {
                let mut requests = Vec::new();
                for attempt in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        let mut byte = [0];
                        stream.read_exact(&mut byte).unwrap();
                        bytes.push(byte[0]);
                        assert!(bytes.len() < 16 * 1024);
                        if bytes.ends_with(b"\r\n\r\n") {
                            break bytes.len();
                        }
                    };
                    let headers = String::from_utf8(bytes.clone()).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    assert!(length <= MAX_REQUEST_BYTES as usize);
                    bytes.resize(header_end + length, 0);
                    stream.read_exact(&mut bytes[header_end..]).unwrap();
                    requests.push((
                        headers,
                        String::from_utf8(bytes[header_end..].to_vec()).unwrap(),
                    ));
                    // Lose the first response after reading the complete request.
                    if attempt == 1 {
                        stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"accepted\":1}\n").unwrap();
                    }
                }
                requests
            });
            let send = |url: &str, key: &str, body: String| {
                assert_eq!(url, format!("https://example.test{expected_path}"));
                request_text_with_agent(
                    &agent_with_timeout(std::time::Duration::from_secs(2)),
                    &format!("http://{address}{expected_path}"),
                    Some("asimp_ag_transport_canary"),
                    Some((key, &body)),
                )
            };
            let first = run_cli_write(&cli, read_request_file, send);
            assert_eq!(first.exit_code, 2);
            assert!(first.stdout.is_empty());
            assert!(first.stderr.contains("SAME --idempotency-key"));
            let second = run_cli_write(&cli, read_request_file, send);
            assert_eq!(second.exit_code, 0);
            assert_eq!(second.stdout, "{\"accepted\":1}\n");
            assert!(second.stderr.is_empty());
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 2);
            for (headers, body) in requests {
                assert!(headers.starts_with(&format!("POST {expected_path} HTTP/1.1\r\n")));
                for (name, expected) in [
                    ("authorization", "Bearer asimp_ag_transport_canary"),
                    ("idempotency-key", "retained-operation-1"),
                    ("content-type", "application/json"),
                    ("user-agent", OUTBOUND_USER_AGENT),
                ] {
                    assert_eq!(
                        headers.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name).then_some(value.trim())
                        }),
                        Some(expected)
                    );
                }
                assert_eq!(body, expected_body);
            }
        }
    }

    #[test]
    fn write_validation_precedes_file_read_and_network_and_never_echoes_input() {
        for (session, key, origin) in [
            ("../canary", "valid-key", "https://example.test"),
            ("S-1?canary", "valid-key", "https://example.test"),
            ("S-1", "key-canary\r\nx: bad", "https://example.test"),
            ("S-1", "valid-key", "https://secret-canary@example.test"),
        ] {
            let cli = Cli::try_parse_from([
                "asimp",
                "--origin",
                origin,
                "close",
                session,
                "--file",
                "private-canary.json",
                "--idempotency-key",
                key,
            ])
            .unwrap();
            let output = run_cli_write(
                &cli,
                |_| panic!("invalid invocation read private file"),
                |_, _, _| panic!("invalid invocation reached network"),
            );
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.contains("canary"));
        }
    }

    #[test]
    fn write_failures_are_single_attempt_body_free_and_teach_recovery() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "promote",
            "S-canary",
            "--file",
            "private-canary.json",
            "--idempotency-key",
            "key-canary",
        ])
        .unwrap();
        for error in [
            FetchError::Network,
            FetchError::InvalidUtf8,
            FetchError::BodyTooLarge {
                limit_bytes: MAX_BODY_BYTES,
            },
            FetchError::Status(302),
            FetchError::Status(400),
            FetchError::Status(401),
            FetchError::Status(403),
            FetchError::Status(404),
            FetchError::Status(409),
            FetchError::Status(413),
            FetchError::Status(422),
            FetchError::Status(429),
            FetchError::Status(503),
        ] {
            let ambiguous = !matches!(error, FetchError::Status(300..=428));
            let mut attempts = 0;
            let result = run_cli_write(
                &cli,
                |_| Ok("private-body-canary".to_owned()),
                |_, _, _| {
                    attempts += 1;
                    Err(error)
                },
            );
            assert_eq!(attempts, 1);
            assert_ne!(result.exit_code, 0);
            assert!(result.stdout.is_empty());
            assert!(!result.stderr.contains("canary"));
            assert!(result.stderr.lines().count() >= 2);
            if ambiguous {
                assert!(result.stderr.contains("SAME --idempotency-key"));
            }
        }
    }

    #[test]
    fn post_refuses_redirects_and_incomplete_or_invalid_response_bodies() {
        for (response, expected_status) in [
            (b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /redirect-destination\r\nContent-Length: 6\r\nConnection: close\r\n\r\ncanary".as_slice(), Some(307)),
            (b"HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 6\r\nConnection: close\r\n\r\ncanary".as_slice(), Some(422)),
            (b"HTTP/1.1 201 Created\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial-canary".as_slice(), None),
            (b"HTTP/1.1 201 Created\r\nContent-Length: 1\r\nConnection: close\r\n\r\n\xff".as_slice(), None),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    assert!(bytes.len() < 16 * 1024);
                }
                let mut body = [0; 2];
                stream.read_exact(&mut body).unwrap();
                assert_eq!(&body, b"{}");
                stream.write_all(response).unwrap();
                drop(stream);
                listener
            });
            let result = request_text_with_agent(&agent_with_timeout(std::time::Duration::from_secs(2)),
                &format!("http://{address}/write"), Some("asimp_ag_canary"), Some(("key-canary", "{}")));
            assert!(result.is_err());
            if let Some(expected) = expected_status {
                assert!(matches!(result, Err(FetchError::Status(actual)) if actual == expected));
            }
            assert!(!format!("{result:?}").contains("canary"));
            let listener = server.join().unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                "POST followed a redirect or retried automatically");
        }
    }

    #[test]
    fn request_reader_rejects_special_files_and_enforces_utf8_and_size_boundaries() {
        for path in [
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
            std::path::Path::new("/dev/null"),
        ] {
            assert!(read_request_file(path).is_err());
        }
        let exact = vec![b'x'; MAX_REQUEST_BYTES as usize];
        assert_eq!(
            read_capped_at(exact.as_slice(), MAX_REQUEST_BYTES)
                .unwrap()
                .len(),
            exact.len()
        );
        assert!(matches!(
            read_capped_at(
                vec![b'x'; MAX_REQUEST_BYTES as usize + 1].as_slice(),
                MAX_REQUEST_BYTES
            ),
            Err(FetchError::BodyTooLarge { .. })
        ));
        assert!(matches!(
            read_capped_at(&[0xff][..], MAX_REQUEST_BYTES),
            Err(FetchError::InvalidUtf8)
        ));
    }

    #[test]
    fn help_describes_asimp_as_optional() {
        let help = Cli::command().render_help().to_string();
        assert!(help.contains("Usage: asimp"));
        assert!(help.contains("Curl remains sufficient."));
    }

    #[test]
    fn capabilities_accepts_explicit_json_without_reformatting_the_worker_face() {
        for explicit_json in [false, true] {
            let mut args = vec!["asimp", "--origin", "https://example.test", "capabilities"];
            if explicit_json {
                args.push("--json");
            }
            let cli = Cli::try_parse_from(args).unwrap();
            let body = "{\n  \"features\": [\"synthetic-read\"]\n}\n";
            let output = run_cli_with_fetch(&cli, |url| {
                assert_eq!(url, "https://example.test/capabilities");
                Ok(Fetched {
                    status: 200,
                    body: body.to_string(),
                })
            });
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, body);
            assert!(output.stderr.is_empty());

            let invalid = Cli {
                origin: Some("http://example.test".to_string()),
                ..cli
            };
            let output = run_cli_with_fetch(&invalid, |_| panic!("invalid origin must not fetch"));
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
        }
    }

    #[test]
    fn empty_input_requests_help() {
        let error = Cli::try_parse_from(["asimp"]).expect_err("no args means help");
        assert_eq!(
            error.kind(),
            ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        );
    }

    #[test]
    fn build_url_accepts_documented_faces_and_queries() {
        let origin = "https://a.asimposium.org";
        assert_eq!(
            build_url(origin, "/capabilities").unwrap(),
            "https://a.asimposium.org/capabilities"
        );
        assert_eq!(
            build_url(origin, "/v1/sessions/S-1/pack?profile=working").unwrap(),
            "https://a.asimposium.org/v1/sessions/S-1/pack?profile=working"
        );
    }

    #[test]
    fn build_url_rejects_the_escape_and_proxy_shapes() {
        let origin = "https://a.asimposium.org";
        for bad in [
            "capabilities",
            "//evil.test/x",
            "https://evil.test/x",
            "/a#fragment",
            "/\\evil.test/x",
            "/../capabilities",
            "/a/./b",
            "/%2f%2fevil.test/x",
            "/trailing-space ",
            "/query?value=raw space",
            "/a\nb",
            "",
        ] {
            assert!(build_url(origin, bad).is_err(), "expected reject: {bad:?}");
        }
    }

    #[test]
    fn resolve_origin_prefers_flag_then_env_then_default() {
        assert_eq!(
            resolve_origin(Some(&"https://staging.example".to_string())).unwrap(),
            "https://staging.example"
        );
        let error = resolve_origin(Some(&"http://insecure.example".to_string())).unwrap_err();
        assert!(error.contains("https"));
        assert_eq!(
            resolve_environment_origin(Ok("https://configured.example".to_string())).unwrap(),
            "https://configured.example"
        );
        assert_eq!(
            resolve_environment_origin(Err(std::env::VarError::NotPresent)).unwrap(),
            DEFAULT_ORIGIN
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_environment_origin_is_refused_instead_of_falling_back_to_production() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let error = resolve_environment_origin(Err(std::env::VarError::NotUnicode(
            OsString::from_vec(vec![0xff]),
        )))
        .unwrap_err();
        assert_eq!(error, "ASIMP_ORIGIN must be valid UTF-8");
    }

    #[test]
    fn resolve_origin_rejects_authority_confusion_and_non_origin_components() {
        for bad in [
            "https://user@example.test",
            "https://@example.test",
            "https://example.test/path",
            "https://example.test/.",
            "https://example.test/%2e",
            "https://example.test?query=1",
            "https://example.test#fragment",
            "https://example.test/",
            "https://example.test ",
            "https:\\example.test",
            "https://example.test\n.evil.test",
        ] {
            assert!(
                resolve_origin(Some(&bad.to_string())).is_err(),
                "expected reject: {bad:?}"
            );
        }
        assert_eq!(
            resolve_origin(Some(&"https://example.test:8443".to_string())).unwrap(),
            "https://example.test:8443"
        );
    }

    #[test]
    fn capped_reader_distinguishes_exact_limit_from_truncation() {
        assert_eq!(read_capped_at("abcd".as_bytes(), 4).unwrap(), "abcd");
        let error = read_capped_at("abcde".as_bytes(), 4).unwrap_err();
        assert!(matches!(error, FetchError::BodyTooLarge { limit_bytes: 4 }));

        let exact = vec![b'x'; MAX_BODY_BYTES as usize];
        assert_eq!(
            read_capped(exact.as_slice()).unwrap().len(),
            MAX_BODY_BYTES as usize
        );
        let over = vec![b'x'; MAX_BODY_BYTES as usize + 1];
        assert!(matches!(
            read_capped(over.as_slice()),
            Err(FetchError::BodyTooLarge {
                limit_bytes: MAX_BODY_BYTES
            })
        ));
    }

    #[test]
    fn the_connect_and_read_budget_is_fifteen_seconds_not_milliseconds_as_seconds() {
        assert_eq!(READ_TIMEOUT, std::time::Duration::from_secs(15));
        assert_ne!(READ_TIMEOUT, std::time::Duration::from_secs(15_000));
    }

    #[test]
    fn the_http_agent_sends_the_required_exact_user_agent() {
        for token in [None, Some("asimp_ag_synthetic_header_canary")] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "client closed before sending complete headers");
                    request.extend_from_slice(&chunk[..count]);
                    assert!(
                        request.len() <= 16 * 1024,
                        "request headers exceeded test bound"
                    );
                }
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .unwrap();
                String::from_utf8(request).unwrap()
            });

            let fetched = fetch_text_with_agent(
                &agent_with_timeout(std::time::Duration::from_secs(1)),
                &format!("http://{address}/user-agent"),
                token,
            )
            .unwrap();
            let request = server.join().unwrap();
            let user_agent = request
                .split("\r\n")
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("user-agent")
                        .then_some(value.trim())
                })
                .expect("request must carry a User-Agent header");

            assert_eq!(fetched.status, 200);
            assert_eq!(fetched.body, "ok");
            assert_eq!(user_agent, OUTBOUND_USER_AGENT);
            let authorization = request.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then_some(value.trim())
            });
            assert_eq!(
                authorization.map(str::to_owned),
                token.map(|value| format!("Bearer {value}"))
            );
            assert!(!request.lines().next().unwrap().contains("asimp_ag_"));
        }
    }

    #[test]
    fn the_configured_timeout_causally_stops_a_stalled_response_read() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut first_request_byte = [0_u8; 1];
            stream.read_exact(&mut first_request_byte).unwrap();
            thread::sleep(std::time::Duration::from_millis(200));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });

        let started = std::time::Instant::now();
        let result = fetch_text_with_agent(
            &agent_with_timeout(std::time::Duration::from_millis(20)),
            &format!("http://{address}/stalled"),
            None,
        );
        let elapsed = started.elapsed();
        server.join().unwrap();

        assert!(matches!(result, Err(FetchError::Network)));
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "elapsed={elapsed:?}"
        );
    }

    #[test]
    fn the_global_deadline_causally_bounds_a_stalled_dns_resolver() {
        let (entered_sender, entered_receiver) = std::sync::mpsc::sync_channel(1);
        let (finished_sender, finished_receiver) = std::sync::mpsc::sync_channel(1);
        let resolver = move |_: &str| {
            entered_sender.send(()).unwrap();
            thread::sleep(std::time::Duration::from_millis(500));
            finished_sender.send(()).unwrap();
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "planted resolver stall",
            ))
        };
        let agent = AgentBuilder::new()
            .resolver(resolver)
            .timeout(std::time::Duration::from_secs(1))
            .redirects(0)
            .build();

        let started = std::time::Instant::now();
        let result = fetch_text_with_deadline(
            agent,
            "http://resolver-stall.invalid/read".to_string(),
            std::time::Duration::from_millis(20),
            None,
        );
        let elapsed = started.elapsed();

        entered_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("the planted resolver must run");
        assert!(matches!(result, Err(FetchError::Network)));
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "elapsed={elapsed:?}"
        );
        finished_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("the planted resolver must finish");
    }

    #[test]
    fn over_limit_bodies_never_cross_the_cli_stdout_boundary() {
        for (command, expected_stderr) in [
            (
                Command::Capabilities { json: false },
                "asimp: /capabilities failed: response exceeds the 8388608-byte limit\n",
            ),
            (
                Command::Problems { json: true },
                "asimp: /problems.json failed: response exceeds the 8388608-byte limit\n",
            ),
            (
                Command::Get {
                    path: "/protocol.md".to_string(),
                },
                "asimp: GET request failed: response exceeds the 8388608-byte limit\n",
            ),
        ] {
            let cli = Cli {
                origin: Some("https://example.test".to_string()),
                command,
            };
            let oversized = vec![b'x'; MAX_BODY_BYTES as usize + 1];
            let output = run_cli_with_fetch(&cli, move |_| {
                let body = read_capped(oversized.as_slice())?;
                Ok(Fetched { status: 200, body })
            });

            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            assert_eq!(output.stderr, expected_stderr);
        }
    }

    #[test]
    fn fetch_text_refuses_redirects_instead_of_changing_origin() {
        for token in [None, Some("asimp_ag_redirect_canary")] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "client closed before sending complete headers");
                    request.extend_from_slice(&chunk[..count]);
                    assert!(
                        request.len() <= 16 * 1024,
                        "request headers exceeded test bound"
                    );
                }
                stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nContent-Length: 31\r\nConnection: close\r\n\r\ncredential-shaped-response-body",
                )
                .unwrap();
            });

            let result = fetch_text_authenticated(&format!("http://{address}/start"), token);
            server.join().unwrap();
            assert!(!format!("{result:?}").contains("credential-shaped-response-body"));
            assert!(
                matches!(result, Err(FetchError::Status(302))),
                "expected a refused 302 response, got {result:?}"
            );
        }
    }

    #[test]
    fn private_reads_preserve_worker_json_and_encode_pack_options() {
        for (args, expected) in [
            (vec!["hello", "--json"], "/v1/hello"),
            (
                vec!["session", "status", "S-123", "--json"],
                "/v1/sessions/S-123",
            ),
            (
                vec![
                    "pack",
                    "S-123",
                    "--profile",
                    "review",
                    "--target",
                    "C-1@2",
                    "--max-tokens",
                    "5000",
                ],
                "/v1/sessions/S-123/pack?profile=review&max_tokens=5000&target=C-1%402",
            ),
        ] {
            let cli = Cli::try_parse_from(
                [vec!["asimp", "--origin", "https://example.test"], args].concat(),
            )
            .unwrap();
            let body = "{\"omitted\":[{\"reason\":\"budget_exceeded\"}],\"next_actions\":[]}\n";
            let result = run_cli_with_fetch(&cli, |url| {
                assert_eq!(url, format!("https://example.test{expected}"));
                Ok(Fetched {
                    status: 200,
                    body: body.to_string(),
                })
            });
            assert_eq!(result.stdout, body);
            assert_eq!(result.exit_code, 0);
            assert!(result.stderr.is_empty());
        }
    }

    #[test]
    fn ambient_token_is_only_read_for_explicit_private_commands() {
        for args in [
            vec!["capabilities"],
            vec!["problems"],
            vec!["search", "text"],
            vec!["get", "/v1/hello"],
        ] {
            let cli = Cli::try_parse_from([vec!["asimp"], args].concat()).unwrap();
            assert_eq!(
                token_for_command(&cli.command, || panic!(
                    "public read consulted credential environment"
                ))
                .unwrap(),
                None
            );
        }
        for args in [
            vec!["hello"],
            vec!["session", "status", "S-1"],
            vec!["pack", "S-1"],
        ] {
            let cli = Cli::try_parse_from([vec!["asimp"], args].concat()).unwrap();
            assert_eq!(
                token_for_command(&cli.command, || Ok("asimp_ag_synthetic".to_string())).unwrap(),
                Some("asimp_ag_synthetic".to_string())
            );
            assert!(
                token_for_command(&cli.command, || Err(std::env::VarError::NotPresent)).is_err()
            );
            for token in [
                "",
                "Bearer secret",
                "secret\r\nx-header: injected",
                "secret\t",
                "secret☃",
            ] {
                let error = token_for_command(&cli.command, || Ok(token.to_string())).unwrap_err();
                assert!(!error.contains("secret"));
            }
        }
    }

    #[test]
    fn private_read_paths_cannot_escape_the_session_component() {
        for id in [
            "",
            "..",
            "S-1/workshop",
            "S-1?query",
            "S-1#fragment",
            "%2f",
            "https://other.test",
            "S-1\\other",
        ] {
            for args in [vec!["session", "status", id], vec!["pack", id]] {
                let cli = Cli::try_parse_from(
                    [vec!["asimp", "--origin", "https://example.test"], args].concat(),
                )
                .unwrap();
                let result = run_cli_with_fetch(&cli, |_| panic!("unsafe path reached transport"));
                assert_eq!(result.exit_code, 2);
                assert!(result.stdout.is_empty());
                assert!(!result.stderr.contains("other.test"));
            }
        }
    }

    #[test]
    fn private_read_errors_offer_recovery_without_echoing_context() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "pack",
            "private-session-canary",
            "--target",
            "private-target-canary",
        ])
        .unwrap();
        for status in [400, 401, 403, 404, 422, 429, 503] {
            let result = run_cli_with_fetch(&cli, |_| Err(FetchError::Status(status)));
            assert_eq!(result.exit_code, 1);
            assert!(result.stdout.is_empty());
            assert!(result.stderr.contains(&format!("HTTP {status}")));
            assert!(!result.stderr.contains("canary"));
            assert!(result.stderr.lines().count() > 1);
        }
    }

    #[test]
    fn problems_path_tracks_the_json_flag() {
        assert_eq!(problems_path(false), "/problems.md");
        assert_eq!(problems_path(true), "/problems.json");
    }

    #[test]
    fn search_encodes_literal_queries_and_preserves_the_complete_face() {
        for query in [
            "P-EXAMPLE#C-1",
            "∀x ∈ ℝ: x² ≥ 0",
            "C++ & 50% + a/b?kind=fellow#fragment",
            "x\n\tOR NOT y",
            "https://elsewhere.test/?q=x&limit=999",
        ] {
            for (json_flag, face, body) in [
                (
                    false,
                    "/search.md",
                    "# Search\n\nSynthetic result\n\nOmitted: workshop\n",
                ),
                (
                    true,
                    "/search.json",
                    "{\"items\":[],\"omitted\":[{\"reason\":\"private\"}],\"next_actions\":[]}\n",
                ),
            ] {
                let mut args = vec!["asimp", "--origin", "https://example.test", "search", query];
                if json_flag {
                    args.push("--json");
                }
                let cli = Cli::try_parse_from(args).unwrap();
                let output = run_cli_with_fetch(&cli, |url| {
                    let url = Url::parse(url).unwrap();
                    assert_eq!(url.origin().ascii_serialization(), "https://example.test");
                    assert_eq!(url.path(), face);
                    assert_eq!(url.fragment(), None);
                    let pairs: Vec<_> = url.query_pairs().collect();
                    assert_eq!(pairs.len(), 1);
                    assert_eq!(pairs[0].0, "q");
                    assert_eq!(pairs[0].1, query);
                    Ok(Fetched {
                        status: 200,
                        body: body.to_string(),
                    })
                });
                assert_eq!(output.exit_code, 0);
                assert_eq!(output.stdout, body);
                assert!(output.stderr.is_empty());
            }
        }
    }

    #[test]
    fn search_forwards_filters_without_inventing_a_second_contract() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "search",
            "bounded proof",
            "--kind",
            "future-kind&limit=999",
            "--limit",
            "7",
            "--json",
        ])
        .unwrap();
        let output = run_cli_with_fetch(&cli, |url| {
            assert_eq!(
                url,
                "https://example.test/search.json?q=bounded+proof&kind=future-kind%26limit%3D999&limit=7"
            );
            // The canonical Worker, not a duplicate CLI enum, owns kind validation.
            Err(FetchError::Status(400))
        });
        assert_eq!(output.exit_code, 1);
        assert!(output.stdout.is_empty());
        assert_eq!(
            output.stderr,
            "asimp: /search.json returned HTTP 400\nUse a non-empty query, qualify local claim IDs as P-ID#C-n, and check filters with asimp search --help.\n"
        );
    }

    #[test]
    fn search_failures_never_reflect_query_text() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "search",
            "QUERY_CANARY_7f2",
        ])
        .unwrap();
        for (error, expected_code) in [
            (FetchError::Status(404), 1),
            (FetchError::Status(503), 1),
            (FetchError::Network, 2),
            (FetchError::InvalidUtf8, 2),
            (
                FetchError::BodyTooLarge {
                    limit_bytes: MAX_BODY_BYTES,
                },
                2,
            ),
        ] {
            let output = run_cli_with_fetch(&cli, |_| Err(error));
            assert_eq!(output.exit_code, expected_code);
            assert!(output.stdout.is_empty());
            assert!(output.stderr.starts_with("asimp: /search.md"));
            assert!(!output.stderr.contains("QUERY_CANARY_7f2"));
        }
        let invalid = Cli {
            origin: Some("http://example.test".to_string()),
            ..cli
        };
        let output = run_cli_with_fetch(&invalid, |_| panic!("invalid origin must not fetch"));
        assert_eq!(output.exit_code, 2);
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.contains("QUERY_CANARY_7f2"));
    }
}
