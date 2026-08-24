//! Pure surface for the `asimp` companion: origin resolution, URL building,
//! and the read-side HTTP seam. Everything here is offline-testable; `main.rs`
//! owns only argument parsing and printing.
//!
//! OPS.1 kept this crate a deliberate stub. The W11.1 slice starts the real
//! scaffold with the reads that need no credentials: `/capabilities`,
//! `/problems.md|json`, and a validated raw `get`. Curl remains sufficient —
//! this CLI is a convenience, never a requirement (Fable §1).

use clap::Parser;
use std::io::BufRead;
use ureq::{Agent, AgentBuilder};

/// Parsed command line for the optional `asimp` companion.
#[derive(Debug, Parser)]
#[command(
    name = "asimp",
    version,
    arg_required_else_help = true,
    about = "Optional ASImposium command-line companion. Curl remains sufficient.",
    long_about = "Optional ASImposium command-line companion. Reads the public agent surface on a.asimposium.org. Write commands arrive with later W11 slices."
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
    /// Print the Worker's capability document (`/capabilities`).
    Capabilities,
    /// Print the problem index (`/problems.md`, or `/problems.json` with --json).
    Problems {
        /// Prefer the JSON face over Markdown.
        #[arg(long)]
        json: bool,
    },
    /// GET an origin-relative path and print the body verbatim.
    Get { path: String },
}

pub const DEFAULT_ORIGIN: &str = "https://a.asimposium.org";
const READ_TIMEOUT_MS: u64 = 15_000;
/// Public faces are bounded well below this; the cap only stops a hostile
/// or misconfigured origin from streaming forever into a terminal.
const MAX_BODY_BYTES: u64 = 8 * 1024 * 1024;

/// Origin precedence: explicit flag beats ASIMP_ORIGIN env beats production.
pub fn resolve_origin(explicit: Option<&String>) -> Result<String, String> {
    let candidate: String = match explicit {
        Some(value) => value.clone(),
        None => std::env::var("ASIMP_ORIGIN").unwrap_or_else(|_| DEFAULT_ORIGIN.to_string()),
    };
    validate_origin(&candidate).map(str::to_string)
}

fn validate_origin(origin: &str) -> Result<&str, String> {
    if !origin.starts_with("https://") {
        return Err("origin must be an https:// URL".to_string());
    }
    if origin.len() <= "https://".len() || origin.ends_with('/') {
        return Err(
            "origin must be an https URL with a non-empty host and no trailing slash".to_string(),
        );
    }
    Ok(origin)
}

/// Join a validated origin with an origin-relative path. The path must be
/// absolute, single-slash, free of control characters, and carry no fragment:
/// these are GETs against documented faces, not an open proxy.
pub fn build_url(origin: &str, path: &str) -> Result<String, String> {
    let origin = validate_origin(origin)?;
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("path must be absolute and start with a single '/'".to_string());
    }
    if path.contains('#') || path.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("path must not contain a fragment or control characters".to_string());
    }
    Ok(format!("{origin}{path}"))
}

/// What one read turned into: status line plus the body bytes as UTF-8.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub status: u16,
    pub body: String,
}

#[derive(Debug)]
pub enum FetchError {
    /// Non-2xx from the agent origin; carries the status and its problem body.
    Status(u16, String),
    Network(String),
}

fn agent() -> Agent {
    AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(READ_TIMEOUT_MS))
        .build()
}

fn read_capped(reader: impl BufRead) -> Result<String, String> {
    reader
        .take(MAX_BODY_BYTES)
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map(|lines| lines.join("\n"))
        .map_err(|error| error.to_string())
}

/// GET one full URL, bounding the response body. Redirects fail by default in
/// ureq for good reason here: the faces are origin-pinned, so a redirect is
/// either a misconfigured origin or an attempt to move the reader.
pub fn fetch_text(url: &str) -> Result<Fetched, FetchError> {
    let response = agent().get(url).call().map_err(|error| match error {
        ureq::Error::Status(code, response) => {
            let body = read_capped(response.into_reader()).unwrap_or_default();
            FetchError::Status(code, body)
        }
        other => FetchError::Network(other.to_string()),
    })?;

    let status = response.status();
    let body = read_capped(response.into_reader()).map_err(FetchError::Network)?;
    Ok(Fetched { status, body })
}

/// The path for a `problems` invocation.
pub fn problems_path(json: bool) -> &'static str {
    if json {
        "/problems.json"
    } else {
        "/problems.md"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, ErrorKind};

    #[test]
    fn help_describes_asimp_as_optional() {
        let help = Cli::command().render_help().to_string();
        assert!(help.contains("Usage: asimp"));
        assert!(help.contains("Curl remains sufficient."));
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
        let _ = resolve_origin(None).unwrap();
    }

    #[test]
    fn problems_path_tracks_the_json_flag() {
        assert_eq!(problems_path(false), "/problems.md");
        assert_eq!(problems_path(true), "/problems.json");
    }
}
