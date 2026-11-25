//! One-way public ledger snapshot download & cryptographic integrity verifier
//! (`asimp pull <problem>`, W11.2 / `asimposiumorg-l3b`).
//!
//! Fetches `/p/<id>/export.jsonl.gz` (public read — NEVER acquires bearer token
//! or keychain credentials), decompresses within strict byte bounds, verifies
//! every framing, payload, envelope, hash-chain, embedded-checkpoint, and
//! publication-context commitment in exact parity with
//! `apps/wire/src/krater/export.ts` and `apps/wire/src/krater/krater.ts`, and
//! writes the verified snapshot atomically into `.asimp/problems/<id>/` (or
//! `--out <DIR>`).
//!
//! Honest assurance (Rule A4): chain + context verification proves export
//! self-consistency (and optional external checkpoint pin match). Ed25519
//! checkpoint signatures are checked when present. Operator authenticity still
//! requires independently pinned keys (`--trusted-keys`); unsigned or unpinned
//! archives stay `export-self-consistency-only`.

use crate::{
    Cli, CliOutput, Command, FetchError, OUTBOUND_USER_AGENT, READ_TIMEOUT, build_url,
    canonical_json::canonical_json,
    input_error,
    protocol::{
        DeprecationNotice, PROTOCOL_VERSION_HEADER, ProtocolMismatch, inspect_success_headers,
        parse_unsupported_version_problem, resolve_protocol_version,
    },
    resolve_origin,
    validate::sha256_hex,
};
use flate2::bufread::GzDecoder as BufReadGzDecoder;
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

/// Current public export format (`apps/wire/src/krater/export.ts:49`).
pub const PUBLIC_EXPORT_FORMAT: &str = "asimposium.problem-export.v5";
pub const PUBLIC_EXPORT_V4_FORMAT: &str = "asimposium.problem-export.v4";
pub const EXPORT_V3_FORMAT: &str = "asimposium.problem-export.v3";
pub const EXPORT_LICENSE: &str = "CC BY 4.0";
pub const KRATER_CHAIN_VERSION: u64 = 2;

/// Same per-event payload limit as `MAX_EXPORT_PAYLOAD_JSON_BYTES` in `export.ts:112`.
pub const MAX_EXPORT_PAYLOAD_JSON_BYTES: usize = 512 * 1024;
/// Bounded compressed download size (16 MiB).
pub const MAX_EXPORT_COMPRESSED_BYTES: u64 = 16 * 1024 * 1024;
/// Bounded decompressed NDJSON size (32 MiB) — defends against gzip bombs.
pub const MAX_EXPORT_DECOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;

/// Producer cap for a public archive (`PUBLIC_EXPORT_MAX_BYTES`). Network pulls
/// refuse anything larger; `--verify-file` may still inspect up to the 32 MiB ceiling.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_GZIP_BYTES: u64 = MAX_BYTES + 65_536;
const MAX_EVENTS: usize = 10_000;
const V4: &str = PUBLIC_EXPORT_V4_FORMAT;
const V5: &str = PUBLIC_EXPORT_FORMAT;
const INVALID: &str = "The archive is incomplete, unsupported or inconsistent. Retry this public read later, or inspect available event envelopes with asimp watch <problem> --once --json.";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_IDENTIFIER_LENGTH: usize = 160;
const MAX_TITLE_LENGTH: usize = 160;
const MAX_PUBLIC_NOTICES: usize = 10_000;

const EXPORT_HEADER_KEYS: &[&str] = &[
    "checkpoints",
    "control",
    "format",
    "generated_at",
    "license",
    "problem",
    "title",
];
const PUBLIC_EXPORT_V4_HEADER_KEYS: &[&str] = &[
    "checkpoints",
    "control",
    "format",
    "generated_at",
    "license",
    "problem",
    "publication_context_sha256",
    "title",
];
const PUBLIC_EXPORT_V5_HEADER_KEYS: &[&str] = &[
    "checkpoint_signatures",
    "checkpoints",
    "control",
    "format",
    "generated_at",
    "license",
    "problem",
    "publication_context_sha256",
    "title",
];
const EXPORT_CHECKPOINT_KEYS: &[&str] = &[
    "chain_version",
    "checkpoint_digest",
    "checkpoint_mode",
    "checkpoint_seq",
    "checkpoint_version",
    "problem",
    "root_chain_digest",
];
const EXPORT_EVENT_KEYS: &[&str] = &[
    "actor_fellow_id",
    "actor_session_id",
    "actor_sponsor_id",
    "chain_digest",
    "chain_version",
    "created_at",
    "event_id",
    "harness",
    "model_string_self_declared",
    "object_id",
    "object_kind",
    "object_version",
    "payload_json",
    "payload_sha256",
    "row_digest",
    "seq",
    "type",
    "writer_credential_id",
];
const EXPORT_TRAILER_KEYS: &[&str] = &["control", "event_count", "final_cursor", "problem"];
const PUBLICATION_CONTEXT_KEYS: &[&str] = &[
    "assurance",
    "context_sha256",
    "control",
    "format",
    "notices",
    "problem",
    "through",
];

#[derive(Debug, clap::Args)]
pub struct PullArgs {
    /// Public problem ID to snapshot (e.g. P-4DSP). Omit when using --verify-file.
    #[arg(
        required_unless_present = "verify_file",
        conflicts_with = "verify_file"
    )]
    pub problem: Option<String>,

    /// Base directory for one-way snapshots (default: .asimp; writes <out>/problems/<problem>/).
    #[arg(long, default_value = ".asimp", value_name = "DIR")]
    pub out: PathBuf,

    /// Verify an existing local .jsonl or .jsonl.gz export file offline without network I/O.
    #[arg(long, value_name = "PATH")]
    pub verify_file: Option<PathBuf>,

    /// Optional independently held checkpoint sequence to pin against the export chain.
    #[arg(long, requires = "pin_root", value_name = "SEQ")]
    pub pin_seq: Option<u64>,

    /// Optional independently held 64-hex SHA-256 root_chain_digest for --pin-seq.
    #[arg(long, requires = "pin_seq", value_name = "SHA256_HEX")]
    pub pin_root: Option<String>,

    /// Download and re-verify even if the local snapshot's ETag matches the server.
    #[arg(long, conflicts_with = "verify_file")]
    pub force: bool,

    /// New gzip file to create. Refuses an existing path, including a symlink.
    /// Omit to keep only the directory snapshot under `--out`.
    #[arg(long, value_name = "FILE")]
    pub output: Option<PathBuf>,

    /// Independently obtained JSON array of {key_id, public_key} verification keys.
    #[arg(long, value_name = "JSON_FILE")]
    pub trusted_keys: Option<PathBuf>,

    /// Require an independently pinned signature covering the complete event chain.
    #[arg(long, requires = "trusted_keys")]
    pub require_authenticated: bool,

    /// Emit deterministic structured JSON snapshot metadata on stdout.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointPin {
    pub problem_id: String,
    pub checkpoint_seq: u64,
    pub root_chain_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedExport {
    pub format: String,
    pub license: String,
    pub problem_id: String,
    pub title: String,
    pub generated_at: String,
    pub event_count: usize,
    pub final_cursor: u64,
    pub final_chain_digest: String,
    pub checkpoint_count: usize,
    pub publication_context_sha256: Option<String>,
    pub publication_notice_count: usize,
    pub export_sha256: String,
    pub assurance: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportVerifyError {
    pub broken_at_seq: Option<u64>,
    pub detail: String,
}

impl ExportVerifyError {
    fn at(seq: Option<u64>, detail: impl Into<String>) -> Self {
        Self {
            broken_at_seq: seq,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PullResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
    pub deprecation: Option<DeprecationNotice>,
}

#[derive(Debug)]
pub enum PullFetchError {
    Status { status: u16 },
    Withheld,
    NotFound,
    BodyTooLarge { limit_bytes: u64 },
    ProtocolMismatch(ProtocolMismatch),
    /// Gzip framing, content type, content encoding, or export-format header was refused.
    /// No response body is retained.
    RejectedArchive,
    Network,
}

/// Exact match to `PROBLEM_ID = /^P-[A-Z0-9][A-Z0-9-]{1,30}$/` (`export.ts:101`).
pub fn is_valid_problem_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("P-") else {
        return false;
    };
    let b = rest.as_bytes();
    (2..=31).contains(&b.len())
        && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|&c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn has_exact_keys(map: &Map<String, Value>, expected_sorted: &[&str]) -> bool {
    if map.len() != expected_sorted.len() {
        return false;
    }
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys == expected_sorted
}

fn bounded_non_blank(value: Option<&Value>, max_utf16: usize) -> Option<&str> {
    let s = value?.as_str()?;
    if s.encode_utf16().count() <= max_utf16 && !s.trim().is_empty() {
        Some(s)
    } else {
        None
    }
}

fn nullable_bounded_non_blank(value: Option<&Value>, max_utf16: usize) -> Result<Option<&str>, ()> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.encode_utf16().count() <= max_utf16 && !s.trim().is_empty() => {
            Ok(Some(s.as_str()))
        }
        _ => Err(()),
    }
}

fn non_negative_safe_int(value: Option<&Value>) -> Option<u64> {
    value?.as_u64().filter(|&n| n <= MAX_SAFE_INTEGER)
}

fn positive_safe_int(value: Option<&Value>) -> Option<u64> {
    non_negative_safe_int(value).filter(|&n| n > 0)
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// Exact match to `isUtcTimestamp` in `apps/wire/src/krater/export.ts:198-212`.
fn is_utc_timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    if !(20..=24).contains(&b.len()) || !b.ends_with(b"Z") {
        return false;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    let parse_u32 = |slice: &[u8]| -> Option<u32> {
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse::<u32>().ok()
    };
    let Some(year) = parse_u32(&b[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32(&b[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32(&b[8..10]) else {
        return false;
    };
    let Some(hour) = parse_u32(&b[11..13]) else {
        return false;
    };
    let Some(minute) = parse_u32(&b[14..16]) else {
        return false;
    };
    let Some(second) = parse_u32(&b[17..19]) else {
        return false;
    };
    if b.len() > 20 {
        if b[19] != b'.' {
            return false;
        }
        let frac = &b[20..b.len() - 1];
        if !(1..=3).contains(&frac.len()) || !frac.iter().all(u8::is_ascii_digit) {
            return false;
        }
    }
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

/// Exact match to `genesisChainDigest` (`apps/wire/src/krater/krater.ts:588-597`).
pub fn genesis_chain_digest(problem_id: &str) -> Result<String, ExportVerifyError> {
    let canon = canonical_json(&json!({
        "chain_version": KRATER_CHAIN_VERSION,
        "kind": "krater.genesis",
        "problem_id": problem_id,
    }))
    .map_err(|_| ExportVerifyError::at(None, "cannot canonicalize genesis digest"))?;
    Ok(sha256_hex(canon.as_bytes()))
}

/// Exact match to `eventEnvelopeRowDigest` (`apps/wire/src/krater/krater.ts:687-709`).
#[allow(clippy::too_many_arguments)]
pub fn event_envelope_row_digest(
    problem_id: &str,
    event_id: &str,
    seq: u64,
    event_type: &str,
    object_kind: &str,
    object_id: &str,
    object_version: u64,
    payload_sha256: &str,
    created_at: &str,
    actor_fellow_id: Option<&str>,
    actor_sponsor_id: Option<&str>,
    actor_session_id: Option<&str>,
    model_string_self_declared: Option<&str>,
    harness: Option<&str>,
    writer_credential_id: Option<&str>,
) -> Result<String, ExportVerifyError> {
    let canon = canonical_json(&json!({
        "chain_version": KRATER_CHAIN_VERSION,
        "created_at": created_at,
        "actor_fellow_id": actor_fellow_id,
        "actor_session_id": actor_session_id,
        "actor_sponsor_id": actor_sponsor_id,
        "event_id": event_id,
        "harness": harness,
        "model_string_self_declared": model_string_self_declared,
        "object_id": object_id,
        "object_kind": object_kind,
        "object_version": object_version,
        "payload_sha256": payload_sha256,
        "problem_id": problem_id,
        "seq": seq,
        "type": event_type,
        "writer_credential_id": writer_credential_id,
    }))
    .map_err(|_| ExportVerifyError::at(Some(seq), "cannot canonicalize event row digest"))?;
    Ok(sha256_hex(canon.as_bytes()))
}

/// Exact match to `eventChainDigest` (`apps/wire/src/krater/krater.ts:623-642`).
pub fn event_chain_digest(
    problem_id: &str,
    seq: u64,
    payload_sha256: &str,
    row_digest: &str,
    previous_chain_digest: &str,
) -> Result<String, ExportVerifyError> {
    let canon = canonical_json(&json!({
        "chain_version": KRATER_CHAIN_VERSION,
        "payload_sha256": payload_sha256,
        "previous_chain_digest": previous_chain_digest,
        "problem_id": problem_id,
        "row_digest": row_digest,
        "seq": seq,
    }))
    .map_err(|_| ExportVerifyError::at(Some(seq), "cannot canonicalize chain digest"))?;
    Ok(sha256_hex(canon.as_bytes()))
}

/// Exact match to `checkpointDigest` (`apps/wire/src/krater/krater.ts:737-752`).
pub fn checkpoint_digest(
    problem_id: &str,
    seq: u64,
    root_chain_digest: &str,
) -> Result<String, ExportVerifyError> {
    let canon = canonical_json(&json!({
        "chain_version": KRATER_CHAIN_VERSION,
        "checkpoint_version": 1,
        "problem_id": problem_id,
        "root_chain_digest": root_chain_digest,
        "seq": seq,
    }))
    .map_err(|_| ExportVerifyError::at(Some(seq), "cannot canonicalize checkpoint digest"))?;
    Ok(sha256_hex(canon.as_bytes()))
}

/// Exact match to `publicationContextDigest` (`apps/wire/src/krater/export.ts:252-255`).
pub fn publication_context_digest(
    context: &Map<String, Value>,
) -> Result<String, ExportVerifyError> {
    let mut fields = context.clone();
    fields.remove("context_sha256");
    let canon = canonical_json(&Value::Object(fields))
        .map_err(|_| ExportVerifyError::at(None, "cannot canonicalize publication context"))?;
    let mut material =
        String::with_capacity("asimposium.publication-context.v1\n".len() + canon.len());
    material.push_str("asimposium.publication-context.v1\n");
    material.push_str(&canon);
    Ok(sha256_hex(material.as_bytes()))
}

fn split_exact_lf_records(ndjson: &str) -> Result<Vec<&str>, ExportVerifyError> {
    if ndjson.is_empty() {
        return Err(ExportVerifyError::at(None, "empty export"));
    }
    if ndjson.contains('\r') {
        return Err(ExportVerifyError::at(
            None,
            "export must use LF line endings",
        ));
    }
    if !ndjson.ends_with('\n') {
        return Err(ExportVerifyError::at(None, "export must end with one LF"));
    }
    let lines: Vec<&str> = ndjson[..ndjson.len() - 1].split('\n').collect();
    if lines.iter().any(|line| line.is_empty()) {
        return Err(ExportVerifyError::at(None, "export carries a blank record"));
    }
    Ok(lines)
}

fn parse_json_object(line: &str, label: &str) -> Result<Map<String, Value>, ExportVerifyError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| ExportVerifyError::at(None, format!("{label} is not JSON")))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ExportVerifyError::at(
            None,
            format!("{label} is not an object"),
        )),
    }
}

struct ParsedCheckpoint {
    checkpoint_seq: u64,
    root_chain_digest: String,
    checkpoint_digest: String,
}

struct ParsedNotice {
    event_id: String,
    seq: u64,
    payload_sha256: String,
}

struct ParsedEvent {
    event_id: String,
    seq: u64,
    event_type: String,
    object_kind: String,
    object_id: String,
    object_version: u64,
    payload_sha256: String,
    payload_json: String,
    row_digest: String,
    chain_digest: String,
    created_at: String,
    actor_fellow_id: Option<String>,
    actor_sponsor_id: Option<String>,
    actor_session_id: Option<String>,
    model_string_self_declared: Option<String>,
    harness: Option<String>,
    writer_credential_id: Option<String>,
}

fn parse_checkpoint(
    value: &Value,
    problem: &str,
    index: usize,
) -> Result<ParsedCheckpoint, ExportVerifyError> {
    let Some(map) = value.as_object() else {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} does not have the exact v3 shape"),
        ));
    };
    if !has_exact_keys(map, EXPORT_CHECKPOINT_KEYS) {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} does not have the exact v3 shape"),
        ));
    }
    if map.get("problem").and_then(Value::as_str) != Some(problem) {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} is not bound to the header problem"),
        ));
    }
    let Some(checkpoint_seq) = positive_safe_int(map.get("checkpoint_seq")) else {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} carries invalid v3 fields"),
        ));
    };
    let Some(root_chain_digest) = map
        .get("root_chain_digest")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
    else {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} carries invalid v3 fields"),
        ));
    };
    let Some(checkpoint_digest_str) = map
        .get("checkpoint_digest")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
    else {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} carries invalid v3 fields"),
        ));
    };
    if map.get("chain_version").and_then(Value::as_u64) != Some(KRATER_CHAIN_VERSION)
        || map.get("checkpoint_version").and_then(Value::as_u64) != Some(1)
        || map.get("checkpoint_mode").and_then(Value::as_str) != Some("unsigned-v0")
    {
        return Err(ExportVerifyError::at(
            None,
            format!("header checkpoint {index} carries invalid v3 fields"),
        ));
    }
    Ok(ParsedCheckpoint {
        checkpoint_seq,
        root_chain_digest: root_chain_digest.to_owned(),
        checkpoint_digest: checkpoint_digest_str.to_owned(),
    })
}

fn parse_event_record(line: &str, offset_seq: u64) -> Result<ParsedEvent, ExportVerifyError> {
    let map = parse_json_object(line, "event line")
        .map_err(|e| ExportVerifyError::at(Some(offset_seq), e.detail))?;
    if !has_exact_keys(&map, EXPORT_EVENT_KEYS) {
        return Err(ExportVerifyError::at(
            Some(offset_seq),
            "event line does not have the exact export shape",
        ));
    }
    let invalid = || {
        ExportVerifyError::at(
            Some(offset_seq),
            "event line carries invalid v3 envelope fields",
        )
    };
    let event_id =
        bounded_non_blank(map.get("event_id"), MAX_IDENTIFIER_LENGTH).ok_or_else(invalid)?;
    let seq = positive_safe_int(map.get("seq")).ok_or_else(invalid)?;
    let event_type =
        bounded_non_blank(map.get("type"), MAX_IDENTIFIER_LENGTH).ok_or_else(invalid)?;
    let object_kind =
        bounded_non_blank(map.get("object_kind"), MAX_IDENTIFIER_LENGTH).ok_or_else(invalid)?;
    let object_id =
        bounded_non_blank(map.get("object_id"), MAX_IDENTIFIER_LENGTH).ok_or_else(invalid)?;
    let object_version = positive_safe_int(map.get("object_version")).ok_or_else(invalid)?;
    let payload_json = map
        .get("payload_json")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= MAX_EXPORT_PAYLOAD_JSON_BYTES)
        .ok_or_else(invalid)?;
    let payload_sha256 = map
        .get("payload_sha256")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
        .ok_or_else(invalid)?;
    let row_digest = map
        .get("row_digest")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
        .ok_or_else(invalid)?;
    let chain_digest = map
        .get("chain_digest")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
        .ok_or_else(invalid)?;
    if map.get("chain_version").and_then(Value::as_u64) != Some(KRATER_CHAIN_VERSION) {
        return Err(invalid());
    }
    let created_at = map
        .get("created_at")
        .and_then(Value::as_str)
        .filter(|s| is_utc_timestamp(s))
        .ok_or_else(invalid)?;
    let actor_fellow_id =
        nullable_bounded_non_blank(map.get("actor_fellow_id"), MAX_IDENTIFIER_LENGTH)
            .map_err(|()| invalid())?;
    let actor_sponsor_id =
        nullable_bounded_non_blank(map.get("actor_sponsor_id"), MAX_IDENTIFIER_LENGTH)
            .map_err(|()| invalid())?;
    let actor_session_id =
        nullable_bounded_non_blank(map.get("actor_session_id"), MAX_IDENTIFIER_LENGTH)
            .map_err(|()| invalid())?;
    let model_string_self_declared =
        nullable_bounded_non_blank(map.get("model_string_self_declared"), MAX_IDENTIFIER_LENGTH)
            .map_err(|()| invalid())?;
    let harness = nullable_bounded_non_blank(map.get("harness"), MAX_IDENTIFIER_LENGTH)
        .map_err(|()| invalid())?;
    let writer_credential_id =
        nullable_bounded_non_blank(map.get("writer_credential_id"), MAX_IDENTIFIER_LENGTH)
            .map_err(|()| invalid())?;

    Ok(ParsedEvent {
        event_id: event_id.to_owned(),
        seq,
        event_type: event_type.to_owned(),
        object_kind: object_kind.to_owned(),
        object_id: object_id.to_owned(),
        object_version,
        payload_sha256: payload_sha256.to_owned(),
        payload_json: payload_json.to_owned(),
        row_digest: row_digest.to_owned(),
        chain_digest: chain_digest.to_owned(),
        created_at: created_at.to_owned(),
        actor_fellow_id: actor_fellow_id.map(str::to_owned),
        actor_sponsor_id: actor_sponsor_id.map(str::to_owned),
        actor_session_id: actor_session_id.map(str::to_owned),
        model_string_self_declared: model_string_self_declared.map(str::to_owned),
        harness: harness.map(str::to_owned),
        writer_credential_id: writer_credential_id.map(str::to_owned),
    })
}

fn parse_publication_context(
    line: &str,
    expected_digest: &str,
) -> Result<(String, u64, Vec<ParsedNotice>, String), ExportVerifyError> {
    let map = parse_json_object(line, "publication context")?;
    if !has_exact_keys(&map, PUBLICATION_CONTEXT_KEYS) {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    }
    if map.get("control").and_then(Value::as_str) != Some("publication_context")
        || map.get("format").and_then(Value::as_str) != Some("asimposium.publication-context.v1")
        || map.get("assurance").and_then(Value::as_str) != Some("export-self-consistency-only")
    {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    }
    let Some(problem) = map
        .get("problem")
        .and_then(Value::as_str)
        .filter(|s| is_valid_problem_id(s))
    else {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    };
    let Some(through) =
        non_negative_safe_int(map.get("through")).filter(|&n| n <= MAX_PUBLIC_NOTICES as u64)
    else {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    };
    let Some(context_sha256) = map
        .get("context_sha256")
        .and_then(Value::as_str)
        .filter(|s| is_sha256_hex(s))
    else {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    };
    if context_sha256 != expected_digest {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    }
    let Some(notices_arr) = map.get("notices").and_then(Value::as_array) else {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    };
    if notices_arr.len() > MAX_PUBLIC_NOTICES {
        return Err(ExportVerifyError::at(
            None,
            "public export has invalid publication context",
        ));
    }
    let mut notices = Vec::with_capacity(notices_arr.len());
    let mut seen_ids = BTreeSet::new();
    let mut prev_seq = 0u64;
    for entry in notices_arr {
        let Some(obj) = entry.as_object() else {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        };
        if !has_exact_keys(
            obj,
            &["event_id", "payload_sha256", "screening_notice", "seq"],
        ) {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        }
        let Some(event_id) = bounded_non_blank(obj.get("event_id"), MAX_IDENTIFIER_LENGTH) else {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        };
        let Some(seq) = positive_safe_int(obj.get("seq")).filter(|&n| n <= through && n > prev_seq)
        else {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        };
        let Some(payload_sha256) = obj
            .get("payload_sha256")
            .and_then(Value::as_str)
            .filter(|s| is_sha256_hex(s))
        else {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        };
        if !obj.get("screening_notice").is_some_and(Value::is_object)
            || !seen_ids.insert(event_id.to_owned())
        {
            return Err(ExportVerifyError::at(
                None,
                "public export has invalid publication context",
            ));
        }
        prev_seq = seq;
        notices.push(ParsedNotice {
            event_id: event_id.to_owned(),
            seq,
            payload_sha256: payload_sha256.to_owned(),
        });
    }
    let recomputed = publication_context_digest(&map)?;
    if recomputed != context_sha256 {
        return Err(ExportVerifyError::at(
            None,
            "publication context digest does not match",
        ));
    }
    Ok((problem.to_owned(), through, notices, recomputed))
}

/// Verify a decompressed NDJSON export (`v3`, `v4`, or `v5`) in exact parity with
/// `verifyPublicProblemExportChain` / `verifyProblemExportChain` in `export.ts`.
pub fn verify_export_ndjson(
    ndjson: &str,
    pin: Option<&CheckpointPin>,
) -> Result<VerifiedExport, ExportVerifyError> {
    let lines = split_exact_lf_records(ndjson)?;
    if lines.len() < 2 {
        return Err(ExportVerifyError::at(
            None,
            "export is missing its terminal control record",
        ));
    }
    let header_map = parse_json_object(lines[0], "header")?;
    let format = header_map
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ExportVerifyError::at(None, "header carries an unrecognized export format")
        })?;

    let is_public = match format {
        PUBLIC_EXPORT_FORMAT => {
            if !has_exact_keys(&header_map, PUBLIC_EXPORT_V5_HEADER_KEYS) {
                return Err(ExportVerifyError::at(
                    None,
                    "header does not have an exact supported public export shape",
                ));
            }
            true
        }
        PUBLIC_EXPORT_V4_FORMAT => {
            if !has_exact_keys(&header_map, PUBLIC_EXPORT_V4_HEADER_KEYS) {
                return Err(ExportVerifyError::at(
                    None,
                    "header does not have an exact supported public export shape",
                ));
            }
            true
        }
        EXPORT_V3_FORMAT => {
            if !has_exact_keys(&header_map, EXPORT_HEADER_KEYS) {
                return Err(ExportVerifyError::at(
                    None,
                    "header does not have the exact v3 shape",
                ));
            }
            false
        }
        _ => {
            return Err(ExportVerifyError::at(
                None,
                "header carries an unrecognized export format",
            ));
        }
    };

    if header_map.get("control").and_then(Value::as_str) != Some("export_header") {
        return Err(ExportVerifyError::at(
            None,
            "first line is not the export header",
        ));
    }
    if header_map.get("license").and_then(Value::as_str) != Some(EXPORT_LICENSE) {
        return Err(ExportVerifyError::at(
            None,
            "header carries an unrecognized export license",
        ));
    }
    let problem = header_map
        .get("problem")
        .and_then(Value::as_str)
        .filter(|s| is_valid_problem_id(s))
        .ok_or_else(|| ExportVerifyError::at(None, "header carries no valid problem id"))?
        .to_owned();
    let title = bounded_non_blank(header_map.get("title"), MAX_TITLE_LENGTH)
        .ok_or_else(|| ExportVerifyError::at(None, "header carries no valid problem title"))?
        .to_owned();
    let generated_at = header_map
        .get("generated_at")
        .and_then(Value::as_str)
        .filter(|s| is_utc_timestamp(s))
        .ok_or_else(|| ExportVerifyError::at(None, "header carries no valid generation timestamp"))?
        .to_owned();

    let checkpoints_arr = header_map
        .get("checkpoints")
        .and_then(Value::as_array)
        .ok_or_else(|| ExportVerifyError::at(None, "header checkpoints are not an array"))?;
    let mut checkpoints = Vec::with_capacity(checkpoints_arr.len());
    let mut prev_cp_seq = 0u64;
    for (idx, cp) in checkpoints_arr.iter().enumerate() {
        let parsed = parse_checkpoint(cp, &problem, idx + 1)?;
        if parsed.checkpoint_seq <= prev_cp_seq {
            return Err(ExportVerifyError::at(
                None,
                "header checkpoints are not in strict sequence order",
            ));
        }
        prev_cp_seq = parsed.checkpoint_seq;
        checkpoints.push(parsed);
    }

    let (event_start_idx, pub_ctx_info) = if is_public {
        if lines.len() < 3 {
            return Err(ExportVerifyError::at(
                None,
                "public export is missing its publication context",
            ));
        }
        let expected_ctx_sha = header_map
            .get("publication_context_sha256")
            .and_then(Value::as_str)
            .filter(|s| is_sha256_hex(s))
            .ok_or_else(|| {
                ExportVerifyError::at(None, "public export has invalid publication context")
            })?;
        let ctx = parse_publication_context(lines[1], expected_ctx_sha)?;
        if format == PUBLIC_EXPORT_FORMAT {
            let sig_bundle = header_map
                .get("checkpoint_signatures")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ExportVerifyError::at(None, "public export has invalid checkpoint signatures")
                })?;
            if sig_bundle.get("problem_id").and_then(Value::as_str) != Some(problem.as_str()) {
                return Err(ExportVerifyError::at(
                    None,
                    "publication context or checkpoint signatures name a different exported cut",
                ));
            }
            if non_negative_safe_int(sig_bundle.get("through")) != Some(ctx.1) {
                return Err(ExportVerifyError::at(
                    None,
                    "publication context or checkpoint signatures name a different exported cut",
                ));
            }
        }
        (2usize, Some(ctx))
    } else {
        (1usize, None)
    };

    // Parse trailer
    let trailer_map = parse_json_object(lines[lines.len() - 1], "terminal record")?;
    if !has_exact_keys(&trailer_map, EXPORT_TRAILER_KEYS) {
        return Err(ExportVerifyError::at(
            None,
            "terminal record does not have the exact v3 shape",
        ));
    }
    if trailer_map.get("control").and_then(Value::as_str) != Some("export_end") {
        return Err(ExportVerifyError::at(
            None,
            "last line is not the export trailer",
        ));
    }
    let trailer_problem = trailer_map
        .get("problem")
        .and_then(Value::as_str)
        .filter(|s| is_valid_problem_id(s))
        .ok_or_else(|| {
            ExportVerifyError::at(None, "terminal record carries no valid problem id")
        })?;
    if trailer_problem != problem {
        return Err(ExportVerifyError::at(
            None,
            "the terminal record's problem id does not match the header",
        ));
    }
    let trailer_event_count =
        non_negative_safe_int(trailer_map.get("event_count")).ok_or_else(|| {
            ExportVerifyError::at(None, "terminal record carries no exact event count")
        })?;
    let trailer_final_cursor =
        non_negative_safe_int(trailer_map.get("final_cursor")).ok_or_else(|| {
            ExportVerifyError::at(None, "terminal record carries no exact final cursor")
        })?;

    // Parse all events
    let event_lines = &lines[event_start_idx..lines.len() - 1];
    let mut events = Vec::with_capacity(event_lines.len());
    for (idx, line) in event_lines.iter().enumerate() {
        events.push(parse_event_record(line, (idx + 1) as u64)?);
    }
    if checkpoints.len() > events.len() {
        return Err(ExportVerifyError::at(
            None,
            "export carries more checkpoints than events",
        ));
    }
    if checkpoints
        .iter()
        .any(|cp| cp.checkpoint_seq > events.len() as u64)
    {
        return Err(ExportVerifyError::at(
            None,
            "header checkpoint references an event beyond the export",
        ));
    }

    if let Some(pin) = pin
        && (pin.problem_id != problem
            || pin.checkpoint_seq == 0
            || pin.checkpoint_seq > MAX_SAFE_INTEGER
            || !is_sha256_hex(&pin.root_chain_digest))
    {
        return Err(ExportVerifyError::at(
            None,
            "the external checkpoint pin is invalid or names another problem",
        ));
    }

    // Recompute genesis + every payload, row, chain, and checkpoint digest.
    let mut previous = genesis_chain_digest(&problem)?;
    let mut expected_seq = 1u64;
    let mut next_checkpoint = 0usize;
    let mut matched_external_pin = pin.is_none();
    let mut event_index: BTreeMap<u64, (&str, &str)> = BTreeMap::new();

    for event in &events {
        if event.seq != expected_seq {
            return Err(ExportVerifyError::at(
                Some(expected_seq),
                format!(
                    "sequence gap: expected seq {expected_seq}, found {}",
                    event.seq
                ),
            ));
        }
        let recomputed_payload = sha256_hex(event.payload_json.as_bytes());
        if recomputed_payload != event.payload_sha256 {
            return Err(ExportVerifyError::at(
                Some(event.seq),
                format!(
                    "payload sha256 mismatch at seq {} — the exported payload bytes do not match their digest",
                    event.seq
                ),
            ));
        }
        let recomputed_row = event_envelope_row_digest(
            &problem,
            &event.event_id,
            event.seq,
            &event.event_type,
            &event.object_kind,
            &event.object_id,
            event.object_version,
            &event.payload_sha256,
            &event.created_at,
            event.actor_fellow_id.as_deref(),
            event.actor_sponsor_id.as_deref(),
            event.actor_session_id.as_deref(),
            event.model_string_self_declared.as_deref(),
            event.harness.as_deref(),
            event.writer_credential_id.as_deref(),
        )?;
        if recomputed_row != event.row_digest {
            return Err(ExportVerifyError::at(
                Some(event.seq),
                format!(
                    "row digest mismatch at seq {} — the event envelope is tampered",
                    event.seq
                ),
            ));
        }
        let recomputed_chain = event_chain_digest(
            &problem,
            event.seq,
            &event.payload_sha256,
            &recomputed_row,
            &previous,
        )?;
        if recomputed_chain != event.chain_digest {
            return Err(ExportVerifyError::at(
                Some(event.seq),
                format!(
                    "chain digest mismatch at seq {} — the export is tampered or truncated",
                    event.seq
                ),
            ));
        }
        previous = event.chain_digest.clone();
        event_index.insert(event.seq, (&event.event_id, &event.payload_sha256));

        if let Some(pin) = pin
            && pin.checkpoint_seq == event.seq
        {
            if pin.root_chain_digest != previous {
                return Err(ExportVerifyError::at(
                    Some(event.seq),
                    format!("external checkpoint root mismatch at seq {}", event.seq),
                ));
            }
            matched_external_pin = true;
        }

        if let Some(cp) = checkpoints.get(next_checkpoint)
            && cp.checkpoint_seq == event.seq
        {
            if cp.root_chain_digest != previous {
                return Err(ExportVerifyError::at(
                    Some(event.seq),
                    format!("checkpoint root mismatch at seq {}", event.seq),
                ));
            }
            let recomputed_cp =
                checkpoint_digest(&problem, cp.checkpoint_seq, &cp.root_chain_digest)?;
            if recomputed_cp != cp.checkpoint_digest {
                return Err(ExportVerifyError::at(
                    Some(event.seq),
                    format!("checkpoint digest mismatch at seq {}", event.seq),
                ));
            }
            next_checkpoint += 1;
        }

        expected_seq += 1;
    }

    if trailer_event_count != events.len() as u64 {
        return Err(ExportVerifyError::at(
            None,
            format!(
                "terminal record claims {trailer_event_count} events; the export carries {}",
                events.len()
            ),
        ));
    }
    let final_seq = expected_seq - 1;
    if trailer_final_cursor != final_seq {
        return Err(ExportVerifyError::at(
            None,
            format!(
                "terminal record claims final cursor {trailer_final_cursor}; the export ends at {final_seq}"
            ),
        ));
    }
    if next_checkpoint != checkpoints.len() {
        return Err(ExportVerifyError::at(
            None,
            "header checkpoint references an event absent from the verified chain",
        ));
    }
    if !matched_external_pin {
        return Err(ExportVerifyError::at(
            None,
            "the external checkpoint pin names an event absent from the verified export",
        ));
    }

    let (publication_context_sha256, publication_notice_count) =
        if let Some((ctx_problem, ctx_through, notices, ctx_sha)) = pub_ctx_info {
            if ctx_problem != problem || ctx_through != trailer_final_cursor {
                return Err(ExportVerifyError::at(
                    None,
                    "publication context or checkpoint signatures name a different exported cut",
                ));
            }
            for notice in &notices {
                let matched = event_index.get(&notice.seq).is_some_and(|&(eid, psha)| {
                    eid == notice.event_id && psha == notice.payload_sha256
                });
                if !matched {
                    return Err(ExportVerifyError::at(
                        Some(notice.seq),
                        "publication notice is detached from its exact source",
                    ));
                }
            }
            (Some(ctx_sha), notices.len())
        } else {
            (None, 0)
        };

    Ok(VerifiedExport {
        format: format.to_owned(),
        license: EXPORT_LICENSE.to_owned(),
        problem_id: problem,
        title,
        generated_at,
        event_count: events.len(),
        final_cursor: final_seq,
        final_chain_digest: previous,
        checkpoint_count: checkpoints.len(),
        publication_context_sha256,
        publication_notice_count,
        export_sha256: sha256_hex(ndjson.as_bytes()),
        assurance: "export-self-consistency-only",
    })
}

/// Decompress gzip bytes into UTF-8 NDJSON within a hard byte ceiling (defends
/// against gzip bombs). Accepts plain UTF-8 NDJSON when `allow_plain` is true
/// (used only by `--verify-file`).
pub fn decode_export_bytes(
    raw: &[u8],
    allow_plain: bool,
    max_decompressed_bytes: u64,
) -> Result<String, ExportVerifyError> {
    let is_gzip = raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b;
    if !is_gzip {
        if !allow_plain {
            return Err(ExportVerifyError::at(
                None,
                "export response is not gzip-framed",
            ));
        }
        if raw.len() as u64 > max_decompressed_bytes {
            return Err(ExportVerifyError::at(
                None,
                "export exceeds maximum supported decompressed size",
            ));
        }
        return String::from_utf8(raw.to_vec())
            .map_err(|_| ExportVerifyError::at(None, "export is not valid UTF-8"));
    }
    if raw.len() as u64 > MAX_EXPORT_COMPRESSED_BYTES.max(MAX_GZIP_BYTES) {
        return Err(ExportVerifyError::at(
            None,
            "export exceeds maximum supported compressed size",
        ));
    }
    // A single gzip member only. Trailing bytes and concatenated members are
    // refused after the CRC and length are checked.
    let mut decoder = BufReadGzDecoder::new(raw);
    let mut out = Vec::new();
    decoder
        .by_ref()
        .take(max_decompressed_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|_| ExportVerifyError::at(None, "corrupt or truncated gzip export stream"))?;
    if !decoder.into_inner().is_empty() {
        return Err(ExportVerifyError::at(
            None,
            "export gzip has trailing bytes or another member",
        ));
    }
    if out.len() as u64 > max_decompressed_bytes {
        return Err(ExportVerifyError::at(
            None,
            "decompressed export exceeds maximum byte limit",
        ));
    }
    String::from_utf8(out)
        .map_err(|_| ExportVerifyError::at(None, "decompressed export is not valid UTF-8"))
}

fn validate_out_dir(out: &Path) -> Result<(), &'static str> {
    if out.as_os_str().is_empty() {
        return Err("--out must name a non-empty directory path.");
    }
    if out.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("--out must not contain '..' parent traversal components.");
    }
    Ok(())
}

fn read_existing_etag(problem_dir: &Path) -> Option<String> {
    let meta_path = problem_dir.join("meta.json");
    let raw = fs::read_to_string(meta_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("etag")
        .and_then(Value::as_str)
        .filter(|e| {
            !e.is_empty() && e.len() <= 200 && e.bytes().all(|b| (0x20..=0x7e).contains(&b))
        })
        .map(str::to_owned)
}

fn write_file_atomic(target: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let parent = target
        .parent()
        .ok_or("Cannot determine target parent directory.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create snapshot output directory.")?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Cannot determine snapshot filename.")?;
    let tmp = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|_| "Cannot write temporary snapshot file.")?;
    fs::rename(&tmp, target).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        "Cannot move verified snapshot into place."
    })
}

fn fetch_export_http(
    url: &str,
    protocol_version: &str,
    if_none_match: Option<&str>,
) -> Result<PullResponse, PullFetchError> {
    let agent = ureq::AgentBuilder::new()
        .user_agent(OUTBOUND_USER_AGENT)
        .timeout(READ_TIMEOUT)
        .timeout_connect(READ_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .redirects(0)
        .build();
    let mut request = agent
        .get(url)
        .set("accept", "application/gzip")
        .set("accept-encoding", "identity")
        .set(PROTOCOL_VERSION_HEADER, protocol_version);
    if let Some(etag) = if_none_match {
        request = request.set("if-none-match", etag);
    }
    let response = match request.call() {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, resp)) => {
            if code == 400 {
                let mut buf = Vec::new();
                let _ = resp.into_reader().take(16 * 1024).read_to_end(&mut buf);
                let text = std::str::from_utf8(&buf).ok();
                if let Some(mismatch) =
                    parse_unsupported_version_problem(protocol_version, code, text)
                {
                    return Err(PullFetchError::ProtocolMismatch(mismatch));
                }
            }
            return match code {
                404 => Err(PullFetchError::NotFound),
                409 => Err(PullFetchError::Withheld),
                other => Err(PullFetchError::Status { status: other }),
            };
        }
        Err(_) => return Err(PullFetchError::Network),
    };

    let status = response.status();
    let deprecation = inspect_success_headers(
        protocol_version,
        response.header(PROTOCOL_VERSION_HEADER),
        response.header("deprecation"),
        response.header("sunset"),
        response.header("link"),
    )
    .map_err(PullFetchError::ProtocolMismatch)?;
    let etag = response
        .header("etag")
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 200)
        .map(str::to_owned);

    if status == 304 {
        return Ok(PullResponse {
            status,
            etag,
            body: Vec::new(),
            deprecation,
        });
    }
    if status != 200 {
        return Err(PullFetchError::Status { status });
    }
    let format_header = response
        .header("x-asimposium-export-format")
        .unwrap_or("")
        .to_owned();
    let content_type = response
        .header("content-type")
        .map(|value| value.split(';').next().unwrap_or("").trim().to_owned());
    let encoding = response.header("content-encoding").map(str::to_owned);
    if !matches!(format_header.as_str(), V4 | V5)
        || content_type.as_deref() != Some("application/gzip")
        || encoding.as_deref().is_some_and(|value| value != "identity")
    {
        return Err(PullFetchError::RejectedArchive);
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_GZIP_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| PullFetchError::Network)?;
    if bytes.len() as u64 > MAX_GZIP_BYTES {
        return Err(PullFetchError::BodyTooLarge {
            limit_bytes: MAX_GZIP_BYTES,
        });
    }
    Ok(PullResponse {
        status,
        etag,
        body: bytes,
        deprecation,
    })
}

fn snapshot_json(
    origin: Option<&str>,
    verified: &VerifiedExport,
    etag: Option<&str>,
    not_modified: bool,
    export_path: Option<&Path>,
) -> Value {
    json!({
        "schema": "asimp.pull.v1",
        "ok": true,
        "origin": origin,
        "problem_id": verified.problem_id,
        "title": verified.title,
        "format": verified.format,
        "license": verified.license,
        "generated_at": verified.generated_at,
        "event_count": verified.event_count,
        "final_cursor": verified.final_cursor,
        "final_chain_digest": verified.final_chain_digest,
        "checkpoint_count": verified.checkpoint_count,
        "publication_context_sha256": verified.publication_context_sha256,
        "publication_notice_count": verified.publication_notice_count,
        "export_sha256": verified.export_sha256,
        "etag": etag,
        "not_modified": not_modified,
        "assurance": verified.assurance,
        "snapshot_file": export_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn render_verified_human(
    verified: &VerifiedExport,
    not_modified: bool,
    export_path: Option<&Path>,
) -> String {
    let status = if not_modified {
        "up to date (304 Not Modified)"
    } else if export_path.is_some() {
        "verified and saved"
    } else {
        "verified offline"
    };
    let mut out = format!(
        "asimp pull: {} — {status}\n  format: {}\n  events: {} (final cursor {})\n  final_chain_digest: {}\n  checkpoints: {}\n  assurance: {}\n",
        verified.problem_id,
        verified.format,
        verified.event_count,
        verified.final_cursor,
        verified.final_chain_digest,
        verified.checkpoint_count,
        verified.assurance
    );
    if let Some(ctx) = &verified.publication_context_sha256 {
        out.push_str(&format!(
            "  publication_context_sha256: {ctx} (notices: {})\n",
            verified.publication_notice_count
        ));
    }
    if let Some(path) = export_path {
        out.push_str(&format!("  snapshot: {}\n", path.display()));
    }
    out
}

pub fn run(cli: &Cli) -> CliOutput {
    run_with_fetch(cli, fetch_export_http)
}

pub fn run_with_fetch(
    cli: &Cli,
    fetch: impl FnOnce(&str, &str, Option<&str>) -> Result<PullResponse, PullFetchError>,
) -> CliOutput {
    let Command::Pull(args) = &cli.command else {
        return input_error("Expected the pull command.");
    };
    let trusted = match trusted_keys(args.trusted_keys.as_deref()) {
        Ok(keys) => keys,
        Err(error) => return failed(args, 2, error),
    };

    // Offline local archive verification mode (`--verify-file`).
    if let Some(path) = &args.verify_file {
        let metadata = match fs::metadata(path) {
            Ok(m) if m.is_file() => m,
            _ => {
                return input_error(
                    "Cannot read --verify-file; supply an accessible regular .jsonl or .jsonl.gz export file.",
                );
            }
        };
        if metadata.len() > MAX_EXPORT_DECOMPRESSED_BYTES {
            return input_error("Export file exceeds maximum supported size.");
        }
        let raw = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => return input_error("Cannot read --verify-file; check file permissions."),
        };
        let ndjson = match decode_export_bytes(&raw, true, MAX_EXPORT_DECOMPRESSED_BYTES) {
            Ok(s) => s,
            Err(err) => {
                return verify_failure_output(args.json, &err);
            }
        };
        let pin = match (&args.pin_seq, &args.pin_root) {
            (Some(seq), Some(root)) => {
                // Bind pin problem_id after peeking header? Better: read problem_id from line 1.
                let first_line = ndjson.split('\n').next().unwrap_or("");
                let pid = serde_json::from_str::<Value>(first_line)
                    .ok()
                    .and_then(|v| v.get("problem").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_default();
                Some(CheckpointPin {
                    problem_id: pid,
                    checkpoint_seq: *seq,
                    root_chain_digest: root.clone(),
                })
            }
            _ => None,
        };
        let verified = match verify_export_ndjson(&ndjson, pin.as_ref()) {
            Ok(verified) => verified,
            Err(err) => return verify_failure_output(args.json, &err),
        };
        if let Some(output) = authenticate_archive(args, &trusted, &verified.problem_id, &ndjson) {
            return output;
        }
        return CliOutput {
            exit_code: 0,
            stdout: if args.json {
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&snapshot_json(
                        None, &verified, None, false, None
                    ))
                    .unwrap_or_default()
                )
            } else {
                render_verified_human(&verified, false, None)
            },
            stderr: String::new(),
        };
    }

    let Some(problem) = args.problem.as_deref() else {
        return failed(
            args,
            2,
            "Supply a public problem ID such as P-4DSP.",
        );
    };
    if !is_valid_problem_id(problem) || !problem_id(problem) {
        return failed(args, 2, "Supply a public problem ID such as P-4DSP.");
    }
    if let Err(msg) = validate_out_dir(&args.out) {
        return input_error(msg);
    }
    let protocol_version = match resolve_protocol_version(cli.protocol_version.as_ref()) {
        Ok(v) => v,
        Err(msg) => return input_error(&msg),
    };
    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(o) => o,
        Err(_) => {
            return failed(
                args,
                2,
                "Choose a valid HTTPS --origin before downloading a public archive.",
            );
        }
    };
    let path = format!("/p/{problem}/export.jsonl.gz");
    let url = match build_url(&origin, &path) {
        Ok(u) => u,
        Err(msg) => return input_error(&msg),
    };

    let pin = match (&args.pin_seq, &args.pin_root) {
        (Some(seq), Some(root)) => {
            if *seq == 0 || *seq > MAX_SAFE_INTEGER || !is_sha256_hex(root) {
                return input_error(
                    "--pin-seq must be a positive safe integer and --pin-root must be 64 lowercase hex characters.",
                );
            }
            Some(CheckpointPin {
                problem_id: problem.to_owned(),
                checkpoint_seq: *seq,
                root_chain_digest: root.clone(),
            })
        }
        _ => None,
    };

    let problem_dir = args.out.join("problems").join(problem);
    let export_path = problem_dir.join("export.jsonl");
    let meta_path = problem_dir.join("meta.json");
    let existing_etag = if args.force || !export_path.is_file() {
        None
    } else {
        read_existing_etag(&problem_dir)
    };

    let response = match fetch(&url, &protocol_version, existing_etag.as_deref()) {
        Ok(resp) => resp,
        Err(PullFetchError::ProtocolMismatch(mismatch)) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: mismatch.render_stderr(),
            };
        }
        Err(PullFetchError::NotFound) => {
            return CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!(
                    "asimp pull: problem {problem} was not found on {origin} (HTTP 404).\nRun `asimp problems` to list published public problems.\n"
                ),
            };
        }
        Err(PullFetchError::Withheld) => {
            return CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!(
                    "asimp pull: complete archive for {problem} is withheld (HTTP 409 PUBLIC_EXPORT_CONTENT_WITHHELD); no partial archive is served.\nRecover via `asimp watch {problem} --since 0 --once` to read available public event envelopes.\n"
                ),
            };
        }
        Err(PullFetchError::BodyTooLarge { limit_bytes }) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: format!(
                    "asimp pull: export exceeded the {limit_bytes}-byte compressed safety cap; nothing was written.\n"
                ),
            };
        }
        Err(PullFetchError::Status { status }) if matches!(status, 429 | 500..=599) => {
            return failed(
                args,
                1,
                "The public archive is temporarily unavailable. Retry later, or use asimp watch <problem> --once --json for bounded event pages.",
            );
        }
        Err(PullFetchError::Status { status }) => {
            return CliOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!(
                    "asimp pull: export returned HTTP {status}; retry later or inspect `asimp capabilities --json` on {origin}.\n"
                ),
            };
        }
        Err(PullFetchError::RejectedArchive) => {
            return failed(
                args,
                1,
                "The archive download failed its HTTP, encoding, size or timeout checks. Retry the same public read.",
            );
        }
        Err(PullFetchError::Network) => {
            return CliOutput {
                exit_code: 2,
                stdout: String::new(),
                stderr: format!(
                    "asimp pull: network failure fetching {problem} export from {origin}; verify connectivity and retry.\n"
                ),
            };
        }
    };

    let stderr_notice = response
        .deprecation
        .as_ref()
        .map(DeprecationNotice::render_stderr)
        .unwrap_or_default();

    // 304 Not Modified: re-verify the retained local export before reporting clean!
    if response.status == 304 {
        let local_ndjson = match fs::read_to_string(&export_path) {
            Ok(text) => text,
            Err(_) => {
                return CliOutput {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: format!(
                        "{stderr_notice}asimp pull: server returned 304 Not Modified, but local snapshot is unreadable; rerun with --force.\n"
                    ),
                };
            }
        };
        let verified = match verify_export_ndjson(&local_ndjson, pin.as_ref()) {
            Ok(v) if v.problem_id == problem => v,
            Ok(_) => {
                return CliOutput {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: format!(
                        "{stderr_notice}asimp pull: local cached export names another problem; rerun with --force.\n"
                    ),
                };
            }
            Err(err) => {
                let mut out = verify_failure_output(args.json, &err);
                out.stderr = format!("{stderr_notice}{}", out.stderr);
                return out;
            }
        };
        let etag = response.etag.as_deref().or(existing_etag.as_deref());
        let doc = snapshot_json(Some(&origin), &verified, etag, true, Some(&export_path));
        return CliOutput {
            exit_code: 0,
            stdout: if args.json {
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&doc).unwrap_or_default()
                )
            } else {
                render_verified_human(&verified, true, Some(&export_path))
            },
            stderr: stderr_notice,
        };
    }

    let ndjson = match decode_export_bytes(&response.body, false, MAX_BYTES) {
        Ok(s) => s,
        Err(err) => {
            let mut out = verify_failure_output(args.json, &err);
            out.stderr = format!("{stderr_notice}{}", out.stderr);
            return out;
        }
    };
    let verified = match verify_export_ndjson(&ndjson, pin.as_ref()) {
        Ok(v) if v.problem_id == problem => v,
        Ok(_) => {
            let err = ExportVerifyError::at(
                None,
                "downloaded export header names a different problem than requested",
            );
            let mut out = verify_failure_output(args.json, &err);
            out.stderr = format!("{stderr_notice}{}", out.stderr);
            return out;
        }
        Err(err) => {
            let mut out = verify_failure_output(args.json, &err);
            out.stderr = format!("{stderr_notice}{}", out.stderr);
            return out;
        }
    };
    if let Some(output) = authenticate_archive(args, &trusted, problem, &ndjson) {
        return output;
    }

    let doc = snapshot_json(
        Some(&origin),
        &verified,
        response.etag.as_deref(),
        false,
        Some(&export_path),
    );
    let meta_bytes = format!(
        "{}\n",
        serde_json::to_string_pretty(&doc).unwrap_or_default()
    );
    if let Some(output) = &args.output
        && let Err(error) = save(output, &response.body)
    {
        return failed(args, 1, error);
    }
    if let Err(msg) = write_file_atomic(&export_path, ndjson.as_bytes())
        .and_then(|()| write_file_atomic(&meta_path, meta_bytes.as_bytes()))
    {
        return CliOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: format!("{stderr_notice}asimp pull: {msg}\n"),
        };
    }

    CliOutput {
        exit_code: 0,
        stdout: if args.json {
            meta_bytes
        } else {
            render_verified_human(&verified, false, Some(&export_path))
        },
        stderr: stderr_notice,
    }
}

fn verify_failure_output(json_mode: bool, err: &ExportVerifyError) -> CliOutput {
    if json_mode {
        let doc = json!({
            "schema": "asimp.pull.v1",
            "format": "asimp.pull.v1",
            "ok": false,
            "broken_at_seq": err.broken_at_seq,
            "detail": err.detail,
        });
        CliOutput {
            exit_code: 1,
            stdout: format!(
                "{}\n",
                serde_json::to_string_pretty(&doc).unwrap_or_default()
            ),
            stderr: String::new(),
        }
    } else {
        let at = err
            .broken_at_seq
            .map(|s| format!(" (at seq {s})"))
            .unwrap_or_default();
        CliOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: format!(
                "asimp pull: export integrity verification FAILED{at}: {}\nNothing was written; do not trust an unverified archive.\n",
                err.detail
            ),
        }
    }
}

struct Archive {
    bytes: Vec<u8>,
    format: String,
}

fn download(url: &str) -> Result<Archive, FetchError> {
    let agent = crate::agent();
    let url = url.to_owned();
    crate::run_with_deadline(READ_TIMEOUT, move || {
        let response = agent
            .get(&url)
            .set("accept", "application/gzip")
            .set("accept-encoding", "identity")
            .call()
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => FetchError::Status(code),
                _ => FetchError::Network,
            })?;
        read_response(response)
    })
}

fn read_response(response: ureq::Response) -> Result<Archive, FetchError> {
    if response.status() != 200 {
        return Err(FetchError::Status(response.status()));
    }
    let format = response
        .header("x-asimposium-export-format")
        .unwrap_or("")
        .to_owned();
    let content_type = response
        .header("content-type")
        .map(|value| value.split(';').next().unwrap_or("").trim());
    if !matches!(format.as_str(), V4 | V5)
        || content_type != Some("application/gzip")
        || response
            .header("content-encoding")
            .is_some_and(|value| value != "identity")
    {
        return Err(FetchError::InvalidUtf8);
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_GZIP_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FetchError::Network)?;
    if bytes.len() as u64 > MAX_GZIP_BYTES {
        return Err(FetchError::BodyTooLarge {
            limit_bytes: MAX_GZIP_BYTES,
        });
    }
    Ok(Archive { bytes, format })
}

fn unpack(bytes: &[u8]) -> Result<String, &'static str> {
    if bytes.len() as u64 > MAX_GZIP_BYTES {
        return Err(INVALID);
    }
    let mut decoder = BufReadGzDecoder::new(bytes);
    let mut decoded = Vec::new();
    decoder
        .by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut decoded)
        .map_err(|_| INVALID)?;
    // Reading to EOF checks CRC and length. The single-member decoder also
    // lets us refuse concatenated members or trailing bytes.
    if decoded.len() as u64 > MAX_BYTES || !decoder.into_inner().is_empty() {
        return Err(INVALID);
    }
    String::from_utf8(decoded).map_err(|_| INVALID)
}

fn sha256(bytes: &[u8]) -> String {
    digest::digest(&digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn json_digest(value: &Value) -> Result<String, &'static str> {
    Ok(sha256(
        canonical_json(value).map_err(|_| INVALID)?.as_bytes(),
    ))
}

fn exact_keys(value: &Value, names: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == names.len() && names.iter().all(|key| object.contains_key(*key))
    })
}

fn problem_id(value: &str) -> bool {
    value.strip_prefix("P-").is_some_and(|suffix| {
        (2..=31).contains(&suffix.len())
            && !suffix.contains("--")
            && suffix.as_bytes()[0].is_ascii_alphanumeric()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

fn text(value: &Value, maximum: usize) -> bool {
    value.as_str().is_some_and(|value| {
        value.encode_utf16().count() <= maximum
            && !value.trim_matches(crate::ecmascript_whitespace).is_empty()
    })
}

fn hex(value: &Value, length: usize) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number >= 0.0 && number <= 9_007_199_254_740_991.0 && number.fract() == 0.0)
        .then_some(number as u64)
}

fn timestamp(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let bytes = value.as_bytes();
    if !(bytes.len() == 20 || (22..=24).contains(&bytes.len()))
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[bytes.len() - 1] != b'Z'
        || (bytes.len() != 20
            && (bytes[19] != b'.' || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)))
    {
        return false;
    }
    let parts: Option<Vec<u32>> = [(0, 4), (5, 7), (8, 10), (11, 13), (14, 16), (17, 19)]
        .into_iter()
        .map(|(start, end)| {
            std::str::from_utf8(&bytes[start..end])
                .ok()
                .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))?
                .parse()
                .ok()
        })
        .collect();
    let Some(parts) = parts else {
        return false;
    };
    let [year, month, day, hour, minute, second] = parts[..] else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

fn decode_hex(value: &str) -> Vec<u8> {
    // Callers first validate the exact lowercase hexadecimal field shape.
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| {
                if byte <= b'9' {
                    byte - b'0'
                } else {
                    byte - b'a' + 10
                }
            };
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect()
}

fn schema_validator(schema: &Value) -> Result<jsonschema::Validator, &'static str> {
    jsonschema::options()
        .offline()
        .should_validate_formats(true)
        .should_ignore_unknown_formats(false)
        .build(schema)
        .map_err(|_| "Bundled export contracts are unavailable. Rebuild asimp from the repository.")
}

fn trusted_keys(path: Option<&Path>) -> Result<BTreeMap<String, String>, &'static str> {
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let value: Value = serde_json::from_str(&crate::read_request_file(path)?)
        .map_err(|_| "Verification keys must be a JSON array of key_id and public_key objects.")?;
    let keys = value
        .as_array()
        .filter(|keys| !keys.is_empty() && keys.len() <= 16)
        .ok_or("Supply between one and sixteen independently obtained verification keys.")?;
    let mut result = BTreeMap::new();
    for key in keys {
        if !exact_keys(key, &["key_id", "public_key"])
            || !key["key_id"].as_str().is_some_and(|id| {
                (1..=64).contains(&id.len())
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            })
            || !hex(&key["public_key"], 64)
        {
            return Err(
                "Verification keys require ASCII key_id values and lowercase 64-digit public_key hex values.",
            );
        }
        if result
            .insert(
                key["key_id"].as_str().unwrap().to_owned(),
                key["public_key"].as_str().unwrap().to_owned(),
            )
            .is_some()
        {
            return Err("Verification key_id values must be unique.");
        }
    }
    Ok(result)
}

fn verify(
    problem: &str,
    ndjson: &str,
    trusted: &BTreeMap<String, String>,
) -> Result<Value, &'static str> {
    if ndjson.len() as u64 > MAX_BYTES || !ndjson.ends_with('\n') || ndjson.contains('\r') {
        return Err(INVALID);
    }
    let lines: Vec<&str> = ndjson[..ndjson.len() - 1].split('\n').collect();
    if !(3..=MAX_EVENTS + 3).contains(&lines.len()) || lines.iter().any(|line| line.is_empty()) {
        return Err(INVALID);
    }
    let record = |line: &str| serde_json::from_str::<Value>(line).map_err(|_| INVALID);
    let header = record(lines[0])?;
    let mut context = record(lines[1])?;
    let trailer = record(lines[lines.len() - 1])?;
    let count = lines.len() - 3;
    let format = header["format"].as_str().ok_or(INVALID)?;
    let mut header_keys = vec![
        "control",
        "format",
        "license",
        "problem",
        "title",
        "generated_at",
        "checkpoints",
        "publication_context_sha256",
    ];
    if format == V5 {
        header_keys.push("checkpoint_signatures");
    }
    if !matches!(format, V4 | V5)
        || !exact_keys(&header, &header_keys)
        || header["control"] != "export_header"
        || header["license"] != "CC BY 4.0"
        || header["problem"] != problem
        || !problem_id(problem)
        || !text(&header["title"], 160)
        || !timestamp(&header["generated_at"])
        || !exact_keys(
            &trailer,
            &["control", "event_count", "final_cursor", "problem"],
        )
        || trailer["control"] != "export_end"
        || trailer["problem"] != problem
        || safe_integer(&trailer["event_count"]) != Some(count as u64)
        || safe_integer(&trailer["final_cursor"]) != Some(count as u64)
    {
        return Err(INVALID);
    }

    let screening: Value = serde_json::from_str(include_str!(
        "../../packages/contracts/generated/screening.schema.json"
    ))
    .map_err(|_| INVALID)?;
    let context_schema = screening["anyOf"]
        .as_array()
        .and_then(|schemas| {
            schemas
                .iter()
                .find(|schema| schema["properties"]["control"]["const"] == "publication_context")
        })
        .ok_or(INVALID)?;
    if !schema_validator(context_schema)?.is_valid(&context)
        || context["problem"] != problem
        || safe_integer(&context["through"]) != Some(count as u64)
        || context["context_sha256"] != header["publication_context_sha256"]
    {
        return Err(INVALID);
    }
    let context_hash = context
        .as_object_mut()
        .ok_or(INVALID)?
        .remove("context_sha256")
        .ok_or(INVALID)?;
    let canonical_context = canonical_json(&context).map_err(|_| INVALID)?;
    if context_hash
        != sha256(format!("asimposium.publication-context.v1\n{canonical_context}").as_bytes())
    {
        return Err(INVALID);
    }

    let checkpoints = header["checkpoints"]
        .as_array()
        .filter(|items| items.len() <= count)
        .ok_or(INVALID)?;
    let mut checkpoint_by_seq = BTreeMap::new();
    let mut previous_checkpoint = 0;
    for checkpoint in checkpoints {
        let seq = safe_integer(&checkpoint["checkpoint_seq"]).ok_or(INVALID)?;
        if !exact_keys(
            checkpoint,
            &[
                "checkpoint_seq",
                "root_chain_digest",
                "checkpoint_digest",
                "checkpoint_version",
                "chain_version",
                "checkpoint_mode",
                "problem",
            ],
        ) || checkpoint["problem"] != problem
            || safe_integer(&checkpoint["chain_version"]) != Some(2)
            || safe_integer(&checkpoint["checkpoint_version"]) != Some(1)
            || checkpoint["checkpoint_mode"] != "unsigned-v0"
            || seq <= previous_checkpoint
            || seq > count as u64
            || !hex(&checkpoint["root_chain_digest"], 64)
            || !hex(&checkpoint["checkpoint_digest"], 64)
        {
            return Err(INVALID);
        }
        checkpoint_by_seq.insert(seq, checkpoint);
        previous_checkpoint = seq;
    }
    let mut chain = json_digest(&json!({
        "chain_version": 2, "kind": "krater.genesis", "problem_id": problem,
    }))?;
    let mut event_ids = BTreeSet::new();
    let mut events = Vec::with_capacity(count);
    for (index, line) in lines[2..lines.len() - 1].iter().enumerate() {
        let event = record(line)?;
        let seq = index as u64 + 1;
        if !exact_keys(
            &event,
            &[
                "actor_fellow_id",
                "actor_session_id",
                "actor_sponsor_id",
                "chain_digest",
                "chain_version",
                "created_at",
                "event_id",
                "harness",
                "model_string_self_declared",
                "object_id",
                "object_kind",
                "object_version",
                "payload_json",
                "payload_sha256",
                "row_digest",
                "seq",
                "type",
                "writer_credential_id",
            ],
        ) || safe_integer(&event["seq"]) != Some(seq)
            || safe_integer(&event["chain_version"]) != Some(2)
            || !safe_integer(&event["object_version"]).is_some_and(|version| version > 0)
            || !["event_id", "type", "object_kind", "object_id"]
                .iter()
                .all(|key| text(&event[*key], 160))
            || ![
                "actor_fellow_id",
                "actor_session_id",
                "actor_sponsor_id",
                "model_string_self_declared",
                "harness",
                "writer_credential_id",
            ]
            .iter()
            .all(|key| event[*key].is_null() || text(&event[*key], 160))
            || !["payload_sha256", "row_digest", "chain_digest"]
                .iter()
                .all(|key| hex(&event[*key], 64))
            || !text(&event["payload_json"], 512 * 1024)
            || !timestamp(&event["created_at"])
            || !event_ids.insert(event["event_id"].as_str().ok_or(INVALID)?.to_owned())
        {
            return Err(INVALID);
        }
        let payload = event["payload_json"].as_str().ok_or(INVALID)?;
        if payload.len() > 512 * 1024 || sha256(payload.as_bytes()) != event["payload_sha256"] {
            return Err(INVALID);
        }
        let mut envelope = event.as_object().ok_or(INVALID)?.clone();
        for key in ["chain_digest", "row_digest", "payload_json"] {
            envelope.remove(key);
        }
        envelope.insert("problem_id".into(), json!(problem));
        if json_digest(&Value::Object(envelope))? != event["row_digest"] {
            return Err(INVALID);
        }
        chain = json_digest(&json!({
            "chain_version": 2, "problem_id": problem, "seq": seq,
            "payload_sha256": event["payload_sha256"],
            "row_digest": event["row_digest"], "previous_chain_digest": chain,
        }))?;
        if chain != event["chain_digest"] {
            return Err(INVALID);
        }
        if let Some(checkpoint) = checkpoint_by_seq.get(&seq) {
            if checkpoint["root_chain_digest"] != chain
                || checkpoint["checkpoint_digest"]
                    != json_digest(&json!({
                        "chain_version": 2, "checkpoint_version": 1, "problem_id": problem,
                        "seq": seq, "root_chain_digest": chain,
                    }))?
            {
                return Err(INVALID);
            }
        }
        events.push((event["event_id"].clone(), event["payload_sha256"].clone()));
    }
    let notices = context["notices"].as_array().ok_or(INVALID)?;
    let mut prior_notice = 0;
    for notice in notices {
        let seq = safe_integer(&notice["seq"]).ok_or(INVALID)?;
        if seq <= prior_notice || seq > count as u64 {
            return Err(INVALID);
        }
        let source = &events[seq as usize - 1];
        if notice["event_id"] != source.0 || notice["payload_sha256"] != source.1 {
            return Err(INVALID);
        }
        prior_notice = seq;
    }

    let mut signed_through = 0;
    let mut trusted_through = 0;
    let mut signatures_count = 0;
    if format == V5 {
        let bundle = &header["checkpoint_signatures"];
        let ledger: Value = serde_json::from_str(include_str!(
            "../../packages/contracts/generated/ledger.schema.json"
        ))
        .map_err(|_| INVALID)?;
        if !schema_validator(&ledger["properties"]["export_checkpoint_bundle"])?.is_valid(bundle)
            || bundle["problem_id"] != problem
            || safe_integer(&bundle["through"]) != Some(count as u64)
        {
            return Err(INVALID);
        }
        let mut keys = BTreeMap::new();
        let mut last_key = "";
        for key in bundle["keys"].as_array().ok_or(INVALID)? {
            let id = key["key_id"].as_str().ok_or(INVALID)?;
            if id.encode_utf16().cmp(last_key.encode_utf16()).is_le()
                || id.encode_utf16().count() > 64
            {
                return Err(INVALID);
            }
            keys.insert(id, key["public_key"].as_str().ok_or(INVALID)?);
            last_key = id;
        }
        let mut signers = BTreeSet::new();
        let mut last_seq = 0;
        let mut last_signer = "";
        for signed in bundle["signatures"].as_array().ok_or(INVALID)? {
            let seq = safe_integer(&signed["checkpoint_seq"]).ok_or(INVALID)?;
            let id = signed["key_id"].as_str().ok_or(INVALID)?;
            let key = keys.get(id).ok_or(INVALID)?;
            let checkpoint = checkpoint_by_seq.get(&seq).ok_or(INVALID)?;
            if seq < last_seq
                || (seq == last_seq && id.encode_utf16().cmp(last_signer.encode_utf16()).is_le())
                || !signers.insert(id)
                || signed["root_chain_digest"] != checkpoint["root_chain_digest"]
                || signed["checkpoint_digest"] != checkpoint["checkpoint_digest"]
            {
                return Err(INVALID);
            }
            let message = format!(
                "asimposium.checkpoint.v1\n{problem}\n{seq}\n{}\n{}",
                signed["root_chain_digest"].as_str().ok_or(INVALID)?,
                signed["checkpoint_digest"].as_str().ok_or(INVALID)?,
            );
            signature::UnparsedPublicKey::new(&signature::ED25519, decode_hex(key))
                .verify(
                    message.as_bytes(),
                    &decode_hex(signed["signature"].as_str().ok_or(INVALID)?),
                )
                .map_err(|_| INVALID)?;
            signatures_count += 1;
            signed_through = signed_through.max(seq);
            if trusted
                .get(id)
                .is_some_and(|pinned| pinned.as_str() == *key)
            {
                trusted_through = trusted_through.max(seq);
            }
            last_seq = seq;
            last_signer = id;
        }
    }
    Ok(json!({
        "export_format": format, "problem": problem, "event_count": count, "cursor": count,
        "final_chain_digest": chain, "chain_linkage_valid": true, "payload_commitment_recomputed": true,
        "checkpoint_signature_count": signatures_count, "signed_through": signed_through, "trusted_through": trusted_through,
        "signature_coverage": if signed_through == 0 { "none" } else if signed_through == count as u64 { "complete" } else { "prefix" },
        "authenticated": count > 0 && trusted_through == count as u64,
        "authentication_scope": "original-event-chain-only", "key_trust": "independently-pinned-keys-required",
        "publication_context_sha256": context_hash, "publication_notice_count": notices.len(),
        "publication_context_assurance": "export-self-consistency-only",
    }))
}

fn save(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut nonce = [0u8; 16];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "Cannot create a unique temporary snapshot file.")?;
    let temporary = parent.join(format!(".asimp-pull-{}.partial", sha256(&nonce)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(
        |_| "Cannot create the snapshot file. Choose an existing writable directory with --output.",
    )?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        // Creating a hard link publishes complete bytes atomically and refuses
        // an existing destination, including a symlink, on supported filesystems.
        fs::hard_link(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok::<(), std::io::Error>(())
    })();
    drop(file);
    let _ = fs::remove_file(&temporary);
    result.map_err(|_| {
        "Cannot save the complete snapshot. The destination may already exist or lack disk space. Choose a new --output file and retry."
    })
}

fn failed(args: &PullArgs, code: i32, message: &str) -> CliOutput {
    if args.json {
        CliOutput {
            exit_code: code,
            stdout: format!(
                "{}\n",
                json!({"format": "asimp.pull.v1", "ok": false, "message": message})
            ),
            stderr: String::new(),
        }
    } else {
        CliOutput {
            exit_code: code,
            stdout: String::new(),
            stderr: format!("asimp pull: {message}\n"),
        }
    }
}


fn authenticate_archive(
    args: &PullArgs,
    trusted: &BTreeMap<String, String>,
    problem: &str,
    ndjson: &str,
) -> Option<CliOutput> {
    // Default and --verify-file paths keep export self-consistency. Schema and
    // Ed25519 checks run only when independently pinned keys are supplied.
    if trusted.is_empty() && !args.require_authenticated {
        return None;
    }
    let receipt = match verify(problem, ndjson, trusted) {
        Ok(receipt) => receipt,
        Err(error) => return Some(failed(args, 1, error)),
    };
    if args.require_authenticated && receipt["authenticated"] != true {
        return Some(failed(
            args,
            1,
            "No independently pinned signature covers the complete event chain. Obtain the current operator verification keys independently, or retry after a signed checkpoint covers the current cursor.",
        ));
    }
    None
}

fn run_with_download(
    cli: &Cli,
    args: &PullArgs,
    fetch: impl FnOnce(&str) -> Result<Archive, FetchError>,
) -> CliOutput {
    let Some(problem) = args.problem.as_deref().filter(|id| problem_id(id)) else {
        return failed(args, 2, "Supply a public problem ID such as P-4DSP.");
    };
    let url = match crate::resolve_origin(cli.origin.as_ref()).and_then(|origin| {
        crate::build_url(&origin, &format!("/p/{problem}/export.jsonl.gz"))
    }) {
        Ok(url) => url,
        Err(_) => {
            return failed(
                args,
                2,
                "Choose a valid HTTPS --origin before downloading a public archive.",
            );
        }
    };
    let trusted = match trusted_keys(args.trusted_keys.as_deref()) {
        Ok(keys) => keys,
        Err(error) => return failed(args, 2, error),
    };
    let archive = match fetch(&url) {
        Ok(archive) => archive,
        Err(FetchError::Status(409)) => {
            return failed(
                args,
                1,
                "The complete public archive is withheld. Use asimp watch <problem> --once --json to read event envelopes and follow available public object links.",
            );
        }
        Err(FetchError::Status(404)) => {
            return failed(
                args,
                1,
                "This public archive is unavailable. Check the problem ID and this origin's capabilities before retrying.",
            );
        }
        Err(FetchError::Status(429 | 500..=599)) => {
            return failed(
                args,
                1,
                "The public archive is temporarily unavailable. Retry later, or use asimp watch <problem> --once --json for bounded event pages.",
            );
        }
        Err(_) => {
            return failed(
                args,
                1,
                "The archive download failed its HTTP, encoding, size or timeout checks. Retry the same public read.",
            );
        }
    };
    let decoded = match unpack(&archive.bytes) {
        Ok(value) => value,
        Err(error) => return failed(args, 1, error),
    };
    let mut receipt = match verify(problem, &decoded, &trusted) {
        Ok(value) => value,
        Err(error) => return failed(args, 1, error),
    };
    if receipt["export_format"] != archive.format {
        return failed(args, 1, INVALID);
    }
    if args.require_authenticated && receipt["authenticated"] != true {
        return failed(
            args,
            1,
            "No independently pinned signature covers the complete event chain. Obtain the current operator verification keys independently, or retry after a signed checkpoint covers the current cursor.",
        );
    }
    let archive_digest = sha256(&archive.bytes);
    let output = match &args.output {
        Some(path) => path.clone(),
        None => {
            if fs::create_dir_all(".asimp").is_err() {
                return failed(
                    args,
                    2,
                    "Cannot create .asimp. Choose an existing writable directory with --output.",
                );
            }
            PathBuf::from(".asimp").join(format!("{problem}-{archive_digest}.jsonl.gz"))
        }
    };
    if let Err(error) = save(&output, &archive.bytes) {
        return failed(args, 1, error);
    }
    receipt["format"] = json!("asimp.pull.v1");
    receipt["ok"] = json!(true);
    receipt["archive_sha256"] = json!(archive_digest);
    receipt["file"] = json!(output);
    receipt["download_bytes"] = json!(archive.bytes.len());
    let stdout = if args.json {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&receipt).expect("pull receipt")
        )
    } else {
        format!(
            "Saved {} events through cursor {} to {}.\nCheckpoint signature coverage is {}. Independently trusted through cursor {}.\nPublication context integrity is export self-consistency.\n",
            receipt["event_count"],
            receipt["cursor"],
            output.display(),
            receipt["signature_coverage"].as_str().unwrap(),
            receipt["trusted_through"],
        )
    };
    CliOutput {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn build_valid_v5_export(problem: &str) -> String {
        let payload_json =
            r#"{"kind":"claim","statement":"Every even integer > 2 is a sum of two primes."}"#;
        let payload_sha256 = sha256_hex(payload_json.as_bytes());
        let genesis = genesis_chain_digest(problem).unwrap();
        let row_digest = event_envelope_row_digest(
            problem,
            "EV-0001",
            1,
            "claim.created",
            "claim",
            "C-1",
            1,
            &payload_sha256,
            "2026-09-09T10:00:00.000Z",
            Some("F-1"),
            Some("usr_1"),
            Some("S-1"),
            Some("claude-opus-4-6"),
            Some("claude-code"),
            Some("cred_1"),
        )
        .unwrap();
        let chain_digest =
            event_chain_digest(problem, 1, &payload_sha256, &row_digest, &genesis).unwrap();
        let cp_digest = checkpoint_digest(problem, 1, &chain_digest).unwrap();

        let mut ctx_map = Map::new();
        ctx_map.insert("control".into(), json!("publication_context"));
        ctx_map.insert("format".into(), json!("asimposium.publication-context.v1"));
        ctx_map.insert("problem".into(), json!(problem));
        ctx_map.insert("through".into(), json!(1));
        ctx_map.insert("assurance".into(), json!("export-self-consistency-only"));
        ctx_map.insert("notices".into(), json!([]));
        let ctx_sha = publication_context_digest(&ctx_map).unwrap();
        ctx_map.insert("context_sha256".into(), json!(ctx_sha));

        let header = json!({
            "control": "export_header",
            "format": PUBLIC_EXPORT_FORMAT,
            "license": EXPORT_LICENSE,
            "problem": problem,
            "title": "Sample Problem",
            "generated_at": "2026-09-09T10:01:00.000Z",
            "checkpoints": [{
                "checkpoint_seq": 1,
                "root_chain_digest": chain_digest,
                "checkpoint_digest": cp_digest,
                "checkpoint_version": 1,
                "chain_version": KRATER_CHAIN_VERSION,
                "checkpoint_mode": "unsigned-v0",
                "problem": problem,
            }],
            "publication_context_sha256": ctx_sha,
            "checkpoint_signatures": {
                "format": "asimposium.export-checkpoints.v1",
                "problem_id": problem,
                "through": 1,
                "message_format": "asimposium.checkpoint-signature.v1",
                "selection": "latest-per-configured-key",
                "signed_material": "original-event-chain-only",
                "key_trust": "independently-pinned-keys-required",
                "keys": [],
                "signatures": []
            }
        });
        let event = json!({
            "event_id": "EV-0001",
            "seq": 1,
            "type": "claim.created",
            "object_kind": "claim",
            "object_id": "C-1",
            "object_version": 1,
            "payload_sha256": payload_sha256,
            "row_digest": row_digest,
            "chain_digest": chain_digest,
            "chain_version": KRATER_CHAIN_VERSION,
            "created_at": "2026-09-09T10:00:00.000Z",
            "actor_fellow_id": "F-1",
            "actor_sponsor_id": "usr_1",
            "actor_session_id": "S-1",
            "model_string_self_declared": "claude-opus-4-6",
            "harness": "claude-code",
            "writer_credential_id": "cred_1",
            "payload_json": payload_json,
        });
        let trailer = json!({
            "control": "export_end",
            "problem": problem,
            "event_count": 1,
            "final_cursor": 1,
        });
        format!(
            "{}\n{}\n{}\n{}\n",
            serde_json::to_string(&header).unwrap(),
            serde_json::to_string(&Value::Object(ctx_map)).unwrap(),
            serde_json::to_string(&event).unwrap(),
            serde_json::to_string(&trailer).unwrap(),
        )
    }

    fn gzip_bytes(text: &str) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(text.as_bytes()).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn verifies_valid_v5_export_and_detects_tampering() {
        let ndjson = build_valid_v5_export("P-4DSP");
        let verified = verify_export_ndjson(&ndjson, None).expect("valid v5 export");
        assert_eq!(verified.problem_id, "P-4DSP");
        assert_eq!(verified.event_count, 1);
        assert_eq!(verified.final_cursor, 1);
        assert_eq!(verified.checkpoint_count, 1);
        assert_eq!(verified.assurance, "export-self-consistency-only");

        // External pin match succeeds; wrong pin fails.
        let good_pin = CheckpointPin {
            problem_id: "P-4DSP".into(),
            checkpoint_seq: 1,
            root_chain_digest: verified.final_chain_digest.clone(),
        };
        assert!(verify_export_ndjson(&ndjson, Some(&good_pin)).is_ok());
        let bad_pin = CheckpointPin {
            problem_id: "P-4DSP".into(),
            checkpoint_seq: 1,
            root_chain_digest: "0".repeat(64),
        };
        assert_eq!(
            verify_export_ndjson(&ndjson, Some(&bad_pin))
                .unwrap_err()
                .broken_at_seq,
            Some(1)
        );

        // Tampered payload bytes fail at seq 1.
        let tampered_payload = ndjson.replace("two primes", "three primes");
        assert_eq!(
            verify_export_ndjson(&tampered_payload, None)
                .unwrap_err()
                .broken_at_seq,
            Some(1)
        );

        // Missing trailer fails.
        let truncated = ndjson.rsplit_once('\n').unwrap().0;
        let truncated = truncated.rsplit_once('\n').unwrap().0;
        let truncated = format!("{truncated}\n");
        assert!(verify_export_ndjson(&truncated, None).is_err());
    }

    #[test]
    fn pull_writes_verified_snapshot_and_honors_etag_304_and_refuses_traversal() {
        let base = std::env::temp_dir().join(format!("asimp-pull-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let ndjson = build_valid_v5_export("P-4DSP");
        let gz = gzip_bytes(&ndjson);

        // 1. Fresh pull writes export.jsonl + meta.json
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "pull",
            "P-4DSP",
            "--out",
            base.to_str().unwrap(),
            "--json",
        ])
        .unwrap();
        let out = run_with_fetch(&cli, |url, proto, inm| {
            assert_eq!(url, "https://example.test/p/P-4DSP/export.jsonl.gz");
            assert_eq!(proto, "0.2.0-draft");
            assert!(inm.is_none());
            Ok(PullResponse {
                status: 200,
                etag: Some("\"export-gzip-abc\"".into()),
                body: gz.clone(),
                deprecation: None,
            })
        });
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let meta: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(meta["ok"], true);
        assert_eq!(meta["not_modified"], false);
        assert_eq!(meta["etag"], "\"export-gzip-abc\"");
        assert!(base.join("problems/P-4DSP/export.jsonl").is_file());

        // 2. Second pull sends saved ETag and handles 304 Not Modified cleanly.
        let out_304 = run_with_fetch(&cli, |_, _, inm| {
            assert_eq!(inm, Some("\"export-gzip-abc\""));
            Ok(PullResponse {
                status: 304,
                etag: Some("\"export-gzip-abc\"".into()),
                body: Vec::new(),
                deprecation: None,
            })
        });
        assert_eq!(out_304.exit_code, 0);
        let meta_304: Value = serde_json::from_str(&out_304.stdout).unwrap();
        assert_eq!(meta_304["not_modified"], true);

        // 3. Path traversal in problem ID or --out is refused before network.
        for bad in [
            vec!["asimp", "pull", "../etc/passwd"],
            vec!["asimp", "pull", "P-4DSP", "--out", "../escape"],
        ] {
            let bad_cli = Cli::try_parse_from(bad).unwrap();
            let bad_out = run_with_fetch(&bad_cli, |_, _, _| panic!("must not hit network"));
            assert_eq!(bad_out.exit_code, 2);
        }

        // 4. Gzip bomb cap stops oversized decompressed streams cleanly.
        let huge = "a".repeat(2048);
        let huge_gz = gzip_bytes(&huge);
        assert!(decode_export_bytes(&huge_gz, false, 1024).is_err());

        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
#[path = "pull_tests.rs"]
mod pull_archive_tests;
