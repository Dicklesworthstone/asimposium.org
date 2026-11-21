//! Protocol-version negotiation and deprecation-header handling (W6.6 / W11.2,
//! `asimposiumorg-l3b`).
//!
//! Mirrors `apps/wire/src/app.ts:1207-1253` and `discovery.ts:108-118`:
//! - Every outbound request carries `asimp-protocol-version`.
//! - If the Worker replies with an unsupported/future protocol version or
//!   `400 UNSUPPORTED_PROTOCOL_VERSION`, `asimp` refuses the mismatch with a
//!   concrete upgrade/version hint and never prints incompatible response bytes
//!   to stdout.
//! - If the Worker replies with `Deprecation` or `Sunset` headers (for example
//!   when speaking `0.1.0`), `asimp` surfaces a single clean warning line on
//!   stderr while leaving stdout verbatim.

use serde_json::Value;

/// Current default protocol version matching `DISCOVERY_VERSION` in `apps/wire`.
pub const DEFAULT_PROTOCOL_VERSION: &str = "0.2.0-draft";

/// Protocol versions this build of `asimp` understands safely, matching
/// `SUPPORTED_PROTOCOL_VERSIONS` in `apps/wire/src/discovery/discovery.ts:111`.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["0.2.0-draft", "0.1.0"];

/// Wire header name used by Stoa (`apps/wire/src/app.ts:1209`).
pub const PROTOCOL_VERSION_HEADER: &str = "asimp-protocol-version";

/// Safe token shape for protocol versions so hostile headers are never echoed verbatim.
fn is_safe_version_token(value: &str) -> bool {
    let b = value.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_digit()
        && b.iter()
            .all(|&c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
}

fn is_safe_header_snippet(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|b| (0x20..=0x7e).contains(&b) && b != b'<' && b != b'>')
}

/// Precedence: explicit `--protocol-version` flag > `ASIMP_PROTOCOL_VERSION` env > default.
pub fn resolve_protocol_version(explicit: Option<&String>) -> Result<String, String> {
    let candidate = match explicit {
        Some(value) => value.clone(),
        None => match std::env::var("ASIMP_PROTOCOL_VERSION") {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => DEFAULT_PROTOCOL_VERSION.to_owned(),
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("ASIMP_PROTOCOL_VERSION must be valid UTF-8.".to_owned());
            }
        },
    };
    validate_client_protocol_version(&candidate).map(str::to_owned)
}

pub fn validate_client_protocol_version(version: &str) -> Result<&str, String> {
    if !is_safe_version_token(version) {
        return Err(format!(
            "Protocol version must be a semantic version token (supported by this build: {}).",
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        ));
    }
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
        return Err(format!(
            "Protocol version '{version}' is not supported by this asimp build. Supported versions: {}. Upgrade asimp or omit --protocol-version to use '{DEFAULT_PROTOCOL_VERSION}'.",
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        ));
    }
    Ok(version)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolMismatch {
    pub requested: String,
    pub server_version: Option<String>,
    pub supported_by_server: Vec<String>,
}

impl ProtocolMismatch {
    pub fn render_stderr(&self) -> String {
        let mut message = match &self.server_version {
            Some(server) => format!(
                "asimp: incompatible protocol version '{server}' returned by server (client supports: {}).\n",
                SUPPORTED_PROTOCOL_VERSIONS.join(", ")
            ),
            None => format!(
                "asimp: server rejected protocol version '{}' as unsupported.\n",
                self.requested
            ),
        };
        if !self.supported_by_server.is_empty() {
            message.push_str(&format!(
                "Server advertises supported versions: {}.\n",
                self.supported_by_server.join(", ")
            ));
        }
        message.push_str(&format!(
            "Upgrade asimp, or check `asimp capabilities --json` on the same origin; this build supports {}.\n",
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        ));
        message
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeprecationNotice {
    pub protocol_version: Option<String>,
    pub deprecation: Option<String>,
    pub sunset: Option<String>,
    pub sunset_link: Option<String>,
}

impl DeprecationNotice {
    pub fn render_stderr(&self) -> String {
        let version = self
            .protocol_version
            .as_deref()
            .unwrap_or("negotiated protocol");
        let mut details = Vec::new();
        if let Some(dep) = &self.deprecation {
            details.push(format!("deprecation: {dep}"));
        }
        if let Some(sunset) = &self.sunset {
            details.push(format!("sunset: {sunset}"));
        }
        let detail_suffix = if details.is_empty() {
            String::new()
        } else {
            format!(" ({})", details.join(", "))
        };
        let link_suffix = match &self.sunset_link {
            Some(url) => format!(" See {url}."),
            None => String::new(),
        };
        format!(
            "asimp: notice: protocol version {version} is deprecated{detail_suffix}; switch to --protocol-version {DEFAULT_PROTOCOL_VERSION} or omit the flag.{link_suffix}\n"
        )
    }
}

/// Extract a safe `https://...` URL from an RFC 8288 `Link` header entry carrying `rel="sunset"`.
fn extract_sunset_link(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let trimmed = part.trim();
        if !trimmed.contains("rel=\"sunset\"") && !trimmed.contains("rel=sunset") {
            continue;
        }
        let rest = trimmed.strip_prefix('<')?;
        let (url, _) = rest.split_once('>')?;
        if url.starts_with("https://")
            && url.len() <= 200
            && url.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Some(url.to_owned());
        }
    }
    None
}

/// Inspect response protocol headers on a successful (2xx / 304) HTTP response.
/// Refuses incompatible server protocol versions so stale clients never misparse
/// breaking wire changes; surfaces Deprecation/Sunset headers cleanly.
pub fn inspect_success_headers(
    requested: &str,
    server_version: Option<&str>,
    deprecation: Option<&str>,
    sunset: Option<&str>,
    link: Option<&str>,
) -> Result<Option<DeprecationNotice>, ProtocolMismatch> {
    let trimmed_server = server_version.map(str::trim).filter(|v| !v.is_empty());
    if let Some(version) = trimmed_server
        && !SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
    {
        return Err(ProtocolMismatch {
            requested: requested.to_owned(),
            server_version: Some(if is_safe_version_token(version) {
                version.to_owned()
            } else {
                "<unrecognized>".to_owned()
            }),
            supported_by_server: Vec::new(),
        });
    }

    let clean_dep = deprecation
        .map(str::trim)
        .filter(|v| is_safe_header_snippet(v, 64))
        .map(str::to_owned);
    let clean_sunset = sunset
        .map(str::trim)
        .filter(|v| is_safe_header_snippet(v, 64))
        .map(str::to_owned);
    let clean_link = link.and_then(extract_sunset_link);

    if clean_dep.is_some() || clean_sunset.is_some() {
        return Ok(Some(DeprecationNotice {
            protocol_version: trimmed_server
                .filter(|v| is_safe_version_token(v))
                .map(str::to_owned),
            deprecation: clean_dep,
            sunset: clean_sunset,
            sunset_link: clean_link,
        }));
    }
    Ok(None)
}

/// Inspect a `400` error response body (bounded) to see whether the Worker
/// rejected our `asimp-protocol-version` header (`UNSUPPORTED_PROTOCOL_VERSION`).
/// Only sanitized version tokens are retained; untrusted error prose is never echoed.
pub fn parse_unsupported_version_problem(
    requested: &str,
    status: u16,
    body: Option<&str>,
) -> Option<ProtocolMismatch> {
    if status != 400 {
        return None;
    }
    let parsed: Value = serde_json::from_str(body?).ok()?;
    if parsed.get("code").and_then(Value::as_str) != Some("UNSUPPORTED_PROTOCOL_VERSION") {
        return None;
    }
    let supported_by_server = parsed
        .get("supported_versions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|v| is_safe_version_token(v))
                .take(8)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ProtocolMismatch {
        requested: if is_safe_version_token(requested) {
            requested.to_owned()
        } else {
            "<requested>".to_owned()
        },
        server_version: None,
        supported_by_server,
    })
}

/// Validate a `/capabilities` JSON document's advertised `version` or
/// `supported_protocol_versions` field against this client's supported set.
pub fn check_capabilities_compatibility(body: &str) -> Result<(), ProtocolMismatch> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Ok(());
    };
    let advertised_list: Vec<String> = value
        .get("supported_protocol_versions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|v| is_safe_version_token(v))
                .take(8)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !advertised_list.is_empty()
        && !advertised_list
            .iter()
            .any(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(&v.as_str()))
    {
        return Err(ProtocolMismatch {
            requested: DEFAULT_PROTOCOL_VERSION.to_owned(),
            server_version: value
                .get("version")
                .and_then(Value::as_str)
                .filter(|v| is_safe_version_token(v))
                .map(str::to_owned),
            supported_by_server: advertised_list,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_supported_and_rejects_unsafe_client_versions() {
        assert_eq!(
            validate_client_protocol_version("0.2.0-draft").unwrap(),
            "0.2.0-draft"
        );
        assert_eq!(validate_client_protocol_version("0.1.0").unwrap(), "0.1.0");
        assert!(validate_client_protocol_version("9.9.9").is_err());
        assert!(validate_client_protocol_version("0.2.0-draft\r\nX-Inject: 1").is_err());
        assert!(validate_client_protocol_version("").is_err());
    }

    #[test]
    fn surfaces_deprecation_and_sunset_without_failing() {
        let notice = inspect_success_headers(
            "0.1.0",
            Some("0.1.0"),
            Some("@1735689600"),
            Some("Wed, 31 Dec 2026 23:59:59 GMT"),
            Some("<https://a.asimposium.org/protocol.md>; rel=\"sunset\"; type=\"text/markdown\""),
        )
        .unwrap()
        .expect("deprecation notice");
        let rendered = notice.render_stderr();
        assert!(rendered.contains("0.1.0"));
        assert!(rendered.contains("@1735689600"));
        assert!(rendered.contains("Wed, 31 Dec 2026 23:59:59 GMT"));
        assert!(rendered.contains("https://a.asimposium.org/protocol.md"));
        assert!(rendered.contains("0.2.0-draft"));
    }

    #[test]
    fn refuses_incompatible_server_protocol_version() {
        let err = inspect_success_headers("0.2.0-draft", Some("2.0.0"), None, None, None)
            .expect_err("must refuse future major version");
        assert_eq!(err.server_version.as_deref(), Some("2.0.0"));
        let msg = err.render_stderr();
        assert!(msg.contains("incompatible protocol version '2.0.0'"));
        assert!(msg.contains("Upgrade asimp"));

        // Hostile header text is sanitized, never echoed.
        let hostile = inspect_success_headers(
            "0.2.0-draft",
            Some("evil\r\n<script>alert(1)</script>"),
            None,
            None,
            None,
        )
        .expect_err("must refuse hostile server version");
        let hostile_msg = hostile.render_stderr();
        assert!(!hostile_msg.contains("<script>"));
        assert!(hostile_msg.contains("<unrecognized>"));
    }

    #[test]
    fn parses_400_unsupported_protocol_version_problem_safely() {
        let problem = r#"{"code":"UNSUPPORTED_PROTOCOL_VERSION","detail":"hostile detail canary","supported_versions":["0.3.0","0.4.0","bad\nversion"]}"#;
        let mismatch = parse_unsupported_version_problem("0.2.0-draft", 400, Some(problem))
            .expect("detected mismatch");
        assert_eq!(mismatch.supported_by_server, vec!["0.3.0", "0.4.0"]);
        let rendered = mismatch.render_stderr();
        assert!(rendered.contains("0.3.0, 0.4.0"));
        assert!(!rendered.contains("hostile detail canary"));
        assert!(!rendered.contains("bad\nversion"));
    }
}
