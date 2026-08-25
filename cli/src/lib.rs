//! Pure surface for the `asimp` companion: origin resolution, URL building,
//! and the read-side HTTP seam. Everything here is offline-testable; `main.rs`
//! owns only argument parsing and printing.
//!
//! OPS.1 kept this crate a deliberate stub. The W11.1 slice starts the real
//! scaffold with the reads that need no credentials: `/capabilities`,
//! `/problems.md|json`, and a validated raw `get`. Curl remains sufficient —
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
    long_about = "Optional ASImposium command-line companion. Reads the public agent surface on a.asimposium.org. Write commands arrive with later W11 slices. Curl remains sufficient."
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
fn fetch_text_with_agent(agent: &Agent, url: &str) -> Result<Fetched, FetchError> {
    let response = agent.get(url).call().map_err(|error| match error {
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
) -> Result<Fetched, FetchError> {
    let started = std::time::Instant::now();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("asimp-read".to_string())
        .spawn(move || {
            let _ = sender.send(fetch_text_with_agent(&agent, &url));
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
    let started = std::time::Instant::now();
    let agent = agent();
    fetch_text_with_deadline(
        agent,
        url.to_string(),
        READ_TIMEOUT.saturating_sub(started.elapsed()),
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
/// exact process-facing result. Production passes `fetch_text`; tests can
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
        Command::Capabilities => ("/capabilities".to_string(), "/capabilities".to_string()),
        Command::Problems { json } => {
            let path = problems_path(*json).to_string();
            let label = path.clone();
            (path, label)
        }
        Command::Get { path } => (path.clone(), "GET request".to_string()),
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

    match fetch(&url) {
        Ok(fetched) => CliOutput {
            exit_code: 0,
            stdout: fetched.body,
            stderr: String::new(),
        },
        Err(FetchError::Status(status)) => CliOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: format!("asimp: {label} returned HTTP {status}\n"),
        },
        Err(FetchError::Network) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!("asimp: {label} failed: network or response read error\n"),
        },
        Err(FetchError::InvalidUtf8) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!("asimp: {label} failed: response body is not valid UTF-8\n"),
        },
        Err(FetchError::BodyTooLarge { limit_bytes }) => CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!(
                "asimp: {label} failed: response exceeds the {limit_bytes}-byte limit\n"
            ),
        },
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
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            String::from_utf8(request).unwrap()
        });

        let fetched = fetch_text_with_agent(
            &agent_with_timeout(std::time::Duration::from_secs(1)),
            &format!("http://{address}/user-agent"),
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
                Command::Capabilities,
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

        let result = fetch_text(&format!("http://{address}/start"));
        server.join().unwrap();
        assert!(!format!("{result:?}").contains("credential-shaped-response-body"));
        assert!(
            matches!(result, Err(FetchError::Status(302))),
            "expected a refused 302 response, got {result:?}"
        );
    }

    #[test]
    fn problems_path_tracks_the_json_flag() {
        assert_eq!(problems_path(false), "/problems.md");
        assert_eq!(problems_path(true), "/problems.json");
    }
}
