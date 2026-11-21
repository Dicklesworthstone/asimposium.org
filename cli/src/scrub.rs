//! Offline P7 secret and PII scanner with exact Worker parity (W11.3, asimposiumorg-psl).
//!
//! Mirrors `apps/wire/src/screening/credential-scan.ts` (ledger/workshop mode)
//! and `apps/wire/src/krater/cas.ts` (artifact mode). Reports only redacted
//! locations (path, kind, 1-based line, 1-based Unicode code-point column) and
//! remediation; matched bytes never reach findings, stdout, stderr, or JSON.

use crate::{Cli, CliOutput, Command, read_capped_at};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::BTreeSet,
    path::{Path, PathBuf},
};

/// Fable §657: 5 MB general artifact cap.
pub const MAX_SCRUB_BYTES: u64 = 5 * 1024 * 1024;
/// Matches `MAX_FINDINGS` in `apps/wire/src/screening/credential-scan.ts`.
pub const MAX_FINDINGS: usize = 20;
const MAX_PATH_LENGTH: usize = 200;
const REDACTED_PATH: &str = "[redacted-field]";
const NESTED_PATH: &str = "[nested-field]";

/// Scanning profile matching the two server-side P7 walls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ScrubMode {
    /// Ledger/workshop JSON-aware credential scan (`credential-scan.ts`).
    Ledger,
    /// Artifact CAS scan including personal email addresses (`krater/cas.ts`).
    Artifact,
}

impl ScrubMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ledger => "ledger",
            Self::Artifact => "artifact",
        }
    }
}

#[derive(Debug, clap::Args)]
pub struct ScrubArgs {
    /// Regular UTF-8 file to scan (up to 5 MiB); omit when using --stdin.
    #[arg(
        required_unless_present = "stdin",
        conflicts_with = "stdin",
        value_name = "FILE"
    )]
    pub file: Option<PathBuf>,

    /// Read UTF-8 content to scan from stdin (up to 5 MiB).
    #[arg(long, required_unless_present = "file")]
    pub stdin: bool,

    /// Scan mode: ledger (JSON-aware credential wall) or artifact (CAS wall including emails).
    #[arg(long, value_enum, default_value_t = ScrubMode::Ledger)]
    pub mode: ScrubMode,

    /// Logical field label used in ledger mode diagnostics (default: body_md).
    #[arg(long, default_value = "body_md", value_name = "FIELD")]
    pub field: String,

    /// Explicitly acknowledge a verified false positive by redacted location:
    /// `kind:line:column` (artifact mode) or `path:kind:line:column` (ledger mode).
    /// Platform credentials (`fellow-token`, `enrollment-secret`, `prefixed-grant`,
    /// `private-key`) cannot be acknowledged as false positives.
    #[arg(long = "ack-false-positive", value_name = "LOCATION")]
    pub ack_false_positives: Vec<String>,

    /// Emit deterministic structured JSON findings (never echoes matched bytes).
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FindingKind {
    FellowToken,
    PrefixedGrant,
    EnrollmentSecret,
    PrivateKey,
    ApiKey,
    AccessToken,
    PersonalAddress,
}

impl FindingKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FellowToken => "fellow-token",
            Self::PrefixedGrant => "prefixed-grant",
            Self::EnrollmentSecret => "enrollment-secret",
            Self::PrivateKey => "private-key",
            Self::ApiKey => "api-key",
            Self::AccessToken => "access-token",
            Self::PersonalAddress => "personal-address",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "fellow-token" => Some(Self::FellowToken),
            "prefixed-grant" => Some(Self::PrefixedGrant),
            "enrollment-secret" => Some(Self::EnrollmentSecret),
            "private-key" => Some(Self::PrivateKey),
            "api-key" => Some(Self::ApiKey),
            "access-token" => Some(Self::AccessToken),
            "personal-address" => Some(Self::PersonalAddress),
            _ => None,
        }
    }

    /// Hard platform/cryptographic credentials are never suppressible as false positives.
    pub const fn allows_false_positive_ack(self) -> bool {
        matches!(
            self,
            Self::PersonalAddress | Self::ApiKey | Self::AccessToken
        )
    }
}

impl Ord for FindingKind {
    fn cmp(&self, other: &Self) -> Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl PartialOrd for FindingKind {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialFinding {
    pub path: String,
    pub kind: FindingKind,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretFinding {
    pub kind: FindingKind,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialRun {
    pub kind: FindingKind,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct AckSpec {
    path: Option<String>,
    kind: FindingKind,
    line: usize,
    column: usize,
}

fn parse_ack_spec(raw: &str, mode: ScrubMode) -> Result<AckSpec, &'static str> {
    // Parse from the right so ledger paths containing ':' (e.g. `[key:0]`, `[entry:0].x`)
    // split unambiguously into (path, kind, line, column).
    let (prefix, col_str) = raw.rsplit_once(':').ok_or(
        "Each --ack-false-positive must name a redacted location (`kind:line:column` in artifact mode, or `path:kind:line:column` in ledger mode).",
    )?;
    let (prefix, line_str) = prefix
        .rsplit_once(':')
        .ok_or("Each --ack-false-positive must include numeric 1-based line and column.")?;
    let line = line_str
        .parse::<usize>()
        .ok()
        .filter(|&n| n >= 1)
        .ok_or("Acknowledged line must be a positive integer.")?;
    let column = col_str
        .parse::<usize>()
        .ok()
        .filter(|&n| n >= 1)
        .ok_or("Acknowledged column must be a positive integer.")?;

    let (path, kind_str) = match mode {
        ScrubMode::Artifact => (None, prefix),
        ScrubMode::Ledger => {
            if let Some(kind) = FindingKind::parse(prefix) {
                // Allow shorthand `kind:line:column` only if explicitly unambiguous;
                // require `path:kind:line:column` in ledger mode so acknowledgments
                // stay pinned to the exact reported field path.
                let _ = kind;
                return Err(
                    "In ledger mode, --ack-false-positive requires `path:kind:line:column` (e.g. `body_md:api-key:1:3`).",
                );
            }
            let (path, kind_str) = prefix
                .rsplit_once(':')
                .ok_or("In ledger mode, --ack-false-positive requires `path:kind:line:column`.")?;
            if path.is_empty() || path.len() > MAX_PATH_LENGTH || has_raw_credential_shape(path) {
                return Err("Acknowledged path must be a safe, non-credential diagnostic path.");
            }
            (Some(path.to_owned()), kind_str)
        }
    };

    let kind = FindingKind::parse(kind_str).ok_or(
        "Unrecognized finding kind in --ack-false-positive; use the exact kind from scrub output.",
    )?;
    if !kind.allows_false_positive_ack() {
        return Err(
            "Hard credential classes (fellow-token, enrollment-secret, prefixed-grant, private-key) cannot be acknowledged as false positives; remove the credential instead.",
        );
    }
    Ok(AckSpec {
        path,
        kind,
        line,
        column,
    })
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_word_boundary(bytes: &[u8], pos: usize) -> bool {
    let before = pos > 0 && is_word_byte(bytes[pos - 1]);
    let after = pos < bytes.len() && is_word_byte(bytes[pos]);
    before != after
}

fn is_crockford_upper(byte: u8) -> bool {
    matches!(
        byte,
        b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'
    )
}

fn is_b64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn is_ecmascript_ws(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn trim_ecmascript(text: &str) -> &str {
    text.trim_matches(is_ecmascript_ws)
}

fn trim_end_ecmascript(text: &str) -> &str {
    text.trim_end_matches(is_ecmascript_ws)
}

fn take_while(bytes: &[u8], start: usize, pred: impl Fn(u8) -> bool) -> usize {
    let mut i = start;
    while i < bytes.len() && pred(bytes[i]) {
        i += 1;
    }
    i
}

/// Exact match to `CREDENTIAL_LABEL` in `credential-scan.ts:62-68`.
fn credential_label_kind(label: &str) -> Option<FindingKind> {
    let lower = label.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    // Whole label must be `(?:[a-z_][a-z0-9_]*_)?(?:password|passwd|pwd|secret|token|api_?key|private_key|secret_access_key)`
    const SUFFIXES: &[(&str, FindingKind)] = &[
        ("secret_access_key", FindingKind::ApiKey),
        ("private_key", FindingKind::AccessToken),
        ("password", FindingKind::AccessToken),
        ("api_key", FindingKind::ApiKey),
        ("apikey", FindingKind::ApiKey),
        ("passwd", FindingKind::AccessToken),
        ("secret", FindingKind::AccessToken),
        ("token", FindingKind::AccessToken),
        ("pwd", FindingKind::AccessToken),
    ];
    for &(suffix, kind) in SUFFIXES {
        if let Some(prefix) = lower.strip_suffix(suffix) {
            if prefix.is_empty() {
                return Some(kind);
            }
            if let Some(stem) = prefix.strip_suffix('_')
                && !stem.is_empty()
            {
                let sb = stem.as_bytes();
                if (sb[0].is_ascii_lowercase() || sb[0] == b'_')
                    && sb[1..]
                        .iter()
                        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                {
                    return Some(kind);
                }
            }
        }
    }
    None
}

fn is_ident(text: &str) -> bool {
    let b = text.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Exact match to `inertCredentialValue` in `credential-scan.ts:72-86`.
fn inert_credential_value(value: &str) -> bool {
    let text = trim_ecmascript(value);
    if text.is_empty() {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "[redacted]"
            | "<redacted>"
            | "redacted"
            | "[removed]"
            | "<removed>"
            | "[masked]"
            | "<masked>"
    ) {
        return true;
    }
    if (text.len() >= 3 && text.bytes().all(|b| b == b'*'))
        || (text.len() >= 4 && lower.bytes().all(|b| b == b'x'))
        || (text.len() >= 3 && text.bytes().all(|b| b == b'.'))
        || (!text.is_empty() && text.chars().all(|c| c == '\u{2026}'))
    {
        return true;
    }
    if let Some(inner) = lower.strip_prefix('<').and_then(|s| s.strip_suffix('>')) {
        let rest = inner
            .strip_prefix("your_")
            .or_else(|| inner.strip_prefix("your "))
            .or_else(|| inner.strip_prefix("your-"))
            .or_else(|| inner.strip_prefix("your"))
            .unwrap_or(inner);
        if matches!(
            rest,
            "password"
                | "passwd"
                | "pwd"
                | "secret"
                | "token"
                | "apikey"
                | "api_key"
                | "api key"
                | "api-key"
                | "privatekey"
                | "private_key"
                | "private key"
                | "private-key"
                | "replaceme"
                | "replace_me"
                | "replace me"
                | "replace-me"
        ) {
            return true;
        }
    }
    if let Some(rest) = text.strip_prefix('$') {
        if is_ident(rest) {
            return true;
        }
        if let Some(inner) = rest.strip_prefix('{').and_then(|s| s.strip_suffix('}'))
            && is_ident(inner)
        {
            return true;
        }
    }
    if let Some(inner) = text.strip_prefix('%').and_then(|s| s.strip_suffix('%'))
        && is_ident(inner)
    {
        return true;
    }
    if let Some(inner) = text.strip_prefix("{{").and_then(|s| s.strip_suffix("}}"))
        && is_ident(trim_ecmascript(inner))
    {
        return true;
    }
    false
}

/// Exact match to `sourceCredentialReference` in `credential-scan.ts:88-94`.
fn source_credential_reference(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("process.env.")
        && is_ident(rest)
    {
        return true;
    }
    let bracket_inner = value
        .strip_prefix("process.env[")
        .or_else(|| value.strip_prefix("os.environ["))
        .and_then(|s| s.strip_suffix(']'));
    if let Some(inner) = bracket_inner {
        let trimmed = trim_ecmascript(inner);
        if let Some(quoted) = strip_any_quote(trimmed)
            && is_ident(quoted)
        {
            return true;
        }
    }
    let paren_inner = value
        .strip_prefix("os.getenv(")
        .or_else(|| value.strip_prefix("getenv("))
        .and_then(|s| s.strip_suffix(')'));
    if let Some(inner) = paren_inner {
        let trimmed = trim_ecmascript(inner);
        if let Some(quoted) = strip_any_quote(trimmed)
            && is_ident(quoted)
        {
            return true;
        }
    }
    false
}

fn strip_any_quote(text: &str) -> Option<&str> {
    if text.len() < 2 {
        return None;
    }
    let b = text.as_bytes();
    if (b[0] == b'"' && *b.last()? == b'"') || (b[0] == b'\'' && *b.last()? == b'\'') {
        Some(&text[1..text.len() - 1])
    } else if (b[0] == b'"' && *b.last()? == b'\'') || (b[0] == b'\'' && *b.last()? == b'"') {
        // Matches JS `["'][A-Za-z_][A-Za-z0-9_]*["']`.
        Some(&text[1..text.len() - 1])
    } else {
        None
    }
}

/// Exact match to `decodeLiteral` in `credential-scan.ts:96-106`.
fn decode_literal(value: &str) -> String {
    if value.starts_with('"')
        && let Ok(decoded) = serde_json::from_str::<String>(value)
    {
        return decoded;
    }
    let inner = &value[1..value.len().saturating_sub(1)];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\'
            && let Some(&next) = chars.peek()
            && matches!(next, '\\' | '"' | '\'')
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(ch);
    }
    out
}

fn decode_uri_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_nibble(bytes[i + 1])?;
            let lo = hex_nibble(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn push_pattern_matches(
    line: &str,
    kind: FindingKind,
    max_per_pattern: usize,
    out: &mut Vec<CredentialRun>,
    mut match_at: impl FnMut(&[u8], usize) -> Option<usize>,
) {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut count = 0;
    while i < bytes.len() && count < max_per_pattern {
        if let Some(end) = match_at(bytes, i) {
            out.push(CredentialRun {
                kind,
                start: i,
                end,
            });
            count += 1;
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
}

/// Shared literal detection matching `credentialRuns` in `credential-scan.ts:117-195`.
pub fn credential_runs(line_text: &str, max_per_pattern: usize) -> Vec<CredentialRun> {
    let mut out = Vec::new();
    if max_per_pattern == 0 || line_text.is_empty() {
        return out;
    }

    // 1. fellow-token: /asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/
    push_pattern_matches(
        line_text,
        FindingKind::FellowToken,
        max_per_pattern,
        &mut out,
        |b, i| {
            if b.get(i..i + 9) != Some(b"asimp_ag_") || i + 79 > b.len() {
                return None;
            }
            if b[i + 9..i + 35].iter().all(|&c| is_crockford_upper(c))
                && b[i + 35] == b'_'
                && b[i + 36..i + 79].iter().all(|&c| is_b64url(c))
            {
                Some(i + 79)
            } else {
                None
            }
        },
    );

    // 2. prefixed-grant: /asimp_[a-z]{2}_[0-9A-Za-z_-]{20,}/
    push_pattern_matches(
        line_text,
        FindingKind::PrefixedGrant,
        max_per_pattern,
        &mut out,
        |b, i| {
            if b.get(i..i + 6) != Some(b"asimp_") || i + 29 > b.len() {
                return None;
            }
            if b[i + 6].is_ascii_lowercase() && b[i + 7].is_ascii_lowercase() && b[i + 8] == b'_' {
                let end = take_while(b, i + 9, is_b64url);
                if end - (i + 9) >= 20 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 3. enrollment-secret: /ASIMP-EN-[0-9A-Za-z-]{4,}#v1\.[A-Za-z0-9_-]{16,}|\bv1\.[A-Za-z0-9_-]{43,}/
    push_pattern_matches(
        line_text,
        FindingKind::EnrollmentSecret,
        max_per_pattern,
        &mut out,
        |b, i| {
            if b.get(i..i + 9) == Some(b"ASIMP-EN-") {
                let id_end = take_while(b, i + 9, |c| c.is_ascii_alphanumeric() || c == b'-');
                if id_end - (i + 9) >= 4 && b.get(id_end..id_end + 4) == Some(b"#v1.") {
                    let sec_end = take_while(b, id_end + 4, is_b64url);
                    if sec_end - (id_end + 4) >= 16 {
                        return Some(sec_end);
                    }
                }
            }
            if is_word_boundary(b, i) && b.get(i..i + 3) == Some(b"v1.") {
                let sec_end = take_while(b, i + 3, is_b64url);
                if sec_end - (i + 3) >= 43 {
                    return Some(sec_end);
                }
            }
            None
        },
    );

    // 4. prefixed-grant: /\bflow_v1\.[A-Za-z0-9_-]{43,}/
    push_pattern_matches(
        line_text,
        FindingKind::PrefixedGrant,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i) && b.get(i..i + 8) == Some(b"flow_v1.") {
                let end = take_while(b, i + 8, is_b64url);
                if end - (i + 8) >= 43 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 5. private-key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
    push_pattern_matches(
        line_text,
        FindingKind::PrivateKey,
        max_per_pattern,
        &mut out,
        |b, i| {
            if b.get(i..i + 11) != Some(b"-----BEGIN ") {
                return None;
            }
            let mid_end = take_while(b, i + 11, |c| c.is_ascii_uppercase() || c == b' ');
            if b[i + 11..mid_end].ends_with(b"PRIVATE KEY")
                && b.get(mid_end..mid_end + 5) == Some(b"-----")
            {
                Some(mid_end + 5)
            } else {
                None
            }
        },
    );

    // 6. api-key: /\bsk_live_[0-9A-Za-z]{16,}/
    push_pattern_matches(
        line_text,
        FindingKind::ApiKey,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i) && b.get(i..i + 8) == Some(b"sk_live_") {
                let end = take_while(b, i + 8, |c| c.is_ascii_alphanumeric());
                if end - (i + 8) >= 16 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 7. api-key: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/
    push_pattern_matches(
        line_text,
        FindingKind::ApiKey,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i) && b.get(i..i + 3) == Some(b"sk-") {
                let end = take_while(b, i + 3, is_b64url);
                if end - (i + 3) >= 32 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 8. api-key: /\bAKIA[0-9A-Z]{16}\b/
    push_pattern_matches(
        line_text,
        FindingKind::ApiKey,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i)
                && b.get(i..i + 4) == Some(b"AKIA")
                && i + 20 <= b.len()
                && b[i + 4..i + 20]
                    .iter()
                    .all(|&c| c.is_ascii_digit() || c.is_ascii_uppercase())
                && is_word_boundary(b, i + 20)
            {
                Some(i + 20)
            } else {
                None
            }
        },
    );

    // 9. api-key: /\bAIza[0-9A-Za-z_-]{35}\b/
    push_pattern_matches(
        line_text,
        FindingKind::ApiKey,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i)
                && b.get(i..i + 4) == Some(b"AIza")
                && i + 39 <= b.len()
                && b[i + 4..i + 39].iter().all(|&c| is_b64url(c))
                && is_word_boundary(b, i + 39)
            {
                Some(i + 39)
            } else {
                None
            }
        },
    );

    // 10. access-token: /\bgh[pousr]_[A-Za-z0-9]{36,}/
    push_pattern_matches(
        line_text,
        FindingKind::AccessToken,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i)
                && i + 40 <= b.len()
                && b.get(i..i + 2) == Some(b"gh")
                && matches!(b[i + 2], b'p' | b'o' | b'u' | b's' | b'r')
                && b[i + 3] == b'_'
            {
                let end = take_while(b, i + 4, |c| c.is_ascii_alphanumeric());
                if end - (i + 4) >= 36 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 11. access-token: /\bgithub_pat_[A-Za-z0-9_]{40,}/
    push_pattern_matches(
        line_text,
        FindingKind::AccessToken,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i) && b.get(i..i + 11) == Some(b"github_pat_") {
                let end = take_while(b, i + 11, is_word_byte);
                if end - (i + 11) >= 40 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 12. access-token: /\bxox[abprs]-[A-Za-z0-9-]{10,}/
    push_pattern_matches(
        line_text,
        FindingKind::AccessToken,
        max_per_pattern,
        &mut out,
        |b, i| {
            if is_word_boundary(b, i)
                && i + 15 <= b.len()
                && b.get(i..i + 3) == Some(b"xox")
                && matches!(b[i + 3], b'a' | b'b' | b'p' | b'r' | b's')
                && b[i + 4] == b'-'
            {
                let end = take_while(b, i + 5, |c| c.is_ascii_alphanumeric() || c == b'-');
                if end - (i + 5) >= 10 {
                    return Some(end);
                }
            }
            None
        },
    );

    // 13. access-token: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
    push_pattern_matches(
        line_text,
        FindingKind::AccessToken,
        max_per_pattern,
        &mut out,
        |b, i| {
            if !is_word_boundary(b, i) || b.get(i..i + 3) != Some(b"eyJ") {
                return None;
            }
            let p1 = take_while(b, i + 3, is_b64url);
            if p1 - (i + 3) < 10 || b.get(p1..p1 + 4) != Some(b".eyJ") {
                return None;
            }
            let p2 = take_while(b, p1 + 4, is_b64url);
            if p2 - (p1 + 4) < 10 || b.get(p2) != Some(&b'.') {
                return None;
            }
            let p3 = take_while(b, p2 + 1, is_b64url);
            if p3 - (p2 + 1) >= 10 { Some(p3) } else { None }
        },
    );

    // 14. Password-bearing connection URIs (`credential-scan.ts:133-151`)
    scan_uri_passwords(line_text, max_per_pattern, &mut out);

    // 15. Credential-labelled assignments (`credential-scan.ts:158-195`)
    scan_assignments(line_text, max_per_pattern, &mut out);

    out
}

fn scan_uri_passwords(line_text: &str, max_per_pattern: usize, out: &mut Vec<CredentialRun>) {
    let bytes = line_text.as_bytes();
    let mut i = 0;
    let mut uri_count = 0;
    while i < bytes.len() && uri_count < max_per_pattern {
        if !bytes[i].is_ascii_alphabetic() || !is_word_boundary(bytes, i) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let max_scheme_end = (i + 32).min(bytes.len());
        while j < max_scheme_end
            && (bytes[j].is_ascii_alphanumeric() || matches!(bytes[j], b'+' | b'.' | b'-'))
        {
            j += 1;
        }
        if bytes.get(j..j + 3) != Some(b"://") {
            i += 1;
            continue;
        }
        let auth_start = j + 3;
        let mut auth_end = auth_start;
        for (rel, ch) in line_text[auth_start..].char_indices() {
            if is_ecmascript_ws(ch) || matches!(ch, '/' | '?' | '#' | '"' | '\'' | '`' | '\\') {
                break;
            }
            auth_end = auth_start + rel + ch.len_utf8();
        }
        if auth_end == auth_start {
            i += 1;
            continue;
        }
        let authority = &line_text[auth_start..auth_end];
        if let (Some(at), Some(colon)) = (authority.rfind('@'), authority.find(':'))
            && at > colon + 1
            && at < authority.len() - 1
        {
            let encoded_password = &authority[colon + 1..at];
            let decoded = decode_uri_component(encoded_password)
                .unwrap_or_else(|| encoded_password.to_owned());
            if !inert_credential_value(&decoded) {
                let start = auth_start + colon + 1;
                out.push(CredentialRun {
                    kind: FindingKind::AccessToken,
                    start,
                    end: start + encoded_password.len(),
                });
                uri_count += 1;
            }
        }
        i = auth_end;
    }
}

fn is_non_prefix_ident_char(ch: char) -> bool {
    !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

fn match_assignment_value(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    // 1. Double-quoted string: "(?:\\.|[^"\\\r\n])*"
    if bytes[0] == b'"' {
        let mut idx = 1;
        while idx < bytes.len() {
            match bytes[idx] {
                b'\\' => {
                    if idx + 1 < bytes.len() && bytes[idx + 1] != b'\n' && bytes[idx + 1] != b'\r' {
                        let ch_len = rest[idx + 1..].chars().next()?.len_utf8();
                        idx += 1 + ch_len;
                    } else {
                        break;
                    }
                }
                b'"' => return Some(&rest[..=idx]),
                b'\r' | b'\n' => break,
                _ => idx += 1,
            }
        }
    }
    // 2. Single-quoted string: '(?:\\.|[^'\\\r\n])*'
    if bytes[0] == b'\'' {
        let mut idx = 1;
        while idx < bytes.len() {
            match bytes[idx] {
                b'\\' => {
                    if idx + 1 < bytes.len() && bytes[idx + 1] != b'\n' && bytes[idx + 1] != b'\r' {
                        let ch_len = rest[idx + 1..].chars().next()?.len_utf8();
                        idx += 1 + ch_len;
                    } else {
                        break;
                    }
                }
                b'\'' => return Some(&rest[..=idx]),
                b'\r' | b'\n' => break,
                _ => idx += 1,
            }
        }
    }
    // 3. (?:process\.env|os\.environ)\[[^\r\n]*?\](?=[ \t]*(?:$|[;,#}]))
    if let Some(after) = rest
        .strip_prefix("process.env[")
        .or_else(|| rest.strip_prefix("os.environ["))
    {
        let prefix_len = rest.len() - after.len();
        for (rel, ch) in after.char_indices() {
            if ch == '\r' || ch == '\n' {
                break;
            }
            if ch == ']' {
                let end = prefix_len + rel + 1;
                if followed_by_source_boundary(&rest[end..]) {
                    return Some(&rest[..end]);
                }
            }
        }
    }
    // 4. (?:os\.)?getenv\([^\r\n]*?\)(?=[ \t]*(?:$|[;,#}]))
    if let Some(after) = rest
        .strip_prefix("os.getenv(")
        .or_else(|| rest.strip_prefix("getenv("))
    {
        let prefix_len = rest.len() - after.len();
        for (rel, ch) in after.char_indices() {
            if ch == '\r' || ch == '\n' {
                break;
            }
            if ch == ')' {
                let end = prefix_len + rel + 1;
                if followed_by_source_boundary(&rest[end..]) {
                    return Some(&rest[..end]);
                }
            }
        }
    }
    // 5. \$\{[A-Za-z_][A-Za-z0-9_]*\}(?=$|[\s;,}])
    if let Some(after) = rest.strip_prefix("${")
        && let Some(close) = after.find('}')
        && is_ident(&after[..close])
    {
        let end = 2 + close + 1;
        if followed_by_template_boundary(&rest[end..]) {
            return Some(&rest[..end]);
        }
    }
    // 6. \{\{[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}(?=$|[\s;,}])
    if let Some(after) = rest.strip_prefix("{{")
        && let Some(close) = after.find("}}")
    {
        let inner = after[..close].trim_matches([' ', '\t']);
        if is_ident(inner) {
            let end = 2 + close + 2;
            if followed_by_template_boundary(&rest[end..]) {
                return Some(&rest[..end]);
            }
        }
    }
    // 7. [^\s;,}"']+
    let mut end = 0;
    for (rel, ch) in rest.char_indices() {
        if is_ecmascript_ws(ch) || matches!(ch, ';' | ',' | '}' | '"' | '\'') {
            break;
        }
        end = rel + ch.len_utf8();
    }
    if end > 0 { Some(&rest[..end]) } else { None }
}

fn followed_by_source_boundary(tail: &str) -> bool {
    let trimmed = tail.trim_start_matches([' ', '\t']);
    trimmed.is_empty() || matches!(trimmed.as_bytes()[0], b';' | b',' | b'#' | b'}')
}

fn followed_by_template_boundary(tail: &str) -> bool {
    match tail.chars().next() {
        None => true,
        Some(ch) => is_ecmascript_ws(ch) || matches!(ch, ';' | ',' | '}'),
    }
}

fn has_js_var_decl_prefix(prefix: &str) -> bool {
    let trimmed = prefix.trim_end_matches([' ', '\t']);
    if trimmed.len() == prefix.len() {
        return false;
    }
    for kw in ["const", "let", "var"] {
        if let Some(before) = trimmed.strip_suffix(kw)
            && before.as_bytes().last().is_none_or(|&b| !is_word_byte(b))
        {
            return true;
        }
    }
    false
}

fn is_source_expression_rhs(rhs: &str) -> bool {
    if let Some(rest) = rhs.strip_prefix("await")
        && rest.starts_with([' ', '\t'])
    {
        return true;
    }
    if let Some(rest) = rhs.strip_prefix("new")
        && rest.starts_with([' ', '\t'])
    {
        return true;
    }
    let bytes = rhs.as_bytes();
    if bytes.is_empty() || !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_' || bytes[0] == b'$')
    {
        return false;
    }
    let first_end = take_while(bytes, 1, |c| {
        c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
    });
    let after_first = &rhs[first_end..];
    // [A-Za-z_$]...(?:\.[A-Za-z_$]...)*[ \t]*\(  OR  [A-Za-z_$]...\.[A-Za-z_$]...
    if after_first.starts_with('.') {
        let rest_b = &after_first.as_bytes()[1..];
        if rest_b
            .first()
            .is_some_and(|&c| c.is_ascii_alphabetic() || c == b'_' || c == b'$')
        {
            return true;
        }
    }
    let ws_trimmed = after_first.trim_start_matches([' ', '\t']);
    if ws_trimmed.starts_with('(') {
        return true;
    }
    // [A-Za-z_$]...[ \t]*[+*/%<>=!?|&-]
    ws_trimmed.as_bytes().first().is_some_and(|&c| {
        matches!(
            c,
            b'+' | b'*' | b'/' | b'%' | b'<' | b'>' | b'=' | b'!' | b'?' | b'|' | b'&' | b'-'
        )
    })
}

fn scan_assignments(line_text: &str, max_per_pattern: usize, out: &mut Vec<CredentialRun>) {
    let bytes = line_text.as_bytes();
    let mut i = 0;
    let mut assignment_count = 0;
    while i < bytes.len() && assignment_count < max_per_pattern {
        let mut label_start = i;
        if i > 0 {
            let Some(ch) = line_text[i..].chars().next() else {
                break;
            };
            if !is_non_prefix_ident_char(ch) {
                i += ch.len_utf8();
                continue;
            }
            label_start = i + ch.len_utf8();
        }
        // Also try starting directly at i == 0 (the `^` alternative), OR after the delimiter byte at i == 0.
        if let Some((end, run)) = try_match_assignment_at(line_text, i, label_start) {
            if let Some(run) = run {
                out.push(run);
                assignment_count += 1;
            }
            i = end.max(i + 1);
            continue;
        }
        if i == 0
            && let Some(ch) = line_text.chars().next()
            && is_non_prefix_ident_char(ch)
            && let Some((end, run)) = try_match_assignment_at(line_text, 0, ch.len_utf8())
        {
            if let Some(run) = run {
                out.push(run);
                assignment_count += 1;
            }
            i = end.max(1);
            continue;
        }
        let step = line_text[i..].chars().next().map_or(1, char::len_utf8);
        i += step;
    }
}

fn try_match_assignment_at(
    line_text: &str,
    hit_index: usize,
    label_pos: usize,
) -> Option<(usize, Option<CredentialRun>)> {
    let bytes = line_text.as_bytes();
    if label_pos >= bytes.len() {
        return None;
    }
    let (key_quoted, label, after_key) = match bytes[label_pos] {
        b'"' | b'\'' => {
            let q = bytes[label_pos];
            let end = take_while(bytes, label_pos + 1, |c| {
                c.is_ascii_alphanumeric() || c == b'_'
            });
            if bytes.get(end) != Some(&q) {
                return None;
            }
            (true, &line_text[label_pos + 1..end], end + 1)
        }
        _ => {
            let end = take_while(bytes, label_pos, |c| c.is_ascii_alphanumeric() || c == b'_');
            if end == label_pos {
                return None;
            }
            (false, &line_text[label_pos..end], end)
        }
    };
    let kind = credential_label_kind(label)?;

    // [ \t]*(=(?!=|>)|:(?![=:]))[ \t]*
    let sep_pos = take_while(bytes, after_key, |c| c == b' ' || c == b'\t');
    let sep = *bytes.get(sep_pos)?;
    match sep {
        b'=' => {
            if matches!(bytes.get(sep_pos + 1), Some(b'=' | b'>')) {
                return None;
            }
        }
        b':' => {
            if matches!(bytes.get(sep_pos + 1), Some(b'=' | b':')) {
                return None;
            }
        }
        _ => return None,
    }
    let val_pos = take_while(bytes, sep_pos + 1, |c| c == b' ' || c == b'\t');
    let raw_full = match_assignment_value(&line_text[val_pos..])?;
    let hit_end = val_pos + raw_full.len();

    let raw = trim_end_ecmascript(raw_full);
    let quoted = raw.starts_with('"') || raw.starts_with('\'');
    if sep == b':' && !key_quoted && !quoted {
        return Some((hit_end, None));
    }
    let rest = &line_text[hit_end..];
    let rest_ws_trimmed = rest.trim_start_matches([' ', '\t']);
    let continued = rest_ws_trimmed
        .as_bytes()
        .first()
        .is_some_and(|&c| matches!(c, b'+' | b'|' | b'&' | b'?'))
        || (quoted
            && rest
                .chars()
                .next()
                .is_some_and(|c| !is_ecmascript_ws(c) && !matches!(c, ';' | ',' | '}' | ']')));
    if !continued && !quoted && source_credential_reference(raw) {
        return Some((hit_end, None));
    }
    if !continued && !quoted && inert_credential_value(raw) {
        return Some((hit_end, None));
    }
    let is_bare_lowercase = matches!(
        label,
        "token" | "secret" | "password" | "passwd" | "pwd" | "api_key" | "apikey"
    );
    let prefix_end = (hit_index + 1).min(line_text.len());
    let prefix_slice = if line_text.is_char_boundary(prefix_end) {
        &line_text[..prefix_end]
    } else {
        &line_text[..label_pos]
    };
    if !quoted
        && !continued
        && (is_bare_lowercase || has_js_var_decl_prefix(prefix_slice))
        && is_source_expression_rhs(&line_text[val_pos..])
    {
        return Some((hit_end, None));
    }
    let literal = if quoted {
        decode_literal(raw)
    } else {
        raw.to_owned()
    };
    if !continued && inert_credential_value(&literal) {
        return Some((hit_end, None));
    }
    let start = val_pos + usize::from(quoted);
    let len = if quoted {
        raw.len().saturating_sub(2)
    } else {
        literal.len()
    };
    Some((
        hit_end,
        Some(CredentialRun {
            kind,
            start,
            end: start + len.max(1),
        }),
    ))
}

pub fn has_raw_credential_shape(text: &str) -> bool {
    !credential_runs(text, 1).is_empty()
}

pub fn has_credential_shape(text: &str) -> bool {
    has_raw_credential_shape(text) || !structured_credential_runs(text).is_empty()
}

fn diagnostic_path(path: &str) -> String {
    if path.len() > MAX_PATH_LENGTH
        || path.contains(['\r', '\n', '\t'])
        || has_raw_credential_shape(path)
    {
        return REDACTED_PATH.to_owned();
    }
    if path.is_empty() {
        "[root]".to_owned()
    } else {
        path.to_owned()
    }
}

fn append_path(parent: &str, suffix: &str) -> String {
    if parent == NESTED_PATH {
        return NESTED_PATH.to_owned();
    }
    let combined = format!("{parent}{suffix}");
    if combined.len() > MAX_PATH_LENGTH {
        NESTED_PATH.to_owned()
    } else {
        diagnostic_path(&combined)
    }
}

fn member_path(parent: &str, key: &str, index: usize) -> String {
    let kb = key.as_bytes();
    let simple = !kb.is_empty()
        && kb.len() <= 64
        && (kb[0].is_ascii_alphabetic() || kb[0] == b'_')
        && kb[1..]
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'_');
    if simple && !has_raw_credential_shape(key) {
        let prefix = if parent.is_empty() { "" } else { "." };
        append_path(parent, &format!("{prefix}{key}"))
    } else {
        append_path(parent, &format!("[entry:{index}]"))
    }
}

fn code_point_column(line_text: &str, byte_index: usize) -> usize {
    let clamped = byte_index.min(line_text.len());
    line_text[..clamped].chars().count() + 1
}

/// Exact match to `scanTextForCredentials` in `credential-scan.ts:254-281`.
pub fn scan_text_for_credentials(path: &str, text: &str) -> Vec<CredentialFinding> {
    let mut findings = Vec::new();
    if text.is_empty() {
        return findings;
    }
    let safe_path = diagnostic_path(path);
    for (line_index, line_text) in text.split('\n').enumerate() {
        let mut spans: Vec<(usize, usize)> = Vec::new();
        let mut line_findings: Vec<(FindingKind, usize)> = Vec::new();
        for run in credential_runs(line_text, MAX_FINDINGS) {
            if spans
                .iter()
                .any(|&(from, to)| run.start < to && run.end > from)
            {
                continue;
            }
            spans.push((run.start, run.end));
            line_findings.push((run.kind, run.start));
        }
        line_findings.sort_by_key(|&(_, start)| start);
        for (kind, start) in line_findings {
            findings.push(CredentialFinding {
                path: safe_path.clone(),
                kind,
                line: line_index + 1,
                column: code_point_column(line_text, start),
            });
            if findings.len() >= MAX_FINDINGS {
                return findings;
            }
        }
    }
    findings
}

#[derive(Debug, Clone, Copy)]
enum JsonToken<'a> {
    Punct(u8),
    Str {
        raw: &'a str,
        start: usize,
        end: usize,
    },
    Number {
        start: usize,
        end: usize,
    },
    Literal,
}

/// Lexes raw JSON tokens preserving byte offsets, duplicate keys, and raw escapes.
fn lex_json_tokens(text: &str) -> Vec<JsonToken<'_>> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'}' | b'[' | b']' | b',' | b':' => {
                tokens.push(JsonToken::Punct(bytes[i]));
                i += 1;
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        if i + 1 < bytes.len() {
                            let ch_len = text[i + 1..].chars().next().map_or(1, char::len_utf8);
                            i += 1 + ch_len;
                        } else {
                            i += 1;
                        }
                    } else if bytes[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
                tokens.push(JsonToken::Str {
                    raw: &text[start..i],
                    start,
                    end: i,
                });
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                if bytes[i] == b'-' {
                    i += 1;
                }
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'.' {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
                    i += 1;
                    if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
                        i += 1;
                    }
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                tokens.push(JsonToken::Number { start, end: i });
            }
            b't' if bytes.get(i..i + 4) == Some(b"true") => {
                tokens.push(JsonToken::Literal);
                i += 4;
            }
            b'f' if bytes.get(i..i + 5) == Some(b"false") => {
                tokens.push(JsonToken::Literal);
                i += 5;
            }
            b'n' if bytes.get(i..i + 4) == Some(b"null") => {
                tokens.push(JsonToken::Literal);
                i += 4;
            }
            _ => i += 1,
        }
    }
    tokens
}

/// Iterative RFC 8259 JSON validator so deeply nested inputs (e.g. 20,000-deep
/// arrays) never hit serde_json's recursion limit and falsely bypass JSON scanning.
fn is_valid_json_iterative(text: &str) -> bool {
    let bytes = text.as_bytes();
    let skip_ws = |mut idx: usize| -> usize {
        while idx < bytes.len() && matches!(bytes[idx], b' ' | b'\t' | b'\n' | b'\r') {
            idx += 1;
        }
        idx
    };
    let parse_string = |start: usize| -> Option<usize> {
        if bytes.get(start) != Some(&b'"') {
            return None;
        }
        let mut idx = start + 1;
        while idx < bytes.len() {
            match bytes[idx] {
                b'"' => return Some(idx + 1),
                b'\\' => {
                    idx += 1;
                    let esc = *bytes.get(idx)?;
                    match esc {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => idx += 1,
                        b'u' => {
                            if idx + 4 >= bytes.len()
                                || !bytes[idx + 1..=idx + 4]
                                    .iter()
                                    .all(|b| b.is_ascii_hexdigit())
                            {
                                return None;
                            }
                            idx += 5;
                        }
                        _ => return None,
                    }
                }
                0x00..=0x1f => return None,
                _ => idx += 1,
            }
        }
        None
    };
    let parse_number = |start: usize| -> Option<usize> {
        let mut idx = start;
        if bytes.get(idx) == Some(&b'-') {
            idx += 1;
        }
        match *bytes.get(idx)? {
            b'0' => idx += 1,
            b'1'..=b'9' => {
                idx += 1;
                while idx < bytes.len() && bytes[idx].is_ascii_digit() {
                    idx += 1;
                }
            }
            _ => return None,
        }
        if bytes.get(idx) == Some(&b'.') {
            idx += 1;
            let frac_start = idx;
            while idx < bytes.len() && bytes[idx].is_ascii_digit() {
                idx += 1;
            }
            if idx == frac_start {
                return None;
            }
        }
        if matches!(bytes.get(idx), Some(b'e' | b'E')) {
            idx += 1;
            if matches!(bytes.get(idx), Some(b'+' | b'-')) {
                idx += 1;
            }
            let exp_start = idx;
            while idx < bytes.len() && bytes[idx].is_ascii_digit() {
                idx += 1;
            }
            if idx == exp_start {
                return None;
            }
        }
        Some(idx)
    };

    #[derive(Clone, Copy)]
    enum Container {
        Array,
        Object,
    }
    let mut stack: Vec<Container> = Vec::new();
    let mut i = skip_ws(0);
    let mut expecting_value = true;

    loop {
        i = skip_ws(i);
        if expecting_value {
            let Some(&b) = bytes.get(i) else {
                return false;
            };
            match b {
                b'{' => {
                    i = skip_ws(i + 1);
                    if bytes.get(i) == Some(&b'}') {
                        i += 1;
                        expecting_value = false;
                    } else {
                        stack.push(Container::Object);
                        let Some(after_key) = parse_string(i) else {
                            return false;
                        };
                        i = skip_ws(after_key);
                        if bytes.get(i) != Some(&b':') {
                            return false;
                        }
                        i += 1;
                        expecting_value = true;
                    }
                }
                b'[' => {
                    i = skip_ws(i + 1);
                    if bytes.get(i) == Some(&b']') {
                        i += 1;
                        expecting_value = false;
                    } else {
                        stack.push(Container::Array);
                        expecting_value = true;
                    }
                }
                b'"' => {
                    let Some(next) = parse_string(i) else {
                        return false;
                    };
                    i = next;
                    expecting_value = false;
                }
                b'-' | b'0'..=b'9' => {
                    let Some(next) = parse_number(i) else {
                        return false;
                    };
                    i = next;
                    expecting_value = false;
                }
                b't' if bytes.get(i..i + 4) == Some(b"true") => {
                    i += 4;
                    expecting_value = false;
                }
                b'f' if bytes.get(i..i + 5) == Some(b"false") => {
                    i += 5;
                    expecting_value = false;
                }
                b'n' if bytes.get(i..i + 4) == Some(b"null") => {
                    i += 4;
                    expecting_value = false;
                }
                _ => return false,
            }
        } else {
            let Some(&top) = stack.last() else {
                return i == bytes.len();
            };
            let Some(&b) = bytes.get(i) else {
                return false;
            };
            match (top, b) {
                (Container::Array, b',') => {
                    i += 1;
                    expecting_value = true;
                }
                (Container::Array, b']') => {
                    stack.pop();
                    i += 1;
                }
                (Container::Object, b',') => {
                    i = skip_ws(i + 1);
                    let Some(after_key) = parse_string(i) else {
                        return false;
                    };
                    i = skip_ws(after_key);
                    if bytes.get(i) != Some(&b':') {
                        return false;
                    }
                    i += 1;
                    expecting_value = true;
                }
                (Container::Object, b'}') => {
                    stack.pop();
                    i += 1;
                }
                _ => return false,
            }
        }
    }
}

fn looks_like_json_root(text: &str) -> bool {
    let trimmed = trim_ecmascript(text);
    matches!(trimmed.as_bytes().first(), Some(b'{' | b'[' | b'"')) && is_valid_json_iterative(text)
}

struct JsonFrame {
    is_object: bool,
    path: String,
    index: usize,
    key_path: Option<String>,
    credential_kind: Option<FindingKind>,
    expecting_key: bool,
}

/// Exact match to `scanFieldForCredentials` in `credential-scan.ts:299-393`.
pub fn scan_field_for_credentials(field: &str, text: &str) -> Vec<CredentialFinding> {
    let mut findings = Vec::new();
    let mut pending = vec![(diagnostic_path(field), text.to_owned(), true)];
    while let Some((current_field, current_text, is_root)) = pending.pop() {
        if findings.len() >= MAX_FINDINGS {
            break;
        }
        if !looks_like_json_root(&current_text) {
            findings.extend(scan_text_for_credentials(&current_field, &current_text));
            if findings.len() >= MAX_FINDINGS {
                findings.truncate(MAX_FINDINGS);
                return findings;
            }
            continue;
        }

        let mut frames: Vec<JsonFrame> = Vec::new();
        for token in lex_json_tokens(&current_text) {
            match token {
                JsonToken::Punct(b'{' | b'[') => {
                    let is_obj = matches!(token, JsonToken::Punct(b'{'));
                    let path = if frames.is_empty() && is_root && is_obj {
                        String::new()
                    } else {
                        current_value_path(&frames, &current_field)
                    };
                    frames.push(JsonFrame {
                        is_object: is_obj,
                        path,
                        index: 0,
                        key_path: None,
                        credential_kind: None,
                        expecting_key: is_obj,
                    });
                }
                JsonToken::Punct(b'}' | b']') => {
                    frames.pop();
                }
                JsonToken::Punct(b',') => {
                    if let Some(frame) = frames.last_mut() {
                        frame.index += 1;
                        frame.expecting_key = frame.is_object;
                        frame.key_path = None;
                        frame.credential_kind = None;
                    }
                }
                JsonToken::Str { raw, .. } => {
                    let Ok(decoded) = serde_json::from_str::<String>(raw) else {
                        continue;
                    };
                    let path = if let Some(frame) = frames.last_mut()
                        && frame.is_object
                        && frame.expecting_key
                    {
                        let p = append_path(&frame.path, &format!("[key:{}]", frame.index));
                        frame.key_path = Some(member_path(&frame.path, &decoded, frame.index));
                        frame.credential_kind = credential_label_kind(&decoded);
                        frame.expecting_key = false;
                        p
                    } else {
                        current_value_path(&frames, &current_field)
                    };
                    let mut shaped = scan_text_for_credentials(&path, &decoded);
                    if let Some(frame) = frames.last()
                        && frame.is_object
                        && frame.key_path.as_deref() == Some(path.as_str())
                        && let Some(kind) = frame.credential_kind
                        && shaped.is_empty()
                        && !inert_credential_value(&decoded)
                    {
                        shaped.push(CredentialFinding {
                            path: path.clone(),
                            kind,
                            line: 1,
                            column: 1,
                        });
                    }
                    findings.extend(shaped);
                    let nested_first = trim_ecmascript(&decoded).as_bytes().first().copied();
                    if matches!(nested_first, Some(b'{' | b'[' | b'"')) {
                        pending.push((path, decoded, false));
                    }
                }
                JsonToken::Number { .. } => {
                    if let Some(frame) = frames.last()
                        && frame.is_object
                        && let Some(kind) = frame.credential_kind
                    {
                        findings.push(CredentialFinding {
                            path: frame.key_path.clone().unwrap_or_else(|| frame.path.clone()),
                            kind,
                            line: 1,
                            column: 1,
                        });
                    }
                }
                JsonToken::Punct(_) | JsonToken::Literal => {}
            }
            if findings.len() >= MAX_FINDINGS {
                findings.truncate(MAX_FINDINGS);
                return findings;
            }
        }
    }
    findings.truncate(MAX_FINDINGS);
    findings
}

fn current_value_path(frames: &[JsonFrame], root_field: &str) -> String {
    match frames.last() {
        None => root_field.to_owned(),
        Some(frame) if !frame.is_object => append_path(&frame.path, &format!("[{}]", frame.index)),
        Some(frame) => frame.key_path.clone().unwrap_or_else(|| frame.path.clone()),
    }
}

/// Exact match to `structuredCredentialRuns` in `credential-scan.ts:399-441`.
pub fn structured_credential_runs(text: &str) -> Vec<CredentialRun> {
    let mut out = Vec::new();
    if !looks_like_json_root(text) {
        return out;
    }
    struct SimpleFrame {
        is_object: bool,
        expecting_key: bool,
        kind: Option<FindingKind>,
    }
    let mut frames: Vec<SimpleFrame> = Vec::new();
    for token in lex_json_tokens(text) {
        match token {
            JsonToken::Punct(b'{' | b'[') => {
                let is_obj = matches!(token, JsonToken::Punct(b'{'));
                frames.push(SimpleFrame {
                    is_object: is_obj,
                    expecting_key: is_obj,
                    kind: None,
                });
            }
            JsonToken::Punct(b'}' | b']') => {
                frames.pop();
            }
            JsonToken::Punct(b',') => {
                if let Some(frame) = frames.last_mut() {
                    frame.expecting_key = frame.is_object;
                    frame.kind = None;
                }
            }
            JsonToken::Str { raw, start, end } => {
                let Ok(decoded) = serde_json::from_str::<String>(raw) else {
                    continue;
                };
                let is_key = frames
                    .last()
                    .is_some_and(|f| f.is_object && f.expecting_key);
                if is_key && let Some(frame) = frames.last_mut() {
                    frame.kind = credential_label_kind(&decoded);
                    frame.expecting_key = false;
                }
                // Preserve insertion order matching JS `new Set(...)` iteration order.
                let mut kinds: Vec<FindingKind> = Vec::new();
                for finding in scan_field_for_credentials("artifact", &decoded) {
                    if !kinds.contains(&finding.kind) {
                        kinds.push(finding.kind);
                    }
                }
                if !is_key
                    && let Some(frame) = frames.last()
                    && frame.is_object
                    && let Some(kind) = frame.kind
                    && !inert_credential_value(&decoded)
                    && !kinds.contains(&kind)
                {
                    kinds.push(kind);
                }
                for kind in kinds {
                    out.push(CredentialRun {
                        kind,
                        start: start + 1,
                        end: end.saturating_sub(1),
                    });
                    if out.len() >= MAX_FINDINGS {
                        return out;
                    }
                }
            }
            JsonToken::Number { start, end } => {
                if let Some(frame) = frames.last()
                    && frame.is_object
                    && let Some(kind) = frame.kind
                {
                    out.push(CredentialRun { kind, start, end });
                    if out.len() >= MAX_FINDINGS {
                        return out;
                    }
                }
            }
            JsonToken::Punct(_) | JsonToken::Literal => {}
        }
    }
    out
}

/// Exact match to `PERSONAL_ADDRESS_PATTERN` in `krater/cas.ts:106`:
/// `/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g`
fn scan_personal_addresses(line_text: &str) -> Vec<usize> {
    let bytes = line_text.as_bytes();
    let is_local =
        |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'%' | b'+' | b'-');
    let is_domain = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-');
    let mut starts = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !is_local(bytes[i]) {
            i += 1;
            continue;
        }
        let local_end = take_while(bytes, i, is_local);
        if bytes.get(local_end) != Some(&b'@') {
            i = local_end;
            continue;
        }
        let local_start = local_end.saturating_sub(64).max(i);
        let dom_start = local_end + 1;
        let dom_end = take_while(bytes, dom_start, is_domain);
        let dom = &bytes[dom_start..dom_end];
        // Find the rightmost valid `prefix (1..=253) . tld (2..=63 ASCII letters)`.
        let mut matched_end = None;
        for dot_rel in (1..dom.len()).rev() {
            if dom[dot_rel] != b'.' || dot_rel > 253 {
                continue;
            }
            let tld_start = dot_rel + 1;
            let tld_len = take_while(dom, tld_start, |c| c.is_ascii_alphabetic()) - tld_start;
            if tld_len >= 2 {
                let used_tld = tld_len.min(63);
                matched_end = Some(dom_start + tld_start + used_tld);
                break;
            }
        }
        if let Some(end) = matched_end {
            starts.push(local_start);
            i = end;
        } else {
            i = local_end + 1;
        }
    }
    starts
}

/// Exact match to `scanBodyForSecrets` in `apps/wire/src/krater/cas.ts:147-187`.
pub fn scan_body_for_secrets(body: &str) -> Vec<SecretFinding> {
    let mut findings = Vec::new();
    let lines: Vec<&str> = body.split('\n').collect();
    for (line_index, &line_text) in lines.iter().enumerate() {
        for run in credential_runs(line_text, usize::MAX) {
            findings.push(SecretFinding {
                kind: run.kind,
                line: line_index + 1,
                column: code_point_column(line_text, run.start),
            });
        }
        for start in scan_personal_addresses(line_text) {
            findings.push(SecretFinding {
                kind: FindingKind::PersonalAddress,
                line: line_index + 1,
                column: code_point_column(line_text, start),
            });
        }
    }
    if !findings
        .iter()
        .any(|finding| finding.kind != FindingKind::PersonalAddress)
    {
        let mut line_index = 0usize;
        let mut line_start = 0usize;
        for run in structured_credential_runs(body) {
            while line_index + 1 < lines.len() && run.start > line_start + lines[line_index].len() {
                line_start += lines[line_index].len() + 1;
                line_index += 1;
            }
            let offset = run.start.saturating_sub(line_start);
            findings.push(SecretFinding {
                kind: run.kind,
                line: line_index + 1,
                column: code_point_column(lines[line_index], offset),
            });
        }
    }
    findings.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| left.column.cmp(&right.column))
            .then_with(|| left.kind.cmp(&right.kind))
    });
    findings
}

/// Exact match to `archiveMemberPathIsSafe` in `apps/wire/src/krater/cas.ts:208-218`.
pub fn archive_member_path_is_safe(member_path: &str) -> bool {
    if member_path.is_empty() || member_path.starts_with('/') || member_path.starts_with('\\') {
        return false;
    }
    let bytes = member_path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    for segment in member_path.split(['/', '\\']) {
        if segment == ".." || segment.is_empty() {
            return false;
        }
    }
    true
}

fn read_scrub_file(path: &Path) -> Result<String, &'static str> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "Cannot read scrub input; supply an accessible regular UTF-8 file.")?;
    if !metadata.is_file() {
        return Err("Scrub input must name a regular UTF-8 file; use --stdin for piped text.");
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "Cannot open scrub input; check file permissions.")?;
    read_capped_at(file, MAX_SCRUB_BYTES)
        .map_err(|_| "Scrub input must be valid UTF-8 within 5 MiB.")
}

pub fn run(cli: &Cli) -> CliOutput {
    run_with_readers(cli, read_scrub_file, || {
        read_capped_at(std::io::stdin().lock(), MAX_SCRUB_BYTES)
            .map_err(|_| "Scrub stdin must be valid UTF-8 within 5 MiB.")
    })
}

pub fn run_with_readers(
    cli: &Cli,
    read_file: impl FnOnce(&Path) -> Result<String, &'static str>,
    read_stdin: impl FnOnce() -> Result<String, &'static str>,
) -> CliOutput {
    let Command::Scrub(args) = &cli.command else {
        return crate::input_error("Expected the scrub command.");
    };
    let mut acks = BTreeSet::new();
    for raw in &args.ack_false_positives {
        match parse_ack_spec(raw, args.mode) {
            Ok(spec) => {
                acks.insert(spec);
            }
            Err(message) => return crate::input_error(message),
        }
    }
    let body = if args.stdin {
        match read_stdin() {
            Ok(text) => text,
            Err(message) => return crate::input_error(message),
        }
    } else if let Some(path) = &args.file {
        match read_file(path) {
            Ok(text) => text,
            Err(message) => return crate::input_error(message),
        }
    } else {
        return crate::input_error("Supply a regular UTF-8 file or --stdin to scrub.");
    };

    match args.mode {
        ScrubMode::Ledger => format_ledger_result(args, &acks, &body),
        ScrubMode::Artifact => format_artifact_result(args, &acks, &body),
    }
}

fn format_ledger_result(args: &ScrubArgs, acks: &BTreeSet<AckSpec>, body: &str) -> CliOutput {
    let all = scan_field_for_credentials(&args.field, body);
    let truncated = all.len() >= MAX_FINDINGS;
    let mut remaining = Vec::new();
    let mut acknowledged = Vec::new();
    for finding in all {
        let key = AckSpec {
            path: Some(finding.path.clone()),
            kind: finding.kind,
            line: finding.line,
            column: finding.column,
        };
        if acks.contains(&key) {
            acknowledged.push(finding);
        } else {
            remaining.push(finding);
        }
    }
    let clean = remaining.is_empty();
    let status = if !clean {
        "findings"
    } else if !acknowledged.is_empty() {
        "acknowledged"
    } else {
        "clean"
    };
    let remediation = if clean {
        "No unacknowledged credential-shaped runs were detected."
    } else {
        "Remove every reported credential before uploading or promoting. If any reported value was a live credential, rotate it immediately."
    };

    let stdout = if args.json {
        let payload = json!({
            "schema": "asimp.scrub.v1",
            "mode": args.mode.as_str(),
            "status": status,
            "clean": clean,
            "rule": "P7",
            "code": if clean { Value::Null } else { Value::String("SECRET_SHAPED_CONTENT".to_owned()) },
            "findings": remaining.iter().map(|f| json!({
                "path": f.path,
                "kind": f.kind.as_str(),
                "line": f.line,
                "column": f.column,
            })).collect::<Vec<_>>(),
            "acknowledged": acknowledged.iter().map(|f| json!({
                "path": f.path,
                "kind": f.kind.as_str(),
                "line": f.line,
                "column": f.column,
            })).collect::<Vec<_>>(),
            "truncated": truncated,
            "remediation": remediation,
        });
        format!("{payload}\n")
    } else if clean {
        if acknowledged.is_empty() {
            "clean (mode: ledger, rule P7): no credential-shaped runs found.\n".to_owned()
        } else {
            format!(
                "acknowledged (mode: ledger, rule P7): {} location(s) acknowledged, 0 remaining findings.\n",
                acknowledged.len()
            )
        }
    } else {
        let mut out = format!(
            "SECRET_SHAPED_CONTENT (mode: ledger, rule P7): {} finding(s); matched bytes are redacted:\n",
            remaining.len()
        );
        for f in &remaining {
            out.push_str(&format!(
                "  - {} at {} line {}, column {}\n",
                f.kind.as_str(),
                f.path,
                f.line,
                f.column
            ));
        }
        out.push_str(remediation);
        out.push('\n');
        out
    };

    CliOutput {
        exit_code: if clean { 0 } else { 1 },
        stdout,
        stderr: String::new(),
    }
}

fn format_artifact_result(args: &ScrubArgs, acks: &BTreeSet<AckSpec>, body: &str) -> CliOutput {
    let all = scan_body_for_secrets(body);
    let mut remaining = Vec::new();
    let mut acknowledged = Vec::new();
    for finding in all {
        let key = AckSpec {
            path: None,
            kind: finding.kind,
            line: finding.line,
            column: finding.column,
        };
        if acks.contains(&key) {
            acknowledged.push(finding);
        } else {
            remaining.push(finding);
        }
    }
    let clean = remaining.is_empty();
    let status = if !clean {
        "findings"
    } else if !acknowledged.is_empty() {
        "acknowledged"
    } else {
        "clean"
    };
    let remediation = if clean {
        "No unacknowledged secret or personal-address runs were detected."
    } else {
        "Remove every reported secret or personal address before uploading to CAS. If any reported value was a live credential, rotate it immediately."
    };

    let stdout = if args.json {
        let payload = json!({
            "schema": "asimp.scrub.v1",
            "mode": args.mode.as_str(),
            "status": status,
            "clean": clean,
            "rule": "P7",
            "code": if clean { Value::Null } else { Value::String("ARTIFACT_SECRET_SHAPED".to_owned()) },
            "findings": remaining.iter().map(|f| json!({
                "kind": f.kind.as_str(),
                "line": f.line,
                "column": f.column,
            })).collect::<Vec<_>>(),
            "acknowledged": acknowledged.iter().map(|f| json!({
                "kind": f.kind.as_str(),
                "line": f.line,
                "column": f.column,
            })).collect::<Vec<_>>(),
            "truncated": false,
            "remediation": remediation,
        });
        format!("{payload}\n")
    } else if clean {
        if acknowledged.is_empty() {
            "clean (mode: artifact, rule P7): no secret or personal-address runs found.\n"
                .to_owned()
        } else {
            format!(
                "acknowledged (mode: artifact, rule P7): {} location(s) acknowledged, 0 remaining findings.\n",
                acknowledged.len()
            )
        }
    } else {
        let mut out = format!(
            "ARTIFACT_SECRET_SHAPED (mode: artifact, rule P7): {} finding(s); matched bytes are redacted:\n",
            remaining.len()
        );
        for f in &remaining {
            out.push_str(&format!(
                "  - {} at line {}, column {}\n",
                f.kind.as_str(),
                f.line,
                f.column
            ));
        }
        out.push_str(remediation);
        out.push('\n');
        out
    };

    CliOutput {
        exit_code: if clean { 0 } else { 1 },
        stdout,
        stderr: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Cli;
    use clap::Parser;

    fn fellow_token() -> String {
        format!(
            "asimp_ag_{}_{}",
            "0123456789ABCDEFGHJKMNPQRS",
            "a".repeat(43)
        )
    }

    fn join_url() -> String {
        format!(
            "https://a.asimposium.org/join/ASIMP-EN-0123456789ABCDEF#v1.{}",
            "Q".repeat(43)
        )
    }

    fn enrollment_secret() -> String {
        format!("v1.{}", "Q".repeat(43))
    }

    fn flow_handle() -> String {
        format!("flow_v1.{}", "r".repeat(43))
    }

    fn github_pat() -> String {
        format!("ghp_{}", "x".repeat(36))
    }

    fn escaped_json(value: &str) -> String {
        value
            .encode_utf16()
            .map(|unit| format!("\\u{unit:04x}"))
            .collect()
    }

    #[test]
    fn each_credential_class_reports_redacted_location_without_bytes() {
        let token = fellow_token();
        let url = join_url();
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----";
        let body = format!("Lemma 1 holds.\ntoken {token}\nsee {url}\n{key}");
        let findings = scan_text_for_credentials("body_md", &body);
        assert_eq!(
            findings
                .iter()
                .map(|f| (f.kind.as_str(), f.line, f.column))
                .collect::<Vec<_>>(),
            vec![
                ("fellow-token", 2, 7),
                ("enrollment-secret", 3, 35),
                ("private-key", 4, 1),
            ]
        );
    }

    #[test]
    fn unicode_code_point_columns_match_worker_and_cas() {
        let aws = "AKIAABCDEFGHIJKLMNOP";
        let findings = scan_text_for_credentials("body_md", &format!("𝔽𝔽 {aws}"));
        assert_eq!(findings[0].column, 4);

        let token = format!("asimp_ag_{}_{}", "A".repeat(26), "x".repeat(43));
        let artifact = scan_body_for_secrets(&format!("😀 {token}"));
        assert_eq!(
            artifact
                .into_iter()
                .filter(|f| f.kind == FindingKind::FellowToken)
                .collect::<Vec<_>>(),
            vec![SecretFinding {
                kind: FindingKind::FellowToken,
                line: 1,
                column: 3,
            }]
        );
    }

    #[test]
    fn benign_math_lean_and_placeholders_stay_clean() {
        // Lean `h@Nat.succ_le` is legal in ledger/workshop mode (credential-scan.ts:9-12)
        // while artifact CAS mode flags email-like `x@y.z` spans as `personal-address`.
        let lean = "theorem foo (h : n > 0) : n ≥ 1 := by rw [h@Nat.succ_le]; exact h";
        assert_eq!(scan_text_for_credentials("body_md", lean), vec![]);
        assert_eq!(
            scan_body_for_secrets(lean),
            vec![SecretFinding {
                kind: FindingKind::PersonalAddress,
                line: 1,
                column: 43,
            }]
        );

        let benign = [
            "For all n, sk-1 = sk - 1 where s_k is the k-th partial sum.",
            "Contact: the authors' group at math.example.edu.",
            "Let AKIA be the incidence algebra.",
            "The asimp_ag_ prefix names Fellow tokens.",
            "Protocol v1.2, v1.0-rc1-build-2026 and capsule.v1.json are version labels.",
            "let token_count = 42; let password_length = 16;",
            "const token = nextToken(input);",
            "let secret = p*q;",
            "DB_PASSWORD=process.env.DB_PASSWORD",
            "DB_PASSWORD=os.environ[ \"DB_PASSWORD\" ]",
            "DB_PASSWORD=getenv( \"DB_PASSWORD\" )",
            "DB_PASSWORD=${DB_PASSWORD}",
            "DB_PASSWORD=<your_password>",
            "DB_PASSWORD=[REDACTED]",
            "DB_PASSWORD=\"\"",
            "postgresql://reader:<password>@db.invalid/research",
        ];
        for sample in benign {
            assert_eq!(
                scan_text_for_credentials("body_md", sample),
                vec![],
                "{sample}"
            );
            assert_eq!(scan_body_for_secrets(sample), vec![], "{sample}");
        }
        // Percent-encoded userinfo `%3Credacted%3E@db.invalid` is clean in ledger mode
        // (`credential-scan.ts:353`), while artifact mode's email regex matches `%3Credacted%3E@db.invalid`.
        let encoded_uri = "postgresql://reader:%3Credacted%3E@db.invalid/research";
        assert_eq!(scan_text_for_credentials("body_md", encoded_uri), vec![]);
        assert_eq!(
            scan_body_for_secrets(encoded_uri),
            vec![SecretFinding {
                kind: FindingKind::PersonalAddress,
                line: 1,
                column: 21,
            }]
        );
    }

    #[test]
    fn escaped_duplicate_and_deep_json_match_server_wall() {
        let gh = github_pat();
        let key_json = format!("{{\"{}\":\"ordinary\"}}", escaped_json(&gh));
        assert_eq!(
            scan_field_for_credentials("body_md", &key_json),
            vec![CredentialFinding {
                path: "[key:0]".to_owned(),
                kind: FindingKind::AccessToken,
                line: 1,
                column: 1,
            }]
        );
        let dup_json = format!(
            "{{\"payload\":\"{}\",\"payload\":\"ordinary\"}}",
            escaped_json(&gh)
        );
        assert_eq!(
            scan_field_for_credentials("body_md", &dup_json),
            vec![CredentialFinding {
                path: "payload".to_owned(),
                kind: FindingKind::AccessToken,
                line: 1,
                column: 1,
            }]
        );
        let depth = 20_000;
        let deep = format!(
            "{}\"{}\"{}",
            "[".repeat(depth),
            escaped_json(&gh),
            "]".repeat(depth)
        );
        assert_eq!(
            scan_field_for_credentials("body_md", &deep),
            vec![CredentialFinding {
                path: "[nested-field]".to_owned(),
                kind: FindingKind::AccessToken,
                line: 1,
                column: 1,
            }]
        );
    }

    #[test]
    fn json_artifact_fallback_and_personal_addresses_match_cas() {
        let body = "{\n  \"DB_PASSWORD\"\n  :\n  \"synthetic-artifact-password\"\n}";
        assert_eq!(
            scan_body_for_secrets(body),
            vec![SecretFinding {
                kind: FindingKind::AccessToken,
                line: 4,
                column: 4,
            }]
        );
        let mail = scan_body_for_secrets("reach me at researcher@example.org for the data");
        assert_eq!(
            mail,
            vec![SecretFinding {
                kind: FindingKind::PersonalAddress,
                line: 1,
                column: 13,
            }]
        );
        assert_eq!(
            scan_body_for_secrets(&format!("Notes\n𝔽 {}.", enrollment_secret())),
            vec![SecretFinding {
                kind: FindingKind::EnrollmentSecret,
                line: 2,
                column: 3,
            }]
        );
        assert_eq!(
            scan_body_for_secrets(&format!("Notes\n𝔽 {}.", flow_handle())),
            vec![SecretFinding {
                kind: FindingKind::PrefixedGrant,
                line: 2,
                column: 3,
            }]
        );
    }

    #[test]
    fn archive_member_paths_match_cas_safety_bounds() {
        assert!(archive_member_path_is_safe("src/main.lean"));
        assert!(archive_member_path_is_safe("a/b/c.txt"));
        assert!(!archive_member_path_is_safe("../escape"));
        assert!(!archive_member_path_is_safe("/absolute"));
        assert!(!archive_member_path_is_safe("C:\\windows"));
        assert!(!archive_member_path_is_safe("a/../../up"));
        assert!(!archive_member_path_is_safe(""));
    }

    #[test]
    fn acknowledged_false_positives_allow_heuristics_and_refuse_platform_tokens() {
        let cli_ack = Cli::try_parse_from([
            "asimp",
            "scrub",
            "--stdin",
            "--mode",
            "artifact",
            "--ack-false-positive",
            "personal-address:1:13",
            "--json",
        ])
        .unwrap();
        let out = run_with_readers(
            &cli_ack,
            |_| unreachable!(),
            || Ok("reach me at researcher@example.org".to_owned()),
        );
        assert_eq!(out.exit_code, 0);
        let parsed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(parsed["status"], "acknowledged");
        assert_eq!(parsed["findings"].as_array().unwrap().len(), 0);
        assert_eq!(parsed["acknowledged"].as_array().unwrap().len(), 1);
        assert!(!out.stdout.contains("researcher@example.org"));

        let cli_hard = Cli::try_parse_from([
            "asimp",
            "scrub",
            "--stdin",
            "--mode",
            "artifact",
            "--ack-false-positive",
            "fellow-token:1:1",
        ])
        .unwrap();
        let refused = run_with_readers(&cli_hard, |_| unreachable!(), || Ok(fellow_token()));
        assert_eq!(refused.exit_code, 2);
        assert!(refused.stdout.is_empty());
        assert!(refused.stderr.contains("cannot be acknowledged"));
    }
}
