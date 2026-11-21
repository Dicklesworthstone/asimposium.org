//! Offline contract validator with Worker parity (W11.3, asimposiumorg-psl).
//!
//! Consumes the generated JSON Schemas from `@asimposium/contracts` directly
//! (no second hand-written schema) plus the Worker's mechanical claim rules
//! (P2/P4 authoritative-field refusal, P3 conjecture-class falsifier check,
//! A5 canonical field hints, and optional P7 credential scrubbing). All remote
//! `$ref` retrieval is disabled; validation runs offline and deterministically.

use crate::{
    Cli, CliOutput, Command, FetchError, Fetched, MAX_BODY_BYTES, canonical_json::canonical_json,
    input_error, read_capped_at, resolve_origin, scrub,
};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

/// Same 512 KiB bound the Worker applies to session/ledger JSON requests.
pub const MAX_VALIDATE_BYTES: u64 = 512 * 1024;
const MAX_SCHEMA_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, clap::Args)]
pub struct ValidateArgs {
    /// Regular UTF-8 JSON file to validate (up to 512 KiB); omit with --stdin or --list-schemas.
    #[arg(
        required_unless_present_any = ["stdin", "list_schemas"],
        conflicts_with_all = ["stdin", "list_schemas"],
        value_name = "JSON_FILE"
    )]
    pub file: Option<PathBuf>,

    /// Read UTF-8 JSON to validate from stdin (up to 512 KiB).
    #[arg(long, conflicts_with = "list_schemas")]
    pub stdin: bool,

    /// Contract target: a write alias (e.g. `promote`, `review`, `evidence`, `workshop`),
    /// a bundled schema (`<id>`), or a slice (`<id>/<slice>` such as `sessions/promote_request`).
    #[arg(
        long,
        short = 'k',
        conflicts_with_all = ["schema_file", "list_schemas"],
        value_name = "KIND_OR_SCHEMA"
    )]
    pub kind: Option<String>,

    /// Validate against a downloaded JSON Schema file on disk (offline or fetched from /schemas/).
    #[arg(
        long,
        conflicts_with_all = ["kind", "list_schemas"],
        value_name = "SCHEMA_JSON"
    )]
    pub schema_file: Option<PathBuf>,

    /// Optional property/top-level slice inside --schema-file (e.g. `promote_request`).
    #[arg(long, requires = "schema_file", value_name = "SLICE")]
    pub slice: Option<String>,

    /// Also run the P7 credential scan on the request before accepting it.
    #[arg(long, conflicts_with = "list_schemas")]
    pub scrub: bool,

    /// Check the running origin's `/schemas/index.json` for schema byte-size drift (read-only).
    #[arg(long, conflicts_with_all = ["schema_file", "list_schemas"])]
    pub check_origin: bool,

    /// List all bundled contract schemas, slices, and kind aliases, then exit.
    #[arg(long)]
    pub list_schemas: bool,

    /// Emit deterministic structured JSON output (never echoes input bytes or rejected keys).
    #[arg(long)]
    pub json: bool,
}

struct BundledSchema {
    id: &'static str,
    raw: &'static str,
}

const BUNDLED_SCHEMAS: &[BundledSchema] = &[
    BundledSchema {
        id: "batch",
        raw: include_str!("../../packages/contracts/generated/batch.schema.json"),
    },
    BundledSchema {
        id: "citations",
        raw: include_str!("../../packages/contracts/generated/citations.schema.json"),
    },
    BundledSchema {
        id: "conflicts",
        raw: include_str!("../../packages/contracts/generated/conflicts.schema.json"),
    },
    BundledSchema {
        id: "contracts-scaffold",
        raw: include_str!("../../packages/contracts/generated/contracts-scaffold.schema.json"),
    },
    BundledSchema {
        id: "dead-ends",
        raw: include_str!("../../packages/contracts/generated/dead-ends.schema.json"),
    },
    BundledSchema {
        id: "directives",
        raw: include_str!("../../packages/contracts/generated/directives.schema.json"),
    },
    BundledSchema {
        id: "discovery",
        raw: include_str!("../../packages/contracts/generated/discovery.schema.json"),
    },
    BundledSchema {
        id: "enrollment",
        raw: include_str!("../../packages/contracts/generated/enrollment.schema.json"),
    },
    BundledSchema {
        id: "enrollment-capsule",
        raw: include_str!("../../packages/contracts/generated/enrollment-capsule.schema.json"),
    },
    BundledSchema {
        id: "event-tail",
        raw: include_str!("../../packages/contracts/generated/event-tail.schema.json"),
    },
    BundledSchema {
        id: "inbox",
        raw: include_str!("../../packages/contracts/generated/inbox.schema.json"),
    },
    BundledSchema {
        id: "internal-health",
        raw: include_str!("../../packages/contracts/generated/internal-health.schema.json"),
    },
    BundledSchema {
        id: "ledger",
        raw: include_str!("../../packages/contracts/generated/ledger.schema.json"),
    },
    BundledSchema {
        id: "lifecycle-transfer",
        raw: include_str!("../../packages/contracts/generated/lifecycle-transfer.schema.json"),
    },
    BundledSchema {
        id: "moves",
        raw: include_str!("../../packages/contracts/generated/moves.schema.json"),
    },
    BundledSchema {
        id: "problem",
        raw: include_str!("../../packages/contracts/generated/problem.schema.json"),
    },
    BundledSchema {
        id: "problems",
        raw: include_str!("../../packages/contracts/generated/problems.schema.json"),
    },
    BundledSchema {
        id: "questions",
        raw: include_str!("../../packages/contracts/generated/questions.schema.json"),
    },
    BundledSchema {
        id: "readiness",
        raw: include_str!("../../packages/contracts/generated/readiness.schema.json"),
    },
    BundledSchema {
        id: "retractions",
        raw: include_str!("../../packages/contracts/generated/retractions.schema.json"),
    },
    BundledSchema {
        id: "review-queue",
        raw: include_str!("../../packages/contracts/generated/review-queue.schema.json"),
    },
    BundledSchema {
        id: "rubrics",
        raw: include_str!("../../packages/contracts/generated/rubrics.schema.json"),
    },
    BundledSchema {
        id: "s2-cost-receipt",
        raw: include_str!("../../packages/contracts/generated/s2-cost-receipt.schema.json"),
    },
    BundledSchema {
        id: "screening",
        raw: include_str!("../../packages/contracts/generated/screening.schema.json"),
    },
    BundledSchema {
        id: "sessions",
        raw: include_str!("../../packages/contracts/generated/sessions.schema.json"),
    },
    BundledSchema {
        id: "syntheses",
        raw: include_str!("../../packages/contracts/generated/syntheses.schema.json"),
    },
    BundledSchema {
        id: "workshop-directory",
        raw: include_str!("../../packages/contracts/generated/workshop-directory.schema.json"),
    },
];

/// Friendly write-kind aliases mapped onto canonical bundled `<schema>/<slice>` targets.
const KIND_ALIASES: &[(&str, &str, &str)] = &[
    ("promote", "sessions", "promote_request"),
    ("revise", "sessions", "revise_request"),
    ("direct-claim", "sessions", "direct_claim_request"),
    ("review", "sessions", "review_request"),
    ("evidence", "sessions", "evidence_request"),
    ("workshop", "sessions", "workshop_push_request"),
    ("session-open", "sessions", "session_open_request"),
    ("session-close", "sessions", "session_close_request"),
    ("session-heartbeat", "sessions", "session_heartbeat_request"),
    ("hypothesis", "sessions", "hypothesis_request"),
    ("hypothesis-kill", "sessions", "hypothesis_kill_request"),
    (
        "hypothesis-lifecycle",
        "sessions",
        "hypothesis_lifecycle_request",
    ),
    ("gap-open", "sessions", "gap_file_request"),
    ("gap-close", "sessions", "gap_transition_request"),
    ("relation", "sessions", "relation_file_request"),
    ("relation-dispute", "sessions", "relation_dispute_request"),
    ("dead-end", "sessions", "record_dead_end_request"),
    ("citation", "sessions", "record_citation_request"),
    ("citation-correct", "sessions", "correct_citation_request"),
    ("question-ask", "sessions", "ask_question_request"),
    ("question-answer", "sessions", "answer_question_request"),
    ("question-withdraw", "sessions", "withdraw_question_request"),
    ("retract", "sessions", "retract_request"),
    ("synthesize", "sessions", "synthesize_request"),
    ("reanchor", "sessions", "reanchor_request"),
    (
        "conflict-normalize",
        "sessions",
        "normalize_conflict_request",
    ),
    ("conflict-resolve", "sessions", "resolve_conflict_request"),
    ("lease-acquire", "sessions", "lease_acquire_request"),
    ("lease-question", "sessions", "lease_question_request"),
    ("lease-release", "sessions", "lease_release_request"),
    ("lease-challenge", "sessions", "lease_challenge_request"),
    ("inbox-ack", "inbox", "ack_request"),
    ("enroll", "enrollment", "fellow_registration_request"),
    ("device-start", "enrollment", "device_code_start_request"),
    ("batch", "batch", "event_batch_request"),
];

const CONJECTURE_CLASS_KINDS: &[&str] = &[
    "conjecture",
    "theorem-attempt",
    "counterexample-claim",
    "bound",
];

const AUTHORITATIVE_FIELDS: &[&str] = &[
    "disposition",
    "proved",
    "isproved",
    "confidence",
    "certificate",
    "certification",
    "verified",
    "isverified",
    "claimstatus",
    "reviewstatus",
];

const STATUS_UPGRADES: &[&str] = &[
    "proved",
    "verified",
    "certified",
    "corroborated",
    "stronglysupported",
    "resolved",
];

const META_SCHEMA_KEYS: &[&str] = &[
    "$id",
    "$schema",
    "$defs",
    "$comment",
    "$ref",
    "definitions",
    "title",
    "description",
    "examples",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "items",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationVerdict {
    pub valid: bool,
    pub schema_id: String,
    pub slice: Option<String>,
    pub code: Option<&'static str>,
    pub rule: Option<&'static str>,
    pub fix_hint: Option<&'static str>,
    pub pointers: Vec<String>,
    pub suggested_fields: Vec<String>,
    pub secret_findings: Vec<scrub::CredentialFinding>,
    pub canonical_sha256: Option<String>,
    pub schema_sha256: String,
}

/// NFKC-compatible ASCII alphanumeric normalization matching `split/policy.ts:81-93`.
fn normalize_control_token(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let mapped = compat_ascii_char(ch);
        if mapped.is_ascii_alphanumeric() {
            out.push(mapped.to_ascii_lowercase());
        }
    }
    out
}

/// Maps common NFKC compatibility ASCII forms (fullwidth Latin/digits and
/// Unicode Mathematical Alphanumeric Symbols) back to their ASCII scalar.
fn compat_ascii_char(ch: char) -> char {
    let cp = ch as u32;
    match cp {
        // Fullwidth ASCII variants (U+FF10..=U+FF19, U+FF21..=U+FF3A, U+FF41..=U+FF5A)
        0xFF10..=0xFF19 => char::from_u32(cp - 0xFF10 + b'0' as u32).unwrap_or(ch),
        0xFF21..=0xFF3A => char::from_u32(cp - 0xFF21 + b'A' as u32).unwrap_or(ch),
        0xFF41..=0xFF5A => char::from_u32(cp - 0xFF41 + b'a' as u32).unwrap_or(ch),
        // Mathematical Bold / Italic / Bold-Italic / Script / Fraktur / Sans / Monospace Latin
        0x1D400..=0x1D6A3 => {
            let offset = (cp - 0x1D400) % 52;
            if offset < 26 {
                char::from_u32(b'A' as u32 + offset).unwrap_or(ch)
            } else {
                char::from_u32(b'a' as u32 + (offset - 26)).unwrap_or(ch)
            }
        }
        // Mathematical digits (U+1D7CE..=U+1D7FF)
        0x1D7CE..=0x1D7FF => {
            let digit = (cp - 0x1D7CE) % 10;
            char::from_u32(b'0' as u32 + digit).unwrap_or(ch)
        }
        _ => ch,
    }
}

/// Exact match to `containsAuthoritativeField` in `apps/wire/src/split/policy.ts:95-117`.
pub fn contains_authoritative_field(value: &Value) -> bool {
    let mut stack = vec![value];
    while let Some(current) = stack.pop() {
        match current {
            Value::Array(items) => {
                for item in items {
                    stack.push(item);
                }
            }
            Value::Object(map) => {
                for (key, nested) in map {
                    let normalized = normalize_control_token(key);
                    if AUTHORITATIVE_FIELDS.contains(&normalized.as_str()) {
                        return true;
                    }
                    if normalized == "status"
                        && let Some(text) = nested.as_str()
                        && STATUS_UPGRADES.contains(&normalize_control_token(text).as_str())
                    {
                        return true;
                    }
                    stack.push(nested);
                }
            }
            _ => {}
        }
    }
    false
}

/// Exact match to `isSingleEdit` in `packages/contracts/src/field-hints.ts:7-20`.
fn is_single_edit(left: &str, right: &str) -> bool {
    let l: Vec<char> = left.chars().collect();
    let r: Vec<char> = right.chars().collect();
    if l.len().abs_diff(r.len()) > 1 {
        return false;
    }
    let mut index = 0;
    while index < l.len() && index < r.len() && l[index] == r[index] {
        index += 1;
    }
    if index == l.len() && index == r.len() {
        return true;
    }
    if l.len() < r.len() {
        return l[index..] == r[index + 1..];
    }
    if l.len() > r.len() {
        return l[index + 1..] == r[index..];
    }
    l[index + 1..] == r[index + 1..]
        || (index + 1 < l.len()
            && l[index] == r[index + 1]
            && l[index + 1] == r[index]
            && l[index + 2..] == r[index + 2..])
}

fn collect_object_property_names(schema: &Value, out: &mut BTreeSet<String>) {
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        for key in props.keys() {
            if is_canonical_field_name(key) {
                out.insert(key.clone());
            }
        }
    }
    for branch_key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = schema.get(branch_key).and_then(Value::as_array) {
            for branch in branches {
                collect_object_property_names(branch, out);
            }
        }
    }
}

fn is_canonical_field_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn is_candidate_unknown_key(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphabetic()
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Exact match to `requestFieldHints` in `packages/contracts/src/field-hints.ts:33-61`.
/// Returns ONLY canonical top-level schema field names, never user-supplied keys.
fn suggested_fields_for(schema: &Value, input: &Value) -> Vec<String> {
    let Some(map) = input.as_object() else {
        return Vec::new();
    };
    let mut fields_set = BTreeSet::new();
    collect_object_property_names(schema, &mut fields_set);
    let fields: Vec<String> = fields_set.into_iter().collect();
    if fields.is_empty() {
        return Vec::new();
    }
    let present: BTreeSet<&str> = map.keys().map(String::as_str).collect();
    let unknown: Vec<&str> = map
        .keys()
        .take(128)
        .map(String::as_str)
        .filter(|key| !fields.iter().any(|f| f == key) && is_candidate_unknown_key(key))
        .take(8)
        .collect();
    let mut suggested = BTreeSet::new();
    for key in unknown {
        let compact = key.to_ascii_lowercase().replace('_', "");
        let matches: Vec<&str> = fields
            .iter()
            .map(String::as_str)
            .filter(|field| is_single_edit(key, field) || compact == field.replace('_', ""))
            .collect();
        if matches.len() == 1 && !present.contains(matches[0]) {
            suggested.insert(matches[0].to_owned());
        }
    }
    suggested.into_iter().take(3).collect()
}

/// Pure-Rust FIPS 180-4 SHA-256 hex digest (zero external crates).
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity((bytes.len() + 9).div_ceil(64) * 64);
    padded.extend_from_slice(bytes);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut hex = String::with_capacity(64);
    for word in h {
        hex.push_str(&format!("{word:08x}"));
    }
    hex
}

fn bundled_schema_raw(id: &str) -> Option<&'static str> {
    BUNDLED_SCHEMAS
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.raw)
}

fn resolve_target_spec(spec: &str) -> Result<(&'static str, Option<String>), &'static str> {
    if let Some(&(_, schema_id, slice)) = KIND_ALIASES.iter().find(|&&(alias, _, _)| alias == spec)
    {
        return Ok((schema_id, Some(slice.to_owned())));
    }
    if let Some((schema_id, slice)) = spec.split_once('/') {
        let Some(entry) = BUNDLED_SCHEMAS.iter().find(|s| s.id == schema_id) else {
            return Err(
                "Unknown bundled schema ID; run `asimp validate --list-schemas` to see supported schemas and kind aliases.",
            );
        };
        if slice.is_empty() || slice.contains('/') {
            return Err("Schema slice must name a single property or top-level slice.");
        }
        return Ok((entry.id, Some(slice.to_owned())));
    }
    if let Some(entry) = BUNDLED_SCHEMAS.iter().find(|s| s.id == spec) {
        return Ok((entry.id, None));
    }
    Err(
        "Unknown --kind or schema target; run `asimp validate --list-schemas` to see supported schemas and kind aliases.",
    )
}

fn extract_slice_schema(root: &Value, slice: Option<&str>) -> Result<Value, &'static str> {
    let Some(slice_name) = slice else {
        return Ok(root.clone());
    };
    let extracted = root
        .get("properties")
        .and_then(|p| p.get(slice_name))
        .or_else(|| {
            if META_SCHEMA_KEYS.contains(&slice_name) {
                None
            } else {
                root.get(slice_name)
            }
        })
        .or_else(|| root.get("$defs").and_then(|d| d.get(slice_name)))
        .ok_or("Requested schema slice was not found in the selected schema document.")?;
    let Some(obj) = extracted.as_object() else {
        return Ok(extracted.clone());
    };
    let mut merged: Map<String, Value> = obj.clone();
    if let Some(draft) = root.get("$schema")
        && !merged.contains_key("$schema")
    {
        merged.insert("$schema".to_owned(), draft.clone());
    }
    if let Some(defs) = root.get("$defs")
        && !merged.contains_key("$defs")
    {
        merged.insert("$defs".to_owned(), defs.clone());
    }
    Ok(Value::Object(merged))
}

fn is_valid_public_ledger_problem_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("P-") else {
        return false;
    };
    let b = rest.as_bytes();
    (2..=31).contains(&b.len())
        && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|&c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
        && !id.contains("--")
}

/// Exact Rust parity for `parseNowPageCursor` (`packages/contracts/src/discovery.ts:143-161`).
fn is_valid_now_page_cursor(raw: &str) -> bool {
    if raw.len() > 1024 {
        return false;
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    if items.len() != 5 {
        return false;
    }
    let tag_ok = items[0].as_str() == Some("n1");
    let created_ok = items[1]
        .as_str()
        .is_some_and(|s| (1..=64).contains(&s.encode_utf16().count()));
    let problem_ok = items[2]
        .as_str()
        .is_some_and(is_valid_public_ledger_problem_id);
    let seq_ok = items[3]
        .as_u64()
        .is_some_and(|n| n <= 9_007_199_254_740_991);
    let event_ok = items[4]
        .as_str()
        .is_some_and(|s| (1..=128).contains(&s.encode_utf16().count()));
    if !(tag_ok && created_ok && problem_ok && seq_ok && event_ok) {
        return false;
    }
    serde_json::to_string(&Value::Array(items)).is_ok_and(|reencoded| reencoded == raw)
}

fn invalid_discovery_cursor_pointers(value: &Value) -> Option<Vec<String>> {
    let map = value.as_object()?;
    let mut pointers = Vec::new();
    for key in [
        "before",
        "contributions_before",
        "reviews_before",
        "negative_before",
    ] {
        if let Some(Value::String(cursor)) = map.get(key)
            && !is_valid_now_page_cursor(cursor)
        {
            pointers.push(format!("/{key}"));
        }
    }
    if pointers.is_empty() {
        None
    } else {
        Some(pointers)
    }
}

fn is_claim_publication_slice(schema_id: &str, slice: Option<&str>) -> bool {
    schema_id == "sessions"
        && matches!(
            slice,
            Some("promote_request" | "revise_request" | "direct_claim_request")
        )
}

/// Rewrites ECMAScript `/u` lone-surrogate negative lookahead guards that Rust
/// UTF-8 regex engines reject as out-of-range scalar escapes (`\uD800-\uDFFF`).
/// In Rust, `serde_json::from_str` already rejects lone UTF-16 surrogates when
/// decoding UTF-8 JSON strings, so removing this guard preserves exact `/u`
/// semantics (valid astral pairs remain permitted, lone surrogates cannot exist).
fn normalize_utf8_schema_patterns(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(pattern)) = map.get_mut("pattern")
                && pattern.contains(r"(?![\s\S]*[\uD800-\uDFFF])")
            {
                *pattern = pattern.replace(r"(?![\s\S]*[\uD800-\uDFFF])", "");
            }
            for child in map.values_mut() {
                normalize_utf8_schema_patterns(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_utf8_schema_patterns(item);
            }
        }
        _ => {}
    }
}

fn compile_offline_validator(schema: &Value) -> Result<jsonschema::Validator, &'static str> {
    let mut normalized = schema.clone();
    normalize_utf8_schema_patterns(&mut normalized);
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .should_validate_formats(true)
        .build(&normalized)
        .map_err(|_| "Selected JSON Schema could not be compiled offline.")
}

/// Core pure validation entrypoint shared by the CLI and differential corpus tests.
pub fn validate_document(
    schema_id: &str,
    schema_raw: &str,
    slice: Option<&str>,
    raw_input: &str,
    run_scrub: bool,
) -> Result<ValidationVerdict, &'static str> {
    let root_schema: Value =
        serde_json::from_str(schema_raw).map_err(|_| "Schema document is not valid JSON.")?;
    let effective_schema = extract_slice_schema(&root_schema, slice)?;
    let validator = compile_offline_validator(&effective_schema)?;
    let schema_sha256 = sha256_hex(schema_raw.as_bytes());

    let value: Value = serde_json::from_str(raw_input)
        .map_err(|_| "Input is not valid UTF-8 JSON; fix syntax errors before validating.")?;
    let canonical_sha256 = canonical_json(&value)
        .ok()
        .map(|canon| sha256_hex(canon.as_bytes()));

    let claim_pub = is_claim_publication_slice(schema_id, slice);

    // 1. Worker P2/P4 check FIRST on claim publication/revision routes (`router-core.ts:7032`).
    if claim_pub && contains_authoritative_field(&value) {
        return Ok(ValidationVerdict {
            valid: false,
            schema_id: schema_id.to_owned(),
            slice: slice.map(str::to_owned),
            code: Some("SCHEMA_INVALID"),
            rule: Some("P2/P4"),
            fix_hint: Some(
                "Remove author-writable disposition, proof, confidence, certification, or status-upgrade fields; the ledger computes disposition after independent review.",
            ),
            pointers: Vec::new(),
            suggested_fields: Vec::new(),
            secret_findings: Vec::new(),
            canonical_sha256,
            schema_sha256,
        });
    }

    // 2. JSON Schema validation against the exact @asimposium/contracts artifact.
    let mut pointers: BTreeSet<String> = BTreeSet::new();
    for error in validator.iter_errors(&value) {
        let path = error.instance_path().as_str();
        pointers.insert(if path.is_empty() {
            "/".to_owned()
        } else {
            path.to_owned()
        });
        if pointers.len() >= 20 {
            break;
        }
    }
    if !pointers.is_empty() {
        let suggested_fields = suggested_fields_for(&effective_schema, &value);
        let code = if schema_id == "sessions" && slice == Some("promote_request") {
            "PROMOTE_BODY_INVALID"
        } else {
            "SCHEMA_INVALID"
        };
        let fix_hint = if schema_id == "sessions" && slice == Some("promote_request") {
            "To publish a saved typed draft, send {workshop_id, expected_workshop_version?, client_context_cursor?}. For inline publication, also send kind, statement and the falsifier required by your claim kind."
        } else {
            "Align the JSON fields and types with the selected @asimposium/contracts schema."
        };
        return Ok(ValidationVerdict {
            valid: false,
            schema_id: schema_id.to_owned(),
            slice: slice.map(str::to_owned),
            code: Some(code),
            rule: Some("A5"),
            fix_hint: Some(fix_hint),
            pointers: pointers.into_iter().collect(),
            suggested_fields,
            secret_findings: Vec::new(),
            canonical_sha256,
            schema_sha256,
        });
    }

    // 3. Worker P3 falsifier check (`router-core.ts:6336,7270,19878`).
    if claim_pub
        && let Some(obj) = value.as_object()
        && let Some(kind) = obj.get("kind").and_then(Value::as_str)
        && CONJECTURE_CLASS_KINDS.contains(&kind)
        && !obj.contains_key("falsifier")
    {
        return Ok(ValidationVerdict {
            valid: false,
            schema_id: schema_id.to_owned(),
            slice: slice.map(str::to_owned),
            code: Some("MISSING_FALSIFIER"),
            rule: Some("P3"),
            fix_hint: Some(
                "Add 'falsifier'. If nothing could refute the statement, it may be a definition (kind: 'definition').",
            ),
            pointers: vec!["/falsifier".to_owned()],
            suggested_fields: Vec::new(),
            secret_findings: Vec::new(),
            canonical_sha256,
            schema_sha256,
        });
    }

    // 3b. Worker runtime cursor tuple refinement for discovery query slices
    // (`packages/contracts/src/discovery.ts:143-183`). The generated JSON Schema
    // documents this string pattern as a transport superset while Zod refines the
    // decoded 5-tuple `["n1", created_at, problem_id, seq, event_id]`.
    if schema_id == "discovery"
        && matches!(slice, Some("now_query" | "honors_query" | "fellow_query"))
        && let Some(bad_pointers) = invalid_discovery_cursor_pointers(&value)
    {
        return Ok(ValidationVerdict {
            valid: false,
            schema_id: schema_id.to_owned(),
            slice: slice.map(str::to_owned),
            code: Some("SCHEMA_INVALID"),
            rule: Some("A5"),
            fix_hint: Some("Use an unchanged opaque next_before cursor from the previous page."),
            pointers: bad_pointers,
            suggested_fields: Vec::new(),
            secret_findings: Vec::new(),
            canonical_sha256,
            schema_sha256,
        });
    }

    // 4. Optional P7 credential wall (`credential-scan.ts`).
    if run_scrub {
        let findings = scrub::scan_field_for_credentials("request", raw_input);
        if !findings.is_empty() {
            return Ok(ValidationVerdict {
                valid: false,
                schema_id: schema_id.to_owned(),
                slice: slice.map(str::to_owned),
                code: Some("SECRET_SHAPED_CONTENT"),
                rule: Some("P7"),
                fix_hint: Some(
                    "Remove every reported credential before uploading or promoting. If any reported value was a live credential, rotate it immediately.",
                ),
                pointers: Vec::new(),
                suggested_fields: Vec::new(),
                secret_findings: findings,
                canonical_sha256,
                schema_sha256,
            });
        }
    }

    Ok(ValidationVerdict {
        valid: true,
        schema_id: schema_id.to_owned(),
        slice: slice.map(str::to_owned),
        code: None,
        rule: None,
        fix_hint: None,
        pointers: Vec::new(),
        suggested_fields: Vec::new(),
        secret_findings: Vec::new(),
        canonical_sha256,
        schema_sha256,
    })
}

/// Validates a JSON document against a bundled `@asimposium/contracts` schema or alias.
pub fn validate_bundled(
    target: &str,
    raw_input: &str,
    run_scrub: bool,
) -> Result<ValidationVerdict, &'static str> {
    let (schema_id, slice) = resolve_target_spec(target)?;
    let raw_schema = bundled_schema_raw(schema_id)
        .ok_or("Bundled schema is missing; rebuild asimp from a clean checkout.")?;
    validate_document(
        schema_id,
        raw_schema,
        slice.as_deref(),
        raw_input,
        run_scrub,
    )
}

fn list_slices(raw: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    if let Some(props) = root.get("properties").and_then(Value::as_object) {
        let mut keys: Vec<String> = props.keys().cloned().collect();
        keys.sort();
        return keys;
    }
    if let Some(obj) = root.as_object() {
        let mut keys: Vec<String> = obj
            .keys()
            .filter(|k| !META_SCHEMA_KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        keys.sort();
        return keys;
    }
    Vec::new()
}

fn format_schema_catalog(json_mode: bool) -> CliOutput {
    if json_mode {
        let schemas: Vec<Value> = BUNDLED_SCHEMAS
            .iter()
            .map(|entry| {
                json!({
                    "id": entry.id,
                    "sha256": sha256_hex(entry.raw.as_bytes()),
                    "slices": list_slices(entry.raw),
                })
            })
            .collect();
        let mut aliases: BTreeMap<&str, String> = BTreeMap::new();
        for &(alias, schema_id, slice) in KIND_ALIASES {
            aliases.insert(alias, format!("{schema_id}/{slice}"));
        }
        let payload = json!({
            "schema": "asimp.validate.catalog.v1",
            "aliases": aliases,
            "schemas": schemas,
        });
        CliOutput {
            exit_code: 0,
            stdout: format!("{payload}\n"),
            stderr: String::new(),
        }
    } else {
        let mut out = String::from("Kind aliases:\n");
        for &(alias, schema_id, slice) in KIND_ALIASES {
            out.push_str(&format!("  {alias} -> {schema_id}/{slice}\n"));
        }
        out.push_str("\nBundled @asimposium/contracts schemas:\n");
        for entry in BUNDLED_SCHEMAS {
            let slices = list_slices(entry.raw);
            out.push_str(&format!("  {} ({} slices)\n", entry.id, slices.len()));
        }
        CliOutput {
            exit_code: 0,
            stdout: out,
            stderr: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OriginSchemaFreshness {
    Skipped,
    Matched { remote_bytes: u64 },
    Stale { remote_bytes: u64, local_bytes: u64 },
    NotListed,
    Unavailable,
}

fn check_origin_schema_index(
    origin: &str,
    schema_id: &str,
    local_raw: &str,
    fetch: &mut impl FnMut(&str) -> Result<Fetched, FetchError>,
) -> OriginSchemaFreshness {
    let url = format!("{origin}/schemas/index.json");
    let Ok(fetched) = fetch(&url) else {
        return OriginSchemaFreshness::Unavailable;
    };
    if fetched.status != 200 || fetched.body.len() as u64 > MAX_BODY_BYTES {
        return OriginSchemaFreshness::Unavailable;
    }
    let Ok(index) = serde_json::from_str::<Value>(&fetched.body) else {
        return OriginSchemaFreshness::Unavailable;
    };
    let Some(entries) = index.get("schemas").and_then(Value::as_array) else {
        return OriginSchemaFreshness::Unavailable;
    };
    let Some(entry) = entries
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(schema_id))
    else {
        return OriginSchemaFreshness::NotListed;
    };
    let Some(remote_bytes) = entry.get("body_bytes").and_then(Value::as_u64) else {
        return OriginSchemaFreshness::Unavailable;
    };
    // Compare against the compact canonical serialization served by the Worker.
    let local_bytes = serde_json::from_str::<Value>(local_raw)
        .ok()
        .and_then(|v| serde_json::to_string(&v).ok())
        .map_or(local_raw.len() as u64, |s| s.len() as u64);
    if remote_bytes == local_bytes {
        OriginSchemaFreshness::Matched { remote_bytes }
    } else {
        OriginSchemaFreshness::Stale {
            remote_bytes,
            local_bytes,
        }
    }
}

fn read_regular_capped(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| format!("Cannot read {label}; supply an accessible regular UTF-8 file."))?;
    if !metadata.is_file() {
        return Err(format!("{label} must name a regular UTF-8 file."));
    }
    let file = std::fs::File::open(path)
        .map_err(|_| format!("Cannot open {label}; check file permissions."))?;
    read_capped_at(file, max_bytes).map_err(|_| {
        format!(
            "{label} must be valid UTF-8 within {} KiB.",
            max_bytes / 1024
        )
    })
}

pub fn run(cli: &Cli) -> CliOutput {
    run_with_io(
        cli,
        |path| read_regular_capped(path, MAX_VALIDATE_BYTES, "validation input"),
        |path| read_regular_capped(path, MAX_SCHEMA_FILE_BYTES, "--schema-file"),
        || {
            read_capped_at(std::io::stdin().lock(), MAX_VALIDATE_BYTES)
                .map_err(|_| "Validation stdin must be valid UTF-8 within 512 KiB.".to_owned())
        },
        crate::fetch_text,
    )
}

pub fn run_with_io(
    cli: &Cli,
    read_input: impl FnOnce(&Path) -> Result<String, String>,
    read_schema: impl FnOnce(&Path) -> Result<String, String>,
    read_stdin: impl FnOnce() -> Result<String, String>,
    mut fetch: impl FnMut(&str) -> Result<Fetched, FetchError>,
) -> CliOutput {
    let Command::Validate(args) = &cli.command else {
        return input_error("Expected the validate command.");
    };
    if args.list_schemas {
        return format_schema_catalog(args.json);
    }

    let (schema_id, schema_raw, slice): (String, String, Option<String>) = if let Some(
        schema_path,
    ) = &args.schema_file
    {
        let raw = match read_schema(schema_path) {
            Ok(text) => text,
            Err(message) => return input_error(&message),
        };
        ("custom".to_owned(), raw, args.slice.clone())
    } else {
        let Some(kind_spec) = args.kind.as_deref() else {
            return input_error(
                "Specify --kind <alias|schema|schema/slice> or --schema-file <path> (use --list-schemas to browse).",
            );
        };
        let (id, slice) = match resolve_target_spec(kind_spec) {
            Ok(resolved) => resolved,
            Err(message) => return input_error(message),
        };
        let Some(raw) = bundled_schema_raw(id) else {
            return input_error("Bundled schema is unavailable; rebuild asimp.");
        };
        (id.to_owned(), raw.to_owned(), slice)
    };

    let raw_input = if args.stdin {
        match read_stdin() {
            Ok(text) => text,
            Err(message) => return input_error(&message),
        }
    } else if let Some(path) = &args.file {
        match read_input(path) {
            Ok(text) => text,
            Err(message) => return input_error(&message),
        }
    } else {
        return input_error("Supply a regular UTF-8 JSON file or --stdin to validate.");
    };

    let verdict = match validate_document(
        &schema_id,
        &schema_raw,
        slice.as_deref(),
        &raw_input,
        args.scrub,
    ) {
        Ok(verdict) => verdict,
        Err(message) => return input_error(message),
    };

    let freshness = if args.check_origin {
        let origin = match resolve_origin(cli.origin.as_ref()) {
            Ok(origin) => origin,
            Err(_) => {
                return input_error(
                    "Choose a valid HTTPS --origin before checking remote schema freshness.",
                );
            }
        };
        check_origin_schema_index(&origin, &schema_id, &schema_raw, &mut fetch)
    } else {
        OriginSchemaFreshness::Skipped
    };

    let freshness_json = match &freshness {
        OriginSchemaFreshness::Skipped => Value::Null,
        OriginSchemaFreshness::Matched { remote_bytes } => json!({
            "status": "matched",
            "remote_bytes": remote_bytes,
        }),
        OriginSchemaFreshness::Stale {
            remote_bytes,
            local_bytes,
        } => json!({
            "status": "stale",
            "remote_bytes": remote_bytes,
            "local_bytes": local_bytes,
        }),
        OriginSchemaFreshness::NotListed => json!({ "status": "not_listed" }),
        OriginSchemaFreshness::Unavailable => json!({ "status": "unavailable" }),
    };

    let stdout = if args.json {
        let payload = json!({
            "schema": "asimp.validate.v1",
            "target_schema": verdict.schema_id,
            "slice": verdict.slice,
            "valid": verdict.valid,
            "code": verdict.code,
            "rule": verdict.rule,
            "pointers": verdict.pointers,
            "suggested_fields": verdict.suggested_fields,
            "secret_findings": verdict.secret_findings.iter().map(|f| json!({
                "path": f.path,
                "kind": f.kind.as_str(),
                "line": f.line,
                "column": f.column,
            })).collect::<Vec<_>>(),
            "fix_hint": verdict.fix_hint,
            "canonical_sha256": verdict.canonical_sha256,
            "schema_sha256": verdict.schema_sha256,
            "origin_freshness": freshness_json,
        });
        format!("{payload}\n")
    } else if verdict.valid {
        let target_label = match &verdict.slice {
            Some(s) => format!("{}/{s}", verdict.schema_id),
            None => verdict.schema_id.clone(),
        };
        let mut out = format!("valid ({target_label})\n");
        if let OriginSchemaFreshness::Stale {
            remote_bytes,
            local_bytes,
        } = freshness
        {
            out.push_str(&format!(
                "note: origin schema byte count ({remote_bytes}) differs from bundled copy ({local_bytes}); fetch /schemas/{}.v1.json and validate with --schema-file.\n",
                verdict.schema_id
            ));
        }
        out
    } else {
        let target_label = match &verdict.slice {
            Some(s) => format!("{}/{s}", verdict.schema_id),
            None => verdict.schema_id.clone(),
        };
        let mut out = format!(
            "invalid ({target_label}): {} (rule {})\n",
            verdict.code.unwrap_or("SCHEMA_INVALID"),
            verdict.rule.unwrap_or("A5")
        );
        if !verdict.pointers.is_empty() {
            out.push_str(&format!("  pointers: {}\n", verdict.pointers.join(", ")));
        }
        if !verdict.suggested_fields.is_empty() {
            out.push_str(&format!(
                "  suggested_fields: {}\n",
                verdict.suggested_fields.join(", ")
            ));
        }
        for finding in &verdict.secret_findings {
            out.push_str(&format!(
                "  secret: {} at {} line {}, column {}\n",
                finding.kind.as_str(),
                finding.path,
                finding.line,
                finding.column
            ));
        }
        if let Some(hint) = verdict.fix_hint {
            out.push_str(&format!("  fix_hint: {hint}\n"));
        }
        out
    };

    CliOutput {
        exit_code: if verdict.valid { 0 } else { 1 },
        stdout,
        stderr: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Cli;
    use clap::Parser;

    #[test]
    fn sha256_matches_standard_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn all_bundled_schemas_parse_and_all_kind_aliases_compile() {
        for entry in BUNDLED_SCHEMAS {
            let parsed: Value = serde_json::from_str(entry.raw)
                .unwrap_or_else(|e| panic!("{} invalid JSON: {e}", entry.id));
            assert!(parsed.is_object(), "{} must be JSON object", entry.id);
            compile_offline_validator(&parsed)
                .unwrap_or_else(|e| panic!("root schema {} compile failed: {e}", entry.id));
            for slice in list_slices(entry.raw) {
                let sub = extract_slice_schema(&parsed, Some(&slice))
                    .unwrap_or_else(|e| panic!("{}/{slice}: {e}", entry.id));
                compile_offline_validator(&sub)
                    .unwrap_or_else(|e| panic!("{}/{slice} compile failed: {e}", entry.id));
            }
        }
        for &(alias, schema_id, slice) in KIND_ALIASES {
            let raw = bundled_schema_raw(schema_id).unwrap();
            let root: Value = serde_json::from_str(raw).unwrap();
            let sub = extract_slice_schema(&root, Some(slice))
                .unwrap_or_else(|e| panic!("alias {alias} -> {schema_id}/{slice}: {e}"));
            compile_offline_validator(&sub)
                .unwrap_or_else(|e| panic!("alias {alias} compile failed: {e}"));
        }
    }

    #[test]
    fn format_validation_enforces_rfc3339_dates_and_uris_offline() {
        let valid_leap = r#"{"problem_id":"P-EXAMPLE","quiet_since":"2024-02-29T00:00:00Z","recorded_at":"2026-01-01T12:34:00Z","reason":"quiet"}"#;
        let bad_leap = r#"{"problem_id":"P-EXAMPLE","quiet_since":"2026-02-29T00:00:00Z","recorded_at":"2026-01-01T12:34:00Z","reason":"quiet"}"#;
        assert!(
            !validate_bundled("problems/dormancy_event", bad_leap, false)
                .unwrap()
                .valid
        );
        let _ = validate_bundled("problems/dormancy_event", valid_leap, false).unwrap();

        let good_problem = r#"{"type":"https://asimposium.org/errors/UNKNOWN_FORMAT","title":"Unsupported response format","status":400,"code":"UNKNOWN_FORMAT","detail":"The ?format= value is not one this route serves.","fix_hint":"Drop ?format= or use one of the values in `allowed`.","rule":"A5","schema":"https://a.asimposium.org/schemas/problem.v1.json","example":{"method":"GET","path":"/protocol.md?format=md"},"allowed":["md"]}"#;
        assert!(
            validate_bundled("problem/problem_document", good_problem, false)
                .unwrap()
                .valid
        );
        let bad_uri_problem = good_problem.replace(
            "https://a.asimposium.org/schemas/problem.v1.json",
            "not a valid uri",
        );
        assert!(
            !validate_bundled("problem/problem_document", &bad_uri_problem, false)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn promote_enforces_p2_p4_self_certification_and_p3_falsifier_and_field_hints() {
        let self_cert = r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"conjecture","statement":"Claim","falsifier":"Counter","disposition":"proved"}"#;
        let v = validate_bundled("promote", self_cert, false).unwrap();
        assert!(!v.valid);
        assert_eq!(v.code, Some("SCHEMA_INVALID"));
        assert_eq!(v.rule, Some("P2/P4"));

        // Fullwidth Unicode compatibility form of `proved` is caught identically to NFKC.
        let nfkc_cert = r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"Def","ｐｒｏｖｅｄ":true}"#;
        let v_nfkc = validate_bundled("promote", nfkc_cert, false).unwrap();
        assert!(!v_nfkc.valid);
        assert_eq!(v_nfkc.rule, Some("P2/P4"));

        // Missing falsifier on conjecture-class claim -> MISSING_FALSIFIER (P3).
        let no_falsifier = r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"conjecture","statement":"Every even n > 2 is a sum of two primes."}"#;
        let v_p3 = validate_bundled("promote", no_falsifier, false).unwrap();
        assert!(!v_p3.valid);
        assert_eq!(v_p3.code, Some("MISSING_FALSIFIER"));
        assert_eq!(v_p3.rule, Some("P3"));
        assert_eq!(v_p3.pointers, vec!["/falsifier"]);

        // Definition without falsifier is valid.
        let definition = r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"A prime is an integer > 1 with no nontrivial divisors."}"#;
        let v_def = validate_bundled("promote", definition, false).unwrap();
        assert!(v_def.valid);

        // Saved typed draft promotion without inline kind/statement is valid.
        let saved_draft =
            r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","expected_workshop_version":1}"#;
        let v_saved = validate_bundled("promote", saved_draft, false).unwrap();
        assert!(v_saved.valid);

        // Single-edit typo suggests canonical field name without echoing rejected key.
        let typo =
            r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statemnt":"x"}"#;
        let v_typo = validate_bundled("promote", typo, false).unwrap();
        assert!(!v_typo.valid);
        assert_eq!(v_typo.code, Some("PROMOTE_BODY_INVALID"));
        assert_eq!(v_typo.suggested_fields, vec!["statement"]);
    }

    #[test]
    fn validate_with_scrub_catches_credentials_without_echoing() {
        let secret = format!("ghp_{}", "x".repeat(36));
        let payload = format!(
            r#"{{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"Check {secret}"}}"#
        );
        let cli = Cli::try_parse_from([
            "asimp", "validate", "--stdin", "--kind", "promote", "--scrub", "--json",
        ])
        .unwrap();
        let out = run_with_io(
            &cli,
            |_| unreachable!(),
            |_| unreachable!(),
            || Ok(payload),
            |_| unreachable!(),
        );
        assert_eq!(out.exit_code, 1);
        let parsed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(parsed["code"], "SECRET_SHAPED_CONTENT");
        assert_eq!(parsed["rule"], "P7");
        assert!(!out.stdout.contains(&secret));
    }

    #[test]
    fn origin_freshness_reports_stale_without_mutating_offline_verdict() {
        let cli = Cli::try_parse_from([
            "asimp",
            "--origin",
            "https://example.test",
            "validate",
            "--stdin",
            "--kind",
            "promote",
            "--check-origin",
            "--json",
        ])
        .unwrap();
        let out = run_with_io(
            &cli,
            |_| unreachable!(),
            |_| unreachable!(),
            || {
                Ok(
                    r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"Valid definition."}"#
                        .to_owned(),
                )
            },
            |url| {
                assert_eq!(url, "https://example.test/schemas/index.json");
                Ok(Fetched {
                    status: 200,
                    body: r#"{"schemas":[{"id":"sessions","body_bytes":999999}]}"#.to_owned(),
                })
            },
        );
        assert_eq!(out.exit_code, 0);
        let parsed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(parsed["valid"], true);
        assert_eq!(parsed["origin_freshness"]["status"], "stale");
    }
}
