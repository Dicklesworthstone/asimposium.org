//! Durable, replay-safe write spool and `asimp sync` drainer (W11.4,
//! `asimposiumorg-jsj`).
//!
//! Design center — **Replay-Window Truth Table**:
//! - Only idempotency-keyed session/ledger write paths may enter the spool.
//!   One-time exchanges (enrollment, device-code token exchange, join URLs,
//!   rebind claims) are unconditionally refused on enqueue AND before send.
//! - `unsent`: never attempted. May be assigned an idempotency key on first
//!   send even if drafted > 24h ago.
//! - `in_flight`: attempted at least once with an ambiguous transport outcome.
//!   Retains its EXACT original `idempotency_key` and canonical payload bytes.
//!   Replayed safely ONLY while the 24h server replay window is live (measured
//!   against comparable server `Date` headers). A temporary missing current
//!   clock leaves a valid server-timed attempt unchanged until the next sync.
//! - `unknown_commit`: an `in_flight` item whose replay window expired or cannot
//!   be established from comparable server timestamps, without
//!   authoritative server confirmation. `sync` stops it here, preserves ALL
//!   evidence, prints read-only reconciliation commands, and NEVER rotates its
//!   key, resubmits, marks success, or deletes it.
//! - `rejected`: definitively rejected (4xx contract/policy refusal). Stays
//!   rejected until the user explicitly abandons it or creates a new logical
//!   write with a new key.
//! - `committed`: reconciled with an authoritative 2xx receipt (or explicit
//!   human/agent reconciliation after inspecting server state).
//!
//! All spool logs (`logs/spool.jsonl`) are structured metadata only, checked
//! through `scrub::scan_field_for_credentials`, and never echo secrets, bearer
//! tokens, or raw private bodies.

use crate::{
    Cli, CliOutput, Command, OUTBOUND_USER_AGENT, READ_TIMEOUT, build_url,
    canonical_json::canonical_json,
    enrollment, input_error,
    protocol::{
        DeprecationNotice, PROTOCOL_VERSION_HEADER, ProtocolMismatch, inspect_success_headers,
        parse_unsupported_version_problem, resolve_protocol_version,
    },
    pull::is_valid_problem_id,
    resolve_origin, safe_session_segment, scrub,
    validate::sha256_hex,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

static ATOMIC_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Server idempotency retention window (24 hours, Fable §7.1 / AGENTS.md).
pub const REPLAY_WINDOW_SECONDS: u64 = 24 * 60 * 60;
/// Maximum JSON request body size accepted into the spool (same 512 KiB bound as Worker).
pub const MAX_SPOOL_BODY_BYTES: u64 = 512 * 1024;
// JSON string escaping can expand the original body sixfold on disk.
const MAX_SPOOL_ITEM_BYTES: u64 = MAX_SPOOL_BODY_BYTES * 6 + 32 * 1024;
const MAX_SPOOL_EPOCH_SECONDS: u64 = 253_402_300_799;
// Reserve the complete clock probe and POST deadlines plus two seconds for
// HTTP Date/Age granularity and elapsed-time rounding.
const REPLAY_SEND_MARGIN_SECONDS: u64 = READ_TIMEOUT.as_secs() * 2 + 2;
/// Provenance header carrying `client_occurred_at` without mutating strict JSON schemas.
pub const CLIENT_OCCURRED_AT_HEADER: &str = "asimp-client-occurred-at";

#[derive(Debug, clap::Args)]
pub struct SpoolArgs {
    #[command(subcommand)]
    pub command: SpoolCommand,
}

#[derive(Debug, clap::Subcommand)]
pub enum SpoolCommand {
    /// Enqueue an idempotent session/ledger JSON write into the durable spool (refuses one-time exchanges and P7 secrets).
    Enqueue {
        /// Origin-relative API path (e.g. /v1/sessions/S-1/promote). One-time enrollment paths are refused.
        #[arg(long, value_name = "API_PATH")]
        path: String,
        /// Regular UTF-8 JSON request file (up to 512 KiB).
        #[arg(long, value_name = "JSON_FILE")]
        file: PathBuf,
        /// Optional explicit idempotency key; if omitted, minted when first attempted.
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
        /// Optional session ID for reconciliation hints (inferred automatically from /v1/sessions/<id>/...).
        #[arg(long, value_name = "SESSION_ID")]
        session: Option<String>,
        /// Optional public problem ID for reconciliation hints (e.g. P-4DSP).
        #[arg(long, value_name = "PROBLEM_ID")]
        problem: Option<String>,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON metadata.
        #[arg(long)]
        json: bool,
    },
    /// List spooled items grouped by state (`unsent`, `in_flight`, `committed`, `rejected`, `unknown_commit`).
    List {
        /// Optional state filter (`unsent`, `in_flight`, `committed`, `rejected`, `unknown_commit`).
        #[arg(long, value_name = "STATE")]
        state: Option<String>,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
    /// Inspect one spool item's safe metadata and read-only reconciliation commands (never echoes secrets).
    Show {
        /// Spool item ID (e.g. SP-...).
        id: String,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
    /// Explicitly record a human/agent reconciliation decision for an `unknown_commit` or `rejected` item.
    Resolve {
        /// Spool item ID (e.g. SP-...).
        id: String,
        /// Explicit resolution: `committed` (verified on server) or `abandoned` (will not be retried).
        #[arg(long = "as", value_name = "committed|abandoned")]
        resolution: String,
        /// Authoritative server event ID observed during read-only reconciliation (required for `--as committed`).
        #[arg(long, value_name = "EVENT_ID")]
        event_id: Option<String>,
        /// Short operator/agent note explaining the reconciliation evidence.
        #[arg(long, value_name = "TEXT")]
        reason: Option<String>,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
    /// Record or update a durable per-problem cursor inside the spool.
    CursorSet {
        /// Public problem ID (e.g. P-4DSP).
        problem: String,
        /// Non-negative safe-integer sequence cursor.
        cursor: u64,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
    /// List stored per-problem cursors in the durable spool.
    Cursors {
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
    /// Record or update a resumable digest-verified artifact upload entry in the spool.
    ArtifactTrack {
        /// Local regular file whose SHA-256 and size are pinned for resumable upload verification.
        #[arg(long, value_name = "FILE")]
        file: PathBuf,
        /// Session ID owning the upload.
        #[arg(long, value_name = "SESSION_ID")]
        session: String,
        /// Optional server upload ID once initiated.
        #[arg(long, value_name = "UPLOAD_ID")]
        upload_id: Option<String>,
        /// Bytes confirmed uploaded so far (defaults to 0).
        #[arg(long, default_value = "0")]
        uploaded_bytes: u64,
        /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
        #[arg(long, value_name = "DIR")]
        spool_dir: Option<PathBuf>,
        /// Emit deterministic JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, clap::Args)]
pub struct SyncArgs {
    /// Override spool directory (default: ASIMP_SPOOL_DIR or ~/.asimp/spool).
    #[arg(long, value_name = "DIR")]
    pub spool_dir: Option<PathBuf>,

    /// Drain only this single spool item ID.
    #[arg(long, value_name = "ITEM_ID")]
    pub item: Option<String>,

    /// Inspect what `sync` would retry, skip, or freeze as `unknown_commit` without sending any POSTs.
    #[arg(long)]
    pub dry_run: bool,

    /// Emit deterministic JSON summary.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoolState {
    Unsent,
    InFlight,
    Committed,
    Rejected,
    UnknownCommit,
}

impl SpoolState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsent => "unsent",
            Self::InFlight => "in_flight",
            Self::Committed => "committed",
            Self::Rejected => "rejected",
            Self::UnknownCommit => "unknown_commit",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "unsent" => Some(Self::Unsent),
            "in_flight" => Some(Self::InFlight),
            "committed" => Some(Self::Committed),
            "rejected" => Some(Self::Rejected),
            "unknown_commit" => Some(Self::UnknownCommit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SpoolItem {
    pub id: String,
    pub origin: String,
    pub path: String,
    pub session_id: Option<String>,
    pub problem_id: Option<String>,
    pub state: SpoolState,
    pub idempotency_key: Option<String>,
    pub body_json: String,
    pub body_sha256: String,
    pub client_occurred_at: String,
    pub created_epoch_s: u64,
    pub first_attempted_epoch_s: Option<u64>,
    pub first_attempted_clock: Option<String>,
    pub attempts: u32,
    pub last_http_status: Option<u16>,
    pub last_error_code: Option<String>,
    pub receipt_sha256: Option<String>,
    pub server_event_id: Option<String>,
    pub server_object_id: Option<String>,
    pub resolution_note: Option<String>,
}

impl SpoolItem {
    pub fn to_disk_json(&self) -> Value {
        json!({
            "schema": "asimp.spool-item.v1",
            "id": self.id,
            "origin": self.origin,
            "path": self.path,
            "session_id": self.session_id,
            "problem_id": self.problem_id,
            "state": self.state.as_str(),
            "idempotency_key": self.idempotency_key,
            "body_json": self.body_json,
            "body_sha256": self.body_sha256,
            "client_occurred_at": self.client_occurred_at,
            "created_epoch_s": self.created_epoch_s,
            "first_attempted_epoch_s": self.first_attempted_epoch_s,
            "first_attempted_clock": self.first_attempted_clock,
            "attempts": self.attempts,
            "last_http_status": self.last_http_status,
            "last_error_code": self.last_error_code,
            "receipt_sha256": self.receipt_sha256,
            "server_event_id": self.server_event_id,
            "server_object_id": self.server_object_id,
            "resolution_note": self.resolution_note,
        })
    }

    pub fn from_disk_json(raw: &str) -> Result<Self, &'static str> {
        if raw.len() as u64 > MAX_SPOOL_ITEM_BYTES {
            return Err("Spool item exceeds the storage bound; preserve it for recovery.");
        }
        let v: Value = serde_json::from_str(raw).map_err(|_| "Spool item is not valid JSON.")?;
        let obj = v.as_object().ok_or("Spool item is not a JSON object.")?;
        if obj.get("schema").and_then(Value::as_str) != Some("asimp.spool-item.v1") {
            return Err("Unrecognized spool item schema version.");
        }
        let req_str = |k: &str| -> Result<String, &'static str> {
            obj.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or("Spool item missing required string field.")
        };
        let opt_str = |k: &str| -> Result<Option<String>, &'static str> {
            match obj.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value)) => Ok(Some(value.clone())),
                _ => Err("Spool item contains invalid optional text metadata."),
            }
        };
        let opt_u64 = |k: &str| -> Result<Option<u64>, &'static str> {
            match obj.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_u64()
                    .map(Some)
                    .ok_or("Spool item contains invalid numeric metadata."),
            }
        };
        let item = Self {
            id: req_str("id")?,
            origin: req_str("origin")?,
            path: req_str("path")?,
            session_id: opt_str("session_id")?,
            problem_id: opt_str("problem_id")?,
            state: SpoolState::parse(&req_str("state")?).ok_or("Invalid spool item state.")?,
            idempotency_key: opt_str("idempotency_key")?,
            body_json: req_str("body_json")?,
            body_sha256: req_str("body_sha256")?,
            client_occurred_at: req_str("client_occurred_at")?,
            created_epoch_s: obj
                .get("created_epoch_s")
                .and_then(Value::as_u64)
                .ok_or("Spool item missing created_epoch_s.")?,
            first_attempted_epoch_s: opt_u64("first_attempted_epoch_s")?,
            first_attempted_clock: opt_str("first_attempted_clock")?,
            attempts: obj
                .get("attempts")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or("Spool item contains an invalid attempt count.")?,
            last_http_status: opt_u64("last_http_status")?
                .map(|value| {
                    u16::try_from(value)
                        .ok()
                        .filter(|status| (100..=599).contains(status))
                        .ok_or("Spool item contains an invalid HTTP status.")
                })
                .transpose()?,
            last_error_code: opt_str("last_error_code")?,
            receipt_sha256: opt_str("receipt_sha256")?,
            server_event_id: opt_str("server_event_id")?,
            server_object_id: opt_str("server_object_id")?,
            resolution_note: opt_str("resolution_note")?,
        };
        item.validate()?;
        Ok(item)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if !is_safe_spool_id(&self.id)
            || self.origin.len() > 2048
            || self.path.len() > 2048
            || build_url(&self.origin, &self.path).is_err()
            || self
                .session_id
                .as_deref()
                .is_some_and(|id| !safe_session_segment(id))
            || self
                .problem_id
                .as_deref()
                .is_some_and(|id| !is_valid_problem_id(id))
        {
            return Err("Spool item has invalid identity or request metadata.");
        }
        if self.body_json.len() as u64 > MAX_SPOOL_BODY_BYTES {
            return Err("Spool item request exceeds the 512 KiB Worker bound.");
        }
        let body: Value = serde_json::from_str(&self.body_json)
            .map_err(|_| "Spool item request is not valid JSON.")?;
        if !body.is_object() {
            return Err("Spool item request is not a JSON object.");
        }
        let canonical = canonical_json(&body).map_err(|_| "Cannot verify the spool request.")?;
        if self.body_sha256 != sha256_hex(canonical.as_bytes()) {
            return Err("Spool request digest changed; preserve it and reconcile before retrying.");
        }
        if self.created_epoch_s > MAX_SPOOL_EPOCH_SECONDS
            || self.client_occurred_at != format_utc_rfc3339(self.created_epoch_s)
            || self
                .first_attempted_epoch_s
                .is_some_and(|value| value > MAX_SPOOL_EPOCH_SECONDS)
            || self
                .idempotency_key
                .as_deref()
                .is_some_and(|key| !is_safe_idempotency_key(key))
        {
            return Err("Spool item has invalid timestamp or idempotency metadata.");
        }
        let attempted = self.attempts > 0;
        let clock = self.first_attempted_clock.as_deref();
        let pending = matches!(self.state, SpoolState::InFlight | SpoolState::UnknownCommit);
        if attempted != self.first_attempted_epoch_s.is_some()
            || attempted != self.first_attempted_clock.is_some()
            || (attempted
                && (self.idempotency_key.is_none()
                    || !matches!(clock, Some("server" | "local"))))
            || (self.state == SpoolState::Unsent
                && (attempted
                    || self.last_http_status.is_some()
                    || self.last_error_code.is_some()
                    || self.receipt_sha256.is_some()
                    || self.server_event_id.is_some()
                    || self.server_object_id.is_some()
                    || self.resolution_note.is_some()))
            || (pending && !attempted)
        {
            return Err(
                "Spool item has contradictory attempt history; preserve its original key and reconcile before retrying.",
            );
        }
        Ok(())
    }

    /// Safe metadata projection — NEVER includes raw request body bytes.
    pub fn safe_summary_json(&self) -> Value {
        json!({
            "id": self.id,
            "origin": self.origin,
            "path": self.path,
            "session_id": self.session_id,
            "problem_id": self.problem_id,
            "state": self.state.as_str(),
            "idempotency_key": self.idempotency_key,
            "body_sha256": self.body_sha256,
            "client_occurred_at": self.client_occurred_at,
            "first_attempted_epoch_s": self.first_attempted_epoch_s,
            "first_attempted_clock": self.first_attempted_clock,
            "attempts": self.attempts,
            "last_http_status": self.last_http_status,
            "last_error_code": self.last_error_code,
            "receipt_sha256": self.receipt_sha256,
            "server_event_id": self.server_event_id,
            "server_object_id": self.server_object_id,
            "resolution_note": self.resolution_note,
            "reconciliation_commands": self.reconciliation_commands(),
        })
    }

    /// Read-only commands an operator or agent can run to determine whether an
    /// ambiguous write landed on the server before deciding how to resolve it.
    pub fn reconciliation_commands(&self) -> Vec<String> {
        let mut cmds = Vec::new();
        if let Some(sid) = &self.session_id {
            cmds.push(format!(
                "asimp --origin {} session status {sid} --json",
                self.origin
            ));
            if self.path.ends_with("/workshop") || self.path.ends_with("/promote") {
                cmds.push(format!(
                    "asimp --origin {} workshop list {sid} --json",
                    self.origin
                ));
            }
        }
        if let Some(pid) = &self.problem_id {
            cmds.push(format!(
                "asimp --origin {} watch {pid} --since 0 --once --json",
                self.origin
            ));
        }
        if cmds.is_empty() {
            cmds.push(format!("asimp --origin {} hello --json", self.origin));
        }
        cmds.push(format!(
            "asimp spool resolve {} --as committed --event-id <EV-ID>  # or --as abandoned --reason \"...\"",
            self.id
        ));
        cmds
    }
}

/// Hard allowlist of idempotency-keyed write paths safe to spool and replay.
/// Explicitly excludes ALL one-time exchanges (`/v1/fellows`, `/v1/enrollments*`,
/// `/v1/device*`, `/join/*`, `/v1/rebinds*`, etc.).
pub fn is_replay_safe_write_path(path: &str) -> bool {
    if !path.starts_with('/')
        || path.contains(['?', '#', '\\', '%'])
        || path.bytes().any(|b| b <= b' ' || b == 0x7f)
    {
        return false;
    }
    if path == "/v1/sessions" {
        return true;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 4 || segments[0] != "v1" || segments[1] != "sessions" {
        return false;
    }
    let session_id = segments[2];
    if !safe_session_segment(session_id) {
        return false;
    }
    match segments.as_slice() {
        ["v1", "sessions", _, action] => matches!(
            *action,
            "workshop"
                | "promote"
                | "review"
                | "evidence"
                | "revise"
                | "hypotheses"
                | "gaps"
                | "relations"
                | "close"
                | "heartbeat"
                | "leases"
                | "artifacts"
                | "dead-ends"
                | "citations"
                | "questions"
                | "retractions"
                | "syntheses"
                | "conflicts"
        ),
        ["v1", "sessions", _, "gaps", "close"] => true,
        ["v1", "sessions", _, "hypotheses", hyp, "kill"] => safe_session_segment(hyp),
        [
            "v1",
            "sessions",
            _,
            "leases",
            lease_ref,
            "release" | "challenge",
        ] => safe_session_segment(lease_ref),
        _ => false,
    }
}

fn infer_session_id(path: &str) -> Option<String> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() >= 3 && segments[0] == "v1" && segments[1] == "sessions" {
        let sid = segments[2];
        if safe_session_segment(sid) {
            return Some(sid.to_owned());
        }
    }
    None
}

pub fn resolve_spool_dir(explicit: Option<&PathBuf>) -> Result<PathBuf, String> {
    let path = match explicit {
        Some(dir) => dir.clone(),
        None => match std::env::var("ASIMP_SPOOL_DIR") {
            Ok(val) if !val.is_empty() => PathBuf::from(val),
            Ok(_) | Err(std::env::VarError::NotPresent) => {
                let home = std::env::var("HOME")
                    .map_err(|_| "Cannot resolve ~/.asimp/spool (HOME unset); pass --spool-dir or set ASIMP_SPOOL_DIR.".to_owned())?;
                PathBuf::from(home).join(".asimp").join("spool")
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("ASIMP_SPOOL_DIR must be valid UTF-8.".to_owned());
            }
        },
    };
    if path.as_os_str().is_empty() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Spool directory must be non-empty and contain no '..' components.".to_owned());
    }
    Ok(path)
}

fn ensure_private_dir(dir: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(dir).map_err(|_| "Cannot create spool directory.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

// Keep the lock file: the OS releases the advisory lock on close or process
// death. Removing it would let another process lock a different inode.
fn lock_spool_mutation(dir: &Path) -> Result<fs::File, &'static str> {
    ensure_private_dir(dir)?;
    let path = dir.join("write.lock");
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() => return Err("Spool lock is not a regular file."),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot inspect the spool lock."),
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|_| "Cannot open the spool lock.")?;
    file.try_lock().map_err(|_| {
        "Another spool writer is active or locking is unavailable; retry after it finishes."
    })?;
    Ok(file)
}

fn write_private_atomic(target: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let parent = target.parent().ok_or("Invalid spool target path.")?;
    ensure_private_dir(parent)?;
    if let Ok(meta) = fs::symlink_metadata(target)
        && !meta.is_file()
    {
        return Err("Refusing to write spool target that is not a regular file.");
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid spool target filename.")?;
    let seq = ATOMIC_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{name}.tmp.{}.{seq}.{nanos}", std::process::id()));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&tmp)
        .map_err(|_| "Cannot create temporary spool file.")?;
    if file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&tmp);
        return Err("Cannot write temporary spool file.");
    }
    drop(file);
    fs::rename(&tmp, target).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        "Cannot commit spool file atomically."
    })
}

/// Pure-Rust Unix epoch seconds -> RFC3339 UTC string (Howard Hinnant civil calendar).
pub fn format_utc_rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let rem = epoch_secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Parse an RFC 7231 IMF-fixdate HTTP `Date` header (e.g. `Sat, 21 Nov 2026 01:45:00 GMT`)
/// into Unix epoch seconds without external crates.
pub fn parse_http_date(header: &str) -> Option<u64> {
    let parts: Vec<&str> = header.split_whitespace().collect();
    if parts.len() != 6
        || !matches!(
            parts[0],
            "Mon," | "Tue," | "Wed," | "Thu," | "Fri," | "Sat," | "Sun,"
        )
        || parts[5] != "GMT"
        || parts[1].len() != 2
        || !parts[1].bytes().all(|b| b.is_ascii_digit())
        || parts[3].len() != 4
        || !parts[3].bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month: i64 = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    if !(1970..=9999).contains(&year) {
        return None;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    let time: Vec<&str> = parts[4].split(':').collect();
    if time.len() != 3
        || time
            .iter()
            .any(|part| part.len() != 2 || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let hour: u64 = time[0].parse().ok()?;
    let min: u64 = time[1].parse().ok()?;
    let sec: u64 = time[2].parse().ok()?;
    if !(1..=month_days).contains(&day) || hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    // Howard Hinnant days_from_civil
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400 + hour * 3_600 + min * 60 + sec)
}

pub fn now_epoch_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_safe_spool_id(id: &str) -> bool {
    let b = id.as_bytes();
    (4..=64).contains(&b.len())
        && b.starts_with(b"SP-")
        && b.iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn is_safe_idempotency_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256 && key.bytes().all(|b| (33..=126).contains(&b))
}

fn mint_spool_id(epoch_s: u64, body_sha256: &str, path: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seed = format!(
        "{epoch_s}:{nanos}:{}:{path}:{body_sha256}",
        std::process::id()
    );
    let digest = sha256_hex(seed.as_bytes());
    format!("SP-{epoch_s}-{}", &digest[..12])
}

fn mint_idempotency_key(item: &SpoolItem) -> String {
    let seed = format!(
        "asimp-spool-key:{}:{}:{}",
        item.id, item.path, item.body_sha256
    );
    let digest = sha256_hex(seed.as_bytes());
    format!("asimp-sp-{}-{}", item.id, &digest[..16])
}

/// Append one secret-redacted operational audit entry to `<spool>/logs/spool.jsonl`.
/// Verifies via `scrub::scan_field_for_credentials` that no credential bytes can
/// ever land in the log.
pub fn append_audit_log(spool_dir: &Path, entry: Value) {
    let logs_dir = spool_dir.join("logs");
    if ensure_private_dir(&logs_dir).is_err() {
        return;
    }
    let line = serde_json::to_string(&entry).unwrap_or_else(|_| "{}".to_owned());
    let safe_line = if scrub::scan_field_for_credentials("log", &line).is_empty() {
        line
    } else {
        serde_json::to_string(&json!({
            "timestamp": format_utc_rfc3339(now_epoch_s()),
            "event": "redacted_log_entry",
            "note": "Entry omitted by P7 credential scrubber.",
        }))
        .unwrap_or_else(|_| "{}".to_owned())
    };
    let log_path = logs_dir.join("spool.jsonl");
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut file) = opts.open(&log_path) {
        let _ = writeln!(file, "{safe_line}");
    }
}

fn read_item_file(path: &Path, expected_id: &str) -> Result<SpoolItem, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Cannot inspect a spool item; preserve the spool for recovery.".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_SPOOL_ITEM_BYTES {
        return Err("Spool item is not a bounded regular file; preserve it.".to_owned());
    }
    let file = fs::File::open(path)
        .map_err(|_| "Cannot read a spool item; preserve the spool for recovery.".to_owned())?;
    let mut raw = String::new();
    file.take(MAX_SPOOL_ITEM_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "Cannot read a complete spool item; preserve it for recovery.".to_owned())?;
    let item = SpoolItem::from_disk_json(&raw).map_err(str::to_owned)?;
    if item.id != expected_id {
        return Err("Spool item ID does not match its filename; no writes were sent.".to_owned());
    }
    Ok(item)
}

pub fn load_all_items(spool_dir: &Path) -> Result<Vec<SpoolItem>, String> {
    let items_dir = spool_dir.join("items");
    match fs::symlink_metadata(&items_dir) {
        Ok(meta) if !meta.is_dir() => {
            return Err("Spool items must be stored in a regular directory.".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot inspect the spool items directory.".to_owned()),
    }
    let entries = fs::read_dir(&items_dir)
        .map_err(|_| "Cannot read spool items directory; check permissions.".to_owned())?;
    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Cannot enumerate every spool item.".to_owned())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|id| is_safe_spool_id(id))
            .ok_or_else(|| "Spool item filename is invalid; preserve it for recovery.".to_owned())?;
        // Never turn malformed or unreadable work into an apparently empty
        // successful sync. Validate the whole queue before sending any write.
        items.push(read_item_file(&path, id)?);
    }
    items.sort_by(|a, b| {
        a.created_epoch_s
            .cmp(&b.created_epoch_s)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(items)
}

pub fn save_item(spool_dir: &Path, item: &SpoolItem) -> Result<(), &'static str> {
    if !is_safe_spool_id(&item.id) {
        return Err("Invalid spool item ID; no file was written.");
    }
    let target = spool_dir.join("items").join(format!("{}.json", item.id));
    let body = serde_json::to_string_pretty(&item.to_disk_json())
        .map_err(|_| "Cannot serialize spool item.")?;
    let raw = format!("{body}\n");
    write_private_atomic(&target, raw.as_bytes())
}

#[derive(Debug, Clone)]
pub struct SyncPostResponse {
    pub status: u16,
    pub body: String,
    pub server_epoch_s: Option<u64>,
    pub deprecation: Option<DeprecationNotice>,
}

#[derive(Debug)]
pub enum SyncPostError {
    Status {
        status: u16,
        code: Option<String>,
        server_epoch_s: Option<u64>,
    },
    ProtocolMismatch(ProtocolMismatch),
    Network {
        server_epoch_s: Option<u64>,
    },
}

/// Probe `/capabilities` to read authoritative server `Date` timestamp so
/// 24-hour replay-window checks are immune to local clock skew / sleep-wake.
fn probe_server_clock_http(origin: &str, protocol_version: &str) -> Option<u64> {
    let url = build_url(origin, "/capabilities").ok()?;
    let agent = ureq::AgentBuilder::new()
        .user_agent(OUTBOUND_USER_AGENT)
        .timeout(READ_TIMEOUT)
        .timeout_connect(READ_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .redirects(0)
        .build();
    let resp = agent
        .get(&url)
        .set(PROTOCOL_VERSION_HEADER, protocol_version)
        .set("cache-control", "no-cache, max-age=0")
        .call()
        .ok()?;
    if resp.status() != 200 {
        return None;
    }
    fresh_server_clock(resp.header("date"), resp.header("age"))
}

/// A cached Date is not a current clock sample. Revalidation is requested above;
/// if an intermediary still supplies an aged response, retain fresh-write support
/// without using that response to authorize an ambiguous retry.
pub(crate) fn fresh_server_clock(date: Option<&str>, age: Option<&str>) -> Option<u64> {
    if let Some(age) = age {
        let age = age.trim();
        if age.is_empty()
            || !age.bytes().all(|b| b.is_ascii_digit())
            || age.parse::<u64>().ok()? != 0
        {
            return None;
        }
    }
    date.and_then(parse_http_date)
}

fn post_spool_item_http(
    url: &str,
    token: &str,
    protocol_version: &str,
    idempotency_key: &str,
    client_occurred_at: &str,
    body_json: &str,
) -> Result<SyncPostResponse, SyncPostError> {
    let agent = ureq::AgentBuilder::new()
        .user_agent(OUTBOUND_USER_AGENT)
        .timeout(READ_TIMEOUT)
        .timeout_connect(READ_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .redirects(0)
        .build();
    let response = agent
        .post(url)
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json")
        .set("idempotency-key", idempotency_key)
        .set(PROTOCOL_VERSION_HEADER, protocol_version)
        .set(CLIENT_OCCURRED_AT_HEADER, client_occurred_at)
        .send_bytes(body_json.as_bytes());
    match response {
        Ok(resp) => {
            let status = resp.status();
            let server_epoch_s = resp.header("date").and_then(parse_http_date);
            let deprecation = inspect_success_headers(
                protocol_version,
                resp.header(PROTOCOL_VERSION_HEADER),
                resp.header("deprecation"),
                resp.header("sunset"),
                resp.header("link"),
            )
            .map_err(SyncPostError::ProtocolMismatch)?;
            let mut bytes = Vec::new();
            resp.into_reader()
                .take(crate::MAX_BODY_BYTES.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| SyncPostError::Network { server_epoch_s })?;
            if bytes.len() as u64 > crate::MAX_BODY_BYTES {
                return Err(SyncPostError::Network { server_epoch_s });
            }
            let body =
                String::from_utf8(bytes).map_err(|_| SyncPostError::Network { server_epoch_s })?;
            Ok(SyncPostResponse {
                status,
                body,
                server_epoch_s,
                deprecation,
            })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let server_epoch_s = resp.header("date").and_then(parse_http_date);
            let mut buf = Vec::new();
            let _ = resp.into_reader().take(16 * 1024).read_to_end(&mut buf);
            let text = std::str::from_utf8(&buf).ok();
            if code == 400
                && let Some(mismatch) =
                    parse_unsupported_version_problem(protocol_version, code, text)
            {
                return Err(SyncPostError::ProtocolMismatch(mismatch));
            }
            let err_code = text
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_owned))
                .filter(|c| {
                    !c.is_empty()
                        && c.len() <= 64
                        && c.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                });
            Err(SyncPostError::Status {
                status: code,
                code: err_code,
                server_epoch_s,
            })
        }
        Err(_) => Err(SyncPostError::Network {
            server_epoch_s: None,
        }),
    }
}

fn extract_safe_receipt_ids(body: &str) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return (None, None);
    };
    let safe_id = |k: &str| -> Option<String> {
        v.get(k)
            .and_then(Value::as_str)
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')
                    })
            })
            .map(str::to_owned)
    };
    let event_id = safe_id("event_id");
    let object_id = safe_id("claim_id")
        .or_else(|| safe_id("workshop_id"))
        .or_else(|| safe_id("review_id"))
        .or_else(|| safe_id("session_id"))
        .or_else(|| safe_id("object_id"));
    (event_id, object_id)
}

/// Core pure replay-window decision engine for `asimp sync`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayDecision {
    SendFresh,
    ReplayInWindow,
    AwaitServerClock,
    FreezeUnknownCommit,
    SkipCommitted,
    SkipRejected,
    SkipUnknownCommit,
}

pub fn decide_replay(
    item: &SpoolItem,
    effective_now_s: u64,
    server_time_available: bool,
) -> ReplayDecision {
    match item.state {
        SpoolState::Unsent => ReplayDecision::SendFresh,
        SpoolState::InFlight => {
            // A persisted local wall clock can jump during sleep, correction or
            // restart. Comparing it with a later server clock is also unsafe:
            // saturating a negative age to zero can reopen an expired write.
            // V1 has no durable monotonic anchor or clock-offset evidence.
            let has_server_attempt = item.first_attempted_clock.as_deref() == Some("server")
                && item.attempts > 0
                && item
                    .first_attempted_epoch_s
                    .is_some_and(|started| started <= MAX_SPOOL_EPOCH_SECONDS)
                && item
                    .idempotency_key
                    .as_deref()
                    .is_some_and(is_safe_idempotency_key);
            if !has_server_attempt {
                return ReplayDecision::FreezeUnknownCommit;
            }
            if !server_time_available {
                // A temporary probe failure is recoverable. Do not compare a
                // retained server timestamp with the local fallback or freeze it.
                return ReplayDecision::AwaitServerClock;
            }
            let age = item
                .first_attempted_epoch_s
                .and_then(|started| effective_now_s.checked_sub(started));
            if age.is_some_and(|age| age < REPLAY_WINDOW_SECONDS - REPLAY_SEND_MARGIN_SECONDS) {
                ReplayDecision::ReplayInWindow
            } else {
                ReplayDecision::FreezeUnknownCommit
            }
        }
        SpoolState::Committed => ReplayDecision::SkipCommitted,
        SpoolState::Rejected => ReplayDecision::SkipRejected,
        SpoolState::UnknownCommit => ReplayDecision::SkipUnknownCommit,
    }
}

pub fn run_spool(cli: &Cli) -> CliOutput {
    let Command::Spool(args) = &cli.command else {
        return input_error("Expected a spool subcommand.");
    };
    let command = &args.command;
    match command {
        SpoolCommand::Enqueue {
            path,
            file,
            idempotency_key,
            session,
            problem,
            spool_dir,
            json: json_out,
        } => {
            if !is_replay_safe_write_path(path) {
                return input_error(
                    "Refused: only idempotency-keyed session/ledger write paths (/v1/sessions...) may be spooled. One-time enrollment and token exchanges must never be spooled or auto-retried.",
                );
            }
            if let Some(key) = idempotency_key
                && !is_safe_idempotency_key(key)
            {
                return input_error(
                    "--idempotency-key must be a non-empty ASCII header value (<= 256 bytes, no spaces or controls).",
                );
            }
            if let Some(pid) = problem
                && !is_valid_problem_id(pid)
            {
                return input_error("--problem must match P-[A-Z0-9][A-Z0-9-]{1,30}.");
            }
            let origin = match resolve_origin(cli.origin.as_ref()) {
                Ok(o) => o,
                Err(msg) => return input_error(&msg),
            };
            if let Err(msg) = build_url(&origin, path) {
                return input_error(&msg);
            }
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let meta = match fs::metadata(file) {
                Ok(m) if m.is_file() => m,
                _ => {
                    return input_error(
                        "Cannot read --file; supply an accessible regular UTF-8 JSON file.",
                    );
                }
            };
            if meta.len() > MAX_SPOOL_BODY_BYTES {
                return input_error("Request file exceeds the 512 KiB Worker bound.");
            }
            let raw_bytes = match fs::File::open(file).and_then(|f| {
                let mut buf = Vec::new();
                f.take(MAX_SPOOL_BODY_BYTES.saturating_add(1))
                    .read_to_end(&mut buf)?;
                Ok(buf)
            }) {
                Ok(b) => b,
                Err(_) => return input_error("Cannot read --file."),
            };
            if raw_bytes.len() as u64 > MAX_SPOOL_BODY_BYTES {
                return input_error("Request file exceeds the 512 KiB Worker bound.");
            }
            let raw = match String::from_utf8(raw_bytes) {
                Ok(s) => s,
                Err(_) => return input_error("Cannot read --file as UTF-8."),
            };
            let parsed: Value = match serde_json::from_str::<Value>(&raw) {
                Ok(v) if v.is_object() => v,
                _ => return input_error("Spooled request --file must be a valid JSON object."),
            };
            // P7 pre-spool scrub: never write secret-shaped bodies into durable spool.
            let findings = scrub::scan_field_for_credentials("request", &raw);
            if !findings.is_empty() {
                let redacted: Vec<Value> = findings
                    .iter()
                    .map(|f| {
                        json!({
                            "path": f.path,
                            "kind": f.kind.as_str(),
                            "line": f.line,
                            "column": f.column,
                        })
                    })
                    .collect();
                return CliOutput {
                    exit_code: 1,
                    stdout: if *json_out {
                        format!(
                            "{}\n",
                            serde_json::to_string_pretty(&json!({
                                "schema": "asimp.spool.v1",
                                "ok": false,
                                "code": "SECRET_SHAPED_CONTENT",
                                "rule": "P7",
                                "findings": redacted,
                            }))
                            .unwrap_or_default()
                        )
                    } else {
                        String::new()
                    },
                    stderr: if *json_out {
                        String::new()
                    } else {
                        format!(
                            "asimp spool: refused to spool payload carrying {} P7 secret-shaped finding(s). Run `asimp scrub` and remove credentials first.\n",
                            findings.len()
                        )
                    },
                };
            }

            let canon = match canonical_json(&parsed) {
                Ok(c) => c,
                Err(_) => return input_error("Cannot canonicalize JSON request."),
            };
            let body_sha256 = sha256_hex(canon.as_bytes());
            let epoch = now_epoch_s();
            let id = mint_spool_id(epoch, &body_sha256, path);
            let item = SpoolItem {
                id: id.clone(),
                origin,
                path: path.clone(),
                session_id: session.clone().or_else(|| infer_session_id(path)),
                problem_id: problem.clone(),
                state: SpoolState::Unsent,
                idempotency_key: idempotency_key.clone(),
                body_json: raw,
                body_sha256: body_sha256.clone(),
                client_occurred_at: format_utc_rfc3339(epoch),
                created_epoch_s: epoch,
                first_attempted_epoch_s: None,
                first_attempted_clock: None,
                attempts: 0,
                last_http_status: None,
                last_error_code: None,
                receipt_sha256: None,
                server_event_id: None,
                server_object_id: None,
                resolution_note: None,
            };
            if let Err(msg) = save_item(&dir, &item) {
                return input_error(msg);
            }
            append_audit_log(
                &dir,
                json!({
                    "timestamp": item.client_occurred_at,
                    "action": "enqueue",
                    "item_id": item.id,
                    "path": item.path,
                    "state": item.state.as_str(),
                    "body_sha256": body_sha256,
                }),
            );
            CliOutput {
                exit_code: 0,
                stdout: if *json_out {
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(&json!({
                            "schema": "asimp.spool.v1",
                            "ok": true,
                            "item": item.safe_summary_json(),
                        }))
                        .unwrap_or_default()
                    )
                } else {
                    format!(
                        "asimp spool: enqueued {} ({}) state=unsent client_occurred_at={}\nRun `asimp sync` when ready to drain.\n",
                        item.id, item.path, item.client_occurred_at
                    )
                },
                stderr: String::new(),
            }
        }
        SpoolCommand::List {
            state,
            spool_dir,
            json: json_out,
        } => {
            let filter = match state {
                Some(s) => match SpoolState::parse(s) {
                    Some(parsed) => Some(parsed),
                    None => {
                        return input_error(
                            "--state must be one of: unsent, in_flight, committed, rejected, unknown_commit.",
                        );
                    }
                },
                None => None,
            };
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let items = match load_all_items(&dir) {
                Ok(list) => list,
                Err(msg) => return input_error(&msg),
            };
            let filtered: Vec<&SpoolItem> = items
                .iter()
                .filter(|item| filter.is_none_or(|f| item.state == f))
                .collect();
            if *json_out {
                let summaries: Vec<Value> = filtered
                    .iter()
                    .map(|item| item.safe_summary_json())
                    .collect();
                return CliOutput {
                    exit_code: 0,
                    stdout: format!(
                        "{}\n",
                        serde_json::to_string_pretty(&json!({
                            "schema": "asimp.spool-list.v1",
                            "count": summaries.len(),
                            "items": summaries,
                        }))
                        .unwrap_or_default()
                    ),
                    stderr: String::new(),
                };
            }
            if filtered.is_empty() {
                return CliOutput {
                    exit_code: 0,
                    stdout: "asimp spool: no matching items.\n".to_owned(),
                    stderr: String::new(),
                };
            }
            let mut out = String::new();
            for item in filtered {
                out.push_str(&format!(
                    "{}  {:14}  {}  attempts={}  occurred={}\n",
                    item.id,
                    item.state.as_str(),
                    item.path,
                    item.attempts,
                    item.client_occurred_at
                ));
            }
            CliOutput {
                exit_code: 0,
                stdout: out,
                stderr: String::new(),
            }
        }
        SpoolCommand::Show {
            id,
            spool_dir,
            json: json_out,
        } => {
            if !is_safe_spool_id(id) {
                return input_error("Invalid spool item ID.");
            }
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let path = dir.join("items").join(format!("{id}.json"));
            let item = match read_item_file(&path, id) {
                Ok(item) => item,
                Err(msg) => return input_error(&msg),
            };
            CliOutput {
                exit_code: 0,
                stdout: if *json_out {
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(&item.safe_summary_json()).unwrap_or_default()
                    )
                } else {
                    let mut s = format!(
                        "id: {}\nstate: {}\norigin: {}\npath: {}\nbody_sha256: {}\nclient_occurred_at: {}\nattempts: {}\n",
                        item.id,
                        item.state.as_str(),
                        item.origin,
                        item.path,
                        item.body_sha256,
                        item.client_occurred_at,
                        item.attempts
                    );
                    if let Some(key) = &item.idempotency_key {
                        s.push_str(&format!("idempotency_key: {key}\n"));
                    }
                    if let Some(ev) = &item.server_event_id {
                        s.push_str(&format!("server_event_id: {ev}\n"));
                    }
                    s.push_str("reconciliation:\n");
                    for cmd in item.reconciliation_commands() {
                        s.push_str(&format!("  {cmd}\n"));
                    }
                    s
                },
                stderr: String::new(),
            }
        }
        SpoolCommand::Resolve {
            id,
            resolution,
            event_id,
            reason,
            spool_dir,
            json: json_out,
        } => {
            if !is_safe_spool_id(id) {
                return input_error("Invalid spool item ID.");
            }
            let new_state = match resolution.as_str() {
                "committed" => {
                    if event_id
                        .as_deref()
                        .is_none_or(|e| e.trim().is_empty() || e.len() > 128)
                    {
                        return input_error(
                            "--as committed requires --event-id <EV-ID> from a read-only server check.",
                        );
                    }
                    SpoolState::Committed
                }
                "abandoned" => SpoolState::Rejected,
                _ => return input_error("--as must be `committed` or `abandoned`."),
            };
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let _lock = match lock_spool_mutation(&dir) {
                Ok(lock) => lock,
                Err(msg) => return input_error(msg),
            };
            let path = dir.join("items").join(format!("{id}.json"));
            let mut item = match read_item_file(&path, id) {
                Ok(item) => item,
                Err(msg) => return input_error(&msg),
            };
            if item.state == SpoolState::Committed {
                return input_error("Spool item is already committed.");
            }
            item.state = new_state;
            if let Some(ev) = event_id {
                item.server_event_id = Some(ev.clone());
            }
            item.resolution_note = Some(
                reason
                    .clone()
                    .unwrap_or_else(|| format!("explicitly resolved as {resolution}")),
            );
            if let Err(msg) = save_item(&dir, &item) {
                return input_error(msg);
            }
            append_audit_log(
                &dir,
                json!({
                    "timestamp": format_utc_rfc3339(now_epoch_s()),
                    "action": "resolve",
                    "item_id": item.id,
                    "state": item.state.as_str(),
                    "server_event_id": item.server_event_id,
                }),
            );
            CliOutput {
                exit_code: 0,
                stdout: if *json_out {
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(&json!({
                            "schema": "asimp.spool-resolve.v1",
                            "ok": true,
                            "item": item.safe_summary_json(),
                        }))
                        .unwrap_or_default()
                    )
                } else {
                    format!(
                        "asimp spool: resolved {} as {}\n",
                        item.id,
                        item.state.as_str()
                    )
                },
                stderr: String::new(),
            }
        }
        SpoolCommand::CursorSet {
            problem,
            cursor,
            spool_dir,
            json: json_out,
        } => {
            if !is_valid_problem_id(problem) {
                return input_error("Problem ID must match P-[A-Z0-9][A-Z0-9-]{1,30}.");
            }
            if *cursor > 9_007_199_254_740_991 {
                return input_error("Cursor must be a JavaScript-safe non-negative integer.");
            }
            let origin = match resolve_origin(cli.origin.as_ref()) {
                Ok(o) => o,
                Err(msg) => return input_error(&msg),
            };
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let record = json!({
                "schema": "asimp.cursor.v1",
                "problem_id": problem,
                "origin": origin,
                "cursor": cursor,
                "updated_at": format_utc_rfc3339(now_epoch_s()),
            });
            let target = dir.join("cursors").join(format!("{problem}.json"));
            let raw = format!(
                "{}\n",
                serde_json::to_string_pretty(&record).unwrap_or_default()
            );
            if let Err(msg) = write_private_atomic(&target, raw.as_bytes()) {
                return input_error(msg);
            }
            CliOutput {
                exit_code: 0,
                stdout: if *json_out {
                    raw
                } else {
                    format!("asimp spool: saved cursor {problem} = {cursor}\n")
                },
                stderr: String::new(),
            }
        }
        SpoolCommand::Cursors {
            spool_dir,
            json: json_out,
        } => {
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let cursors_dir = dir.join("cursors");
            let mut records = Vec::new();
            if let Ok(entries) = fs::read_dir(&cursors_dir) {
                for entry in entries.flatten() {
                    if let Ok(raw) = fs::read_to_string(entry.path())
                        && let Ok(val) = serde_json::from_str::<Value>(&raw)
                    {
                        records.push(val);
                    }
                }
            }
            records.sort_by(|a, b| {
                a.get("problem_id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("problem_id").and_then(Value::as_str))
            });
            if *json_out {
                return CliOutput {
                    exit_code: 0,
                    stdout: format!(
                        "{}\n",
                        serde_json::to_string_pretty(&json!({
                            "schema": "asimp.cursors.v1",
                            "cursors": records,
                        }))
                        .unwrap_or_default()
                    ),
                    stderr: String::new(),
                };
            }
            if records.is_empty() {
                return CliOutput {
                    exit_code: 0,
                    stdout: "asimp spool: no saved problem cursors.\n".to_owned(),
                    stderr: String::new(),
                };
            }
            let mut out = String::new();
            for rec in records {
                out.push_str(&format!(
                    "{}  cursor={}  updated={}\n",
                    rec.get("problem_id").and_then(Value::as_str).unwrap_or("?"),
                    rec.get("cursor").and_then(Value::as_u64).unwrap_or(0),
                    rec.get("updated_at").and_then(Value::as_str).unwrap_or("?")
                ));
            }
            CliOutput {
                exit_code: 0,
                stdout: out,
                stderr: String::new(),
            }
        }
        SpoolCommand::ArtifactTrack {
            file,
            session,
            upload_id,
            uploaded_bytes,
            spool_dir,
            json: json_out,
        } => {
            if !safe_session_segment(session) {
                return input_error("Session ID must be one origin-relative path component.");
            }
            let dir = match resolve_spool_dir(spool_dir.as_ref()) {
                Ok(d) => d,
                Err(msg) => return input_error(&msg),
            };
            let meta = match fs::metadata(file) {
                Ok(m) if m.is_file() => m,
                _ => return input_error("Artifact --file must be an accessible regular file."),
            };
            if meta.len() > 64 * 1024 * 1024 {
                return input_error("Artifact exceeds 64 MiB CLI tracking bound.");
            }
            let bytes = match fs::read(file) {
                Ok(b) => b,
                Err(_) => return input_error("Cannot read artifact file."),
            };
            if *uploaded_bytes > bytes.len() as u64 {
                return input_error("--uploaded-bytes cannot exceed the file's exact byte length.");
            }
            // Scan UTF-8 text artifacts with CAS P7 + personal-address scanner before tracking.
            if let Ok(text) = std::str::from_utf8(&bytes) {
                let findings = scrub::scan_body_for_secrets(text);
                if !findings.is_empty() {
                    return CliOutput {
                        exit_code: 1,
                        stdout: String::new(),
                        stderr: format!(
                            "asimp spool: refused artifact tracking — detected {} secret/PII finding(s). Run `asimp scrub --mode artifact` first.\n",
                            findings.len()
                        ),
                    };
                }
            }
            let digest = sha256_hex(&bytes);
            let state = if *uploaded_bytes == bytes.len() as u64 {
                "uploaded_pending_commit"
            } else {
                "resumable"
            };
            let record = json!({
                "schema": "asimp.spool-artifact.v1",
                "sha256": digest,
                "size_bytes": bytes.len(),
                "uploaded_bytes": uploaded_bytes,
                "session_id": session,
                "upload_id": upload_id,
                "state": state,
                "updated_at": format_utc_rfc3339(now_epoch_s()),
            });
            let target = dir.join("artifacts").join(format!("{digest}.json"));
            let raw = format!(
                "{}\n",
                serde_json::to_string_pretty(&record).unwrap_or_default()
            );
            if let Err(msg) = write_private_atomic(&target, raw.as_bytes()) {
                return input_error(msg);
            }
            append_audit_log(
                &dir,
                json!({
                    "timestamp": format_utc_rfc3339(now_epoch_s()),
                    "action": "artifact_track",
                    "sha256": digest,
                    "size_bytes": bytes.len(),
                    "uploaded_bytes": uploaded_bytes,
                    "state": state,
                }),
            );
            CliOutput {
                exit_code: 0,
                stdout: if *json_out {
                    raw
                } else {
                    format!(
                        "asimp spool: tracked resumable artifact sha256={digest} ({}/{}) state={state}\n",
                        uploaded_bytes,
                        bytes.len()
                    )
                },
                stderr: String::new(),
            }
        }
    }
}

pub fn run_sync(cli: &Cli) -> CliOutput {
    let Command::Sync(args) = &cli.command else {
        return input_error("Expected the sync command.");
    };
    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(o) => o,
        Err(msg) => return input_error(&msg),
    };
    let protocol_version = match resolve_protocol_version(cli.protocol_version.as_ref()) {
        Ok(v) => v,
        Err(msg) => return input_error(&msg),
    };
    let token = if args.dry_run {
        None
    } else {
        match std::env::var("ASIMP_TOKEN") {
            Ok(val)
                if !val.is_empty()
                    && val.len() <= 4096
                    && val.bytes().all(|b| (33..=126).contains(&b)) =>
            {
                Some(val)
            }
            Ok(_) => {
                return input_error(
                    "ASIMP_TOKEN must be a non-empty bearer value without spaces or control characters.",
                );
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                return input_error("ASIMP_TOKEN must be valid UTF-8.");
            }
            Err(std::env::VarError::NotPresent) => match enrollment::stored_token(cli) {
                Ok(Some(t)) => Some(t),
                Ok(None) => {
                    return input_error(
                        "Set ASIMP_TOKEN or enroll a Fellow in your OS keychain before running `asimp sync`.",
                    );
                }
                Err(msg) => return input_error(msg),
            },
        }
    };
    let server_clock = probe_server_clock_http(&origin, &protocol_version);
    run_sync_with_io(
        cli,
        &origin,
        &protocol_version,
        token.as_deref(),
        server_clock,
        now_epoch_s(),
        post_spool_item_http,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_sync_with_io(
    cli: &Cli,
    origin: &str,
    protocol_version: &str,
    token: Option<&str>,
    server_epoch_s: Option<u64>,
    local_epoch_s: u64,
    mut post: impl FnMut(&str, &str, &str, &str, &str, &str) -> Result<SyncPostResponse, SyncPostError>,
) -> CliOutput {
    let Command::Sync(args) = &cli.command else {
        return input_error("Expected the sync command.");
    };
    let dir = match resolve_spool_dir(args.spool_dir.as_ref()) {
        Ok(d) => d,
        Err(msg) => return input_error(&msg),
    };
    if let Some(id) = &args.item
        && !is_safe_spool_id(id)
    {
        return input_error("Invalid --item spool ID.");
    }
    let clock_started = Instant::now();
    let _lock = if args.dry_run {
        None
    } else {
        match lock_spool_mutation(&dir) {
            Ok(lock) => Some(lock),
            Err(msg) => return input_error(msg),
        }
    };
    let mut items = match load_all_items(&dir) {
        Ok(list) => list,
        Err(msg) => return input_error(&msg),
    };
    if args
        .item
        .as_ref()
        .is_some_and(|id| !items.iter().any(|item| &item.id == id && item.origin == origin))
    {
        return input_error("Selected spool item is absent for this origin; no writes were sent.");
    }

    let effective_now = server_epoch_s.unwrap_or(local_epoch_s);
    let clock_source = if server_epoch_s.is_some() {
        "server"
    } else {
        "local"
    };

    let mut committed = 0usize;
    let mut rejected = 0usize;
    let mut in_flight = 0usize;
    let mut awaiting_server_clock = 0usize;
    let mut unknown_commit = 0usize;
    let mut skipped = 0usize;
    let mut outcomes: Vec<Value> = Vec::new();
    let mut stderr_notices = String::new();
    let mut fatal_protocol: Option<ProtocolMismatch> = None;

    for item in &mut items {
        // The server sample predates queue loading and earlier network writes.
        // Account for that elapsed time before each replay decision.
        let effective_now = effective_now.saturating_add(clock_started.elapsed().as_secs());
        if let Some(target_id) = &args.item
            && &item.id != target_id
        {
            continue;
        }
        if item.origin != origin {
            skipped += 1;
            continue;
        }
        // Hard replay-safety wall: even if a spool file was edited on disk, never
        // auto-retry a non-allowlisted path (e.g. enrollment/token exchange).
        if !is_replay_safe_write_path(&item.path) {
            if !args.dry_run {
                item.state = SpoolState::Rejected;
                item.last_error_code = Some("NON_REPLAYABLE_PATH".to_owned());
                if let Err(msg) = save_item(&dir, item) {
                    return input_error(msg);
                }
            }
            rejected += 1;
            outcomes.push(json!({
                "id": item.id,
                "action": if args.dry_run { "would_refuse_non_replayable" } else { "refused_non_replayable" },
                "state": "rejected",
            }));
            continue;
        }

        let decision = decide_replay(item, effective_now, server_epoch_s.is_some());
        match decision {
            ReplayDecision::SkipCommitted
            | ReplayDecision::SkipRejected
            | ReplayDecision::SkipUnknownCommit => {
                skipped += 1;
                if item.state == SpoolState::UnknownCommit {
                    unknown_commit += 1;
                }
                continue;
            }
            ReplayDecision::AwaitServerClock => {
                in_flight += 1;
                awaiting_server_clock += 1;
                outcomes.push(json!({
                    "id": item.id,
                    "action": "awaiting_server_clock",
                    "state": "in_flight",
                    "remediation": "Retry asimp sync when a fresh server clock is available; the original body, key and attempt history are unchanged.",
                }));
                continue;
            }
            ReplayDecision::FreezeUnknownCommit => {
                if !args.dry_run {
                    item.state = SpoolState::UnknownCommit;
                    if let Err(msg) = save_item(&dir, item) {
                        return input_error(msg);
                    }
                    append_audit_log(
                        &dir,
                        json!({
                            "timestamp": format_utc_rfc3339(effective_now),
                            "action": "freeze_unknown_commit",
                            "item_id": item.id,
                            "state": "unknown_commit",
                            "clock_source": clock_source,
                        }),
                    );
                }
                unknown_commit += 1;
                outcomes.push(json!({
                    "id": item.id,
                    "action": if args.dry_run { "would_freeze_unknown_commit" } else { "frozen_unknown_commit" },
                    "state": "unknown_commit",
                    "reconciliation_commands": item.reconciliation_commands(),
                }));
                continue;
            }
            ReplayDecision::SendFresh | ReplayDecision::ReplayInWindow => {
                if args.dry_run {
                    outcomes.push(json!({
                        "id": item.id,
                        "action": if decision == ReplayDecision::SendFresh { "would_send_fresh" } else { "would_replay_same_key" },
                        "state": item.state.as_str(),
                        "idempotency_key": item.idempotency_key,
                    }));
                    continue;
                }
                let Some(tok) = token else {
                    return input_error("Missing Fellow bearer token for sync.");
                };
                // Assign idempotency key ONLY if never attempted; NEVER rotate an existing key!
                if item.state == SpoolState::Unsent && item.idempotency_key.is_none() {
                    item.idempotency_key = Some(mint_idempotency_key(item));
                }
                let Some(key) = item.idempotency_key.clone() else {
                    return input_error(
                        "Attempted spool write has no retained key; preserve it and reconcile without resubmitting.",
                    );
                };
                let url = match build_url(origin, &item.path) {
                    Ok(u) => u,
                    Err(_) => {
                        item.state = SpoolState::Rejected;
                        item.last_error_code = Some("INVALID_URL".to_owned());
                        if let Err(msg) = save_item(&dir, item) {
                            return input_error(msg);
                        }
                        rejected += 1;
                        continue;
                    }
                };

                // DURABILITY BARRIER: persist `in_flight` + exact key + `first_attempted_epoch_s`
                // BEFORE sending bytes over the wire so a mid-flight kill NEVER loses the key!
                if item.first_attempted_epoch_s.is_none() {
                    // Keep the original lower-bound sample: advancing it could
                    // extend a later replay window beyond the server's expiry.
                    item.first_attempted_epoch_s = Some(server_epoch_s.unwrap_or(local_epoch_s));
                    item.first_attempted_clock = Some(clock_source.to_owned());
                }
                item.state = SpoolState::InFlight;
                item.attempts = item.attempts.saturating_add(1);
                if let Err(msg) = save_item(&dir, item) {
                    return input_error(msg);
                }

                match post(
                    &url,
                    tok,
                    protocol_version,
                    &key,
                    &item.client_occurred_at,
                    &item.body_json,
                ) {
                    Ok(resp) => {
                        let valid_receipt = (200..=299).contains(&resp.status)
                            && resp.body.len() as u64 <= crate::MAX_BODY_BYTES
                            && serde_json::from_str::<Value>(&resp.body)
                                .ok()
                                .is_some_and(|value| {
                                    value.is_object()
                                        && value.get("ok").and_then(Value::as_bool) != Some(false)
                                });
                        if !valid_receipt {
                            // The write may have committed despite a truncated,
                            // malformed or contradictory success response.
                            item.last_http_status = (100..=599)
                                .contains(&resp.status)
                                .then_some(resp.status);
                            item.last_error_code = Some("RECEIPT_UNAVAILABLE".to_owned());
                            if let Err(msg) = save_item(&dir, item) {
                                return input_error(msg);
                            }
                            in_flight += 1;
                            outcomes.push(json!({
                                "id": item.id,
                                "action": "ambiguous_receipt_retained_key",
                                "state": "in_flight",
                            }));
                            continue;
                        }
                        if let Some(notice) = resp.deprecation {
                            stderr_notices.push_str(&notice.render_stderr());
                        }
                        let (ev_id, obj_id) = extract_safe_receipt_ids(&resp.body);
                        item.state = SpoolState::Committed;
                        item.last_http_status = Some(resp.status);
                        item.last_error_code = None;
                        item.receipt_sha256 = Some(sha256_hex(resp.body.as_bytes()));
                        item.server_event_id = ev_id;
                        item.server_object_id = obj_id;
                        if let Err(msg) = save_item(&dir, item) {
                            return input_error(msg);
                        }
                        append_audit_log(
                            &dir,
                            json!({
                                "timestamp": format_utc_rfc3339(resp.server_epoch_s.unwrap_or(effective_now)),
                                "action": "sync_committed",
                                "item_id": item.id,
                                "http_status": resp.status,
                                "server_event_id": item.server_event_id,
                                "receipt_sha256": item.receipt_sha256,
                            }),
                        );
                        committed += 1;
                        outcomes.push(json!({
                            "id": item.id,
                            "action": "committed",
                            "state": "committed",
                            "http_status": resp.status,
                            "server_event_id": item.server_event_id,
                            "server_object_id": item.server_object_id,
                        }));
                    }
                    Err(SyncPostError::ProtocolMismatch(mismatch)) => {
                        fatal_protocol = Some(mismatch);
                        break;
                    }
                    Err(SyncPostError::Status {
                        status,
                        code,
                        server_epoch_s: resp_clock,
                    }) => {
                        item.last_http_status = Some(status);
                        item.last_error_code = code.clone();
                        // Transient 408 (Request Timeout), 425 (Too Early), 429 (Rate Limit),
                        // 5xx, and IDEMPOTENCY_IN_FLIGHT stay `in_flight` with the SAME key.
                        let definitive_reject = matches!(status, 400..=499)
                            && !matches!(status, 408 | 425 | 429)
                            && code.as_deref() != Some("IDEMPOTENCY_IN_FLIGHT");
                        if definitive_reject {
                            item.state = SpoolState::Rejected;
                            rejected += 1;
                        } else {
                            // 429, 5xx, or IDEMPOTENCY_IN_FLIGHT stays in_flight with SAME key.
                            item.state = SpoolState::InFlight;
                            in_flight += 1;
                        }
                        if let Err(msg) = save_item(&dir, item) {
                            return input_error(msg);
                        }
                        append_audit_log(
                            &dir,
                            json!({
                                "timestamp": format_utc_rfc3339(resp_clock.unwrap_or(effective_now)),
                                "action": if definitive_reject { "sync_rejected" } else { "sync_retryable_status" },
                                "item_id": item.id,
                                "http_status": status,
                                "error_code": code,
                                "state": item.state.as_str(),
                            }),
                        );
                        outcomes.push(json!({
                            "id": item.id,
                            "action": if definitive_reject { "rejected" } else { "retryable" },
                            "state": item.state.as_str(),
                            "http_status": status,
                            "error_code": code,
                        }));
                    }
                    Err(SyncPostError::Network {
                        server_epoch_s: resp_clock,
                    }) => {
                        item.state = SpoolState::InFlight;
                        item.last_error_code = Some("NETWORK_AMBIGUOUS".to_owned());
                        if let Err(msg) = save_item(&dir, item) {
                            return input_error(msg);
                        }
                        append_audit_log(
                            &dir,
                            json!({
                                "timestamp": format_utc_rfc3339(resp_clock.unwrap_or(effective_now)),
                                "action": "sync_network_ambiguous",
                                "item_id": item.id,
                                "state": "in_flight",
                            }),
                        );
                        in_flight += 1;
                        outcomes.push(json!({
                            "id": item.id,
                            "action": "ambiguous_network_retained_key",
                            "state": "in_flight",
                            "idempotency_key": item.idempotency_key,
                        }));
                    }
                }
            }
        }
    }

    if let Some(mismatch) = fatal_protocol {
        return CliOutput {
            exit_code: 2,
            stdout: String::new(),
            stderr: format!("{stderr_notices}{}", mismatch.render_stderr()),
        };
    }

    let clean = rejected == 0 && in_flight == 0 && unknown_commit == 0;
    let summary = json!({
        "schema": "asimp.sync.v1",
        "ok": clean,
        "dry_run": args.dry_run,
        "origin": origin,
        "clock_source": clock_source,
        "effective_time": format_utc_rfc3339(effective_now),
        "committed": committed,
        "in_flight": in_flight,
        "awaiting_server_clock": awaiting_server_clock,
        "rejected": rejected,
        "unknown_commit": unknown_commit,
        "skipped": skipped,
        "outcomes": outcomes,
    });

    if args.json {
        return CliOutput {
            exit_code: if clean { 0 } else { 1 },
            stdout: format!(
                "{}\n",
                serde_json::to_string_pretty(&summary).unwrap_or_default()
            ),
            stderr: stderr_notices,
        };
    }

    let mut out = format!(
        "asimp sync ({origin}, clock={clock_source}): committed={committed} in_flight={in_flight} rejected={rejected} unknown_commit={unknown_commit} skipped={skipped}\n"
    );
    if awaiting_server_clock > 0 {
        out.push_str(
            "  WAITING: a fresh server clock is unavailable. Retry `asimp sync` when connectivity returns; attempted writes retain their original body, key and history.\n",
        );
    }
    if unknown_commit > 0 {
        out.push_str(
            "  ACTION REQUIRED: one or more attempted writes have an expired or unverifiable server replay window (state=unknown_commit). Run `asimp spool show <ID>` for read-only reconciliation commands; never rotate keys blindly.\n",
        );
    }
    CliOutput {
        exit_code: if clean { 0 } else { 1 },
        stdout: out,
        stderr: stderr_notices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "asimp-spool-{label}-{}-{}-{}",
            std::process::id(),
            now_epoch_s(),
            ATOMIC_TMP_SEQ.fetch_add(1, Ordering::Relaxed),
        ))
    }

    fn test_item() -> SpoolItem {
        SpoolItem {
            id: "SP-1000-recovery".into(),
            origin: "https://example.test".into(),
            path: "/v1/sessions/S-1/promote".into(),
            session_id: Some("S-1".into()),
            problem_id: Some("P-4DSP".into()),
            state: SpoolState::Unsent,
            idempotency_key: None,
            body_json: " { \"workshop_id\" : \"W-1\" }\n".into(),
            body_sha256: sha256_hex(br#"{"workshop_id":"W-1"}"#),
            client_occurred_at: format_utc_rfc3339(1_000),
            created_epoch_s: 1_000,
            first_attempted_epoch_s: None,
            first_attempted_clock: None,
            attempts: 0,
            last_http_status: None,
            last_error_code: None,
            receipt_sha256: None,
            server_event_id: None,
            server_object_id: None,
            resolution_note: None,
        }
    }

    fn test_sync_cli(dir: &Path) -> Cli {
        Cli {
            origin: Some("https://example.test".into()),
            identity: "default".into(),
            protocol_version: None,
            pop_key: None,
            command: Command::Sync(Box::new(SyncArgs {
                spool_dir: Some(dir.to_owned()),
                item: None,
                dry_run: false,
                json: true,
            })),
        }
    }

    #[test]
    fn persisted_items_require_exact_digest_key_and_attempt_history() {
        let mut item = test_item();
        item.state = SpoolState::InFlight;
        item.idempotency_key = Some("original-key".into());
        item.first_attempted_epoch_s = Some(2_000);
        item.first_attempted_clock = Some("server".into());
        item.attempts = 1;
        let valid = item.to_disk_json();
        assert!(SpoolItem::from_disk_json(&valid.to_string()).is_ok());
        for (field, value) in [
            ("id", json!("../escape")),
            ("body_json", json!("{\"workshop_id\":\"W-changed\"}")),
            ("body_sha256", json!("0".repeat(64))),
            ("attempts", json!(u64::MAX)),
            ("attempts", json!(0)),
            ("idempotency_key", Value::Null),
            ("idempotency_key", json!("bad\nheader")),
            ("first_attempted_epoch_s", Value::Null),
            ("first_attempted_clock", Value::Null),
            ("first_attempted_clock", json!("invented")),
            ("state", json!("unsent")),
        ] {
            let mut corrupt = valid.clone();
            corrupt[field] = value;
            assert!(
                SpoolItem::from_disk_json(&corrupt.to_string()).is_err(),
                "must refuse contradictory {field}"
            );
        }
        let mut unsent_with_history = test_item().to_disk_json();
        unsent_with_history["last_http_status"] = json!(422);
        assert!(SpoolItem::from_disk_json(&unsent_with_history.to_string()).is_err());
    }

    #[test]
    fn sync_preserves_corrupt_queue_and_refuses_before_any_post() {
        let mut missing_key = test_item();
        missing_key.id = "SP-2000-corrupt".into();
        missing_key.state = SpoolState::InFlight;
        missing_key.attempts = 1;
        missing_key.first_attempted_epoch_s = Some(2_000);
        missing_key.first_attempted_clock = Some("server".into());
        for (label, raw) in [
            ("truncated", "{\"schema\":".to_owned()),
            ("mismatched-id", test_item().to_disk_json().to_string()),
            ("lost-key", missing_key.to_disk_json().to_string()),
        ] {
            let dir = test_dir(label);
            save_item(&dir, &test_item()).unwrap();
            let corrupt_path = dir.join("items/SP-2000-corrupt.json");
            fs::write(&corrupt_path, &raw).unwrap();
            let before = fs::read(&corrupt_path).unwrap();
            let out = run_sync_with_io(
                &test_sync_cli(&dir),
                "https://example.test",
                "0.2.0-draft",
                Some("token-placeholder"),
                Some(2_000),
                2_000,
                |_, _, _, _, _, _| panic!("corrupt queue must not send even valid items"),
            );
            assert_eq!(out.exit_code, 2);
            assert_eq!(fs::read(&corrupt_path).unwrap(), before);
            assert!(!out.stdout.contains("workshop_id"));
        }
    }

    #[test]
    fn replay_requires_comparable_server_time_and_request_margin() {
        let mut item = test_item();
        item.state = SpoolState::InFlight;
        item.idempotency_key = Some("original-key".into());
        item.first_attempted_epoch_s = Some(2_000);
        item.first_attempted_clock = Some("server".into());
        item.attempts = 1;
        assert_eq!(decide_replay(&item, 2_001, true), ReplayDecision::ReplayInWindow);
        for now in [1_999, 2_001, 2_000 + REPLAY_WINDOW_SECONDS] {
            assert_eq!(
                decide_replay(&item, now, false),
                ReplayDecision::AwaitServerClock
            );
        }
        for (now, server) in [
            (1_999, true),
            (2_000 + REPLAY_WINDOW_SECONDS - REPLAY_SEND_MARGIN_SECONDS, true),
            // A POST-only margin misses a delayed clock probe.
            (2_000 + REPLAY_WINDOW_SECONDS - READ_TIMEOUT.as_secs() - 2, true),
            (2_000 + REPLAY_WINDOW_SECONDS, true),
        ] {
            assert_eq!(
                decide_replay(&item, now, server),
                ReplayDecision::FreezeUnknownCommit
            );
        }
        item.first_attempted_clock = Some("local".into());
        for server in [false, true] {
            assert_eq!(
                decide_replay(&item, 2_001, server),
                ReplayDecision::FreezeUnknownCommit
            );
        }
    }

    #[test]
    fn missing_current_server_clock_defers_without_mutation_then_recovers() {
        for (server_now, should_replay) in [
            (2_100, true),
            (2_000 + REPLAY_WINDOW_SECONDS, false),
        ] {
            let dir = test_dir("deferred-clock");
            let mut item = test_item();
            item.state = SpoolState::InFlight;
            item.idempotency_key = Some("original-key".into());
            item.first_attempted_epoch_s = Some(2_000);
            item.first_attempted_clock = Some("server".into());
            item.attempts = 1;
            save_item(&dir, &item).unwrap();
            let path = dir.join("items").join(format!("{}.json", item.id));
            let before = fs::read(&path).unwrap();
            let cli = test_sync_cli(&dir);
            let deferred = run_sync_with_io(
                &cli,
                "https://example.test",
                "0.2.0-draft",
                Some("token-placeholder"),
                None,
                2_000 + REPLAY_WINDOW_SECONDS + 1,
                |_, _, _, _, _, _| panic!("missing current clock must not send"),
            );
            assert_eq!(deferred.exit_code, 1);
            let summary: Value = serde_json::from_str(&deferred.stdout).unwrap();
            assert_eq!(summary["awaiting_server_clock"], 1);
            assert_eq!(summary["unknown_commit"], 0);
            assert_eq!(fs::read(&path).unwrap(), before);

            let recovered = run_sync_with_io(
                &cli,
                "https://example.test",
                "0.2.0-draft",
                Some("token-placeholder"),
                Some(server_now),
                1,
                |_, _, _, key, _, body| {
                    assert!(should_replay, "expired write must not send");
                    assert_eq!(Some(key), item.idempotency_key.as_deref());
                    assert_eq!(body, item.body_json);
                    Ok(SyncPostResponse {
                        status: 201,
                        body: "{\"ok\":true,\"event_id\":\"EV-recorded\"}".into(),
                        server_epoch_s: Some(server_now),
                        deprecation: None,
                    })
                },
            );
            let retained = load_all_items(&dir).unwrap().remove(0);
            assert_eq!(retained.first_attempted_epoch_s, item.first_attempted_epoch_s);
            assert_eq!(retained.first_attempted_clock, item.first_attempted_clock);
            assert_eq!(retained.idempotency_key, item.idempotency_key);
            assert_eq!(retained.body_json, item.body_json);
            if should_replay {
                assert_eq!(recovered.exit_code, 0);
                assert_eq!(retained.state, SpoolState::Committed);
                assert_eq!(retained.attempts, 2);
            } else {
                assert_eq!(recovered.exit_code, 1);
                assert_eq!(retained.state, SpoolState::UnknownCommit);
                assert_eq!(retained.attempts, 1);
            }
        }
    }

    #[test]
    fn ambiguous_local_attempt_freezes_without_replacing_clock_key_or_body() {
        let dir = test_dir("clock-source");
        let item = test_item();
        save_item(&dir, &item).unwrap();
        let cli = test_sync_cli(&dir);
        let first = run_sync_with_io(
            &cli,
            "https://example.test",
            "0.2.0-draft",
            Some("token-placeholder"),
            None,
            200_000,
            |_, _, _, _, _, body| {
                assert_eq!(body, item.body_json);
                Err(SyncPostError::Network { server_epoch_s: None })
            },
        );
        assert_eq!(first.exit_code, 1);
        let attempted = load_all_items(&dir).unwrap().remove(0);
        assert_eq!(attempted.first_attempted_clock.as_deref(), Some("local"));
        let second = run_sync_with_io(
            &cli,
            "https://example.test",
            "0.2.0-draft",
            Some("token-placeholder"),
            Some(2_000),
            200_001,
            |_, _, _, _, _, _| panic!("clock switch must not reopen an ambiguous write"),
        );
        assert_eq!(second.exit_code, 1);
        let frozen = load_all_items(&dir).unwrap().remove(0);
        assert_eq!(frozen.state, SpoolState::UnknownCommit);
        assert_eq!(frozen.idempotency_key, attempted.idempotency_key);
        assert_eq!(frozen.body_json, item.body_json);
        assert_eq!(frozen.first_attempted_epoch_s, attempted.first_attempted_epoch_s);
        assert_eq!(frozen.first_attempted_clock, attempted.first_attempted_clock);
        assert_eq!(frozen.attempts, 1);
    }

    #[test]
    fn in_window_replay_keeps_exact_payload_and_key_and_requires_complete_receipt() {
        for receipt in ["{\"event_id\":", "[]", "{\"ok\":false}"] {
            let dir = test_dir("receipt");
            let item = test_item();
            save_item(&dir, &item).unwrap();
            let cli = test_sync_cli(&dir);
            let first = run_sync_with_io(
                &cli,
                "https://example.test",
                "0.2.0-draft",
                Some("token-placeholder"),
                Some(2_000),
                2_000,
                |_, _, _, _, _, _| {
                    Ok(SyncPostResponse {
                        status: 201,
                        body: receipt.into(),
                        server_epoch_s: Some(2_000),
                        deprecation: None,
                    })
                },
            );
            assert_eq!(first.exit_code, 1);
            let attempted = load_all_items(&dir).unwrap().remove(0);
            assert_eq!(attempted.state, SpoolState::InFlight);
            assert_eq!(attempted.receipt_sha256, None);
            let second = run_sync_with_io(
                &cli,
                "https://example.test",
                "0.2.0-draft",
                Some("token-placeholder"),
                Some(2_100),
                10,
                |_, _, _, key, _, body| {
                    assert_eq!(Some(key), attempted.idempotency_key.as_deref());
                    assert_eq!(body, item.body_json);
                    Ok(SyncPostResponse {
                        status: 201,
                        body: "{\"ok\":true,\"event_id\":\"EV-recorded\"}".into(),
                        server_epoch_s: Some(2_100),
                        deprecation: None,
                    })
                },
            );
            assert_eq!(second.exit_code, 0);
            let committed = load_all_items(&dir).unwrap().remove(0);
            assert_eq!(committed.state, SpoolState::Committed);
            assert_eq!(committed.first_attempted_epoch_s, attempted.first_attempted_epoch_s);
            assert_eq!(committed.idempotency_key, attempted.idempotency_key);
            assert_eq!(committed.attempts, 2);
        }
    }

    #[test]
    fn concurrent_sync_cannot_replace_first_attempt_history() {
        let dir = test_dir("single-writer");
        save_item(&dir, &test_item()).unwrap();
        let lock = lock_spool_mutation(&dir).unwrap();
        let out = run_sync_with_io(
            &test_sync_cli(&dir),
            "https://example.test",
            "0.2.0-draft",
            Some("token-placeholder"),
            Some(2_000),
            2_000,
            |_, _, _, _, _, _| panic!("second writer must not send"),
        );
        assert_eq!(out.exit_code, 2);
        assert_eq!(load_all_items(&dir).unwrap()[0].attempts, 0);
        drop(lock);
        assert!(lock_spool_mutation(&dir).is_ok());
    }

    #[test]
    fn allowlist_permits_session_writes_and_blocks_one_time_exchanges() {
        assert!(is_replay_safe_write_path("/v1/sessions"));
        assert!(is_replay_safe_write_path("/v1/sessions/S-1/promote"));
        assert!(is_replay_safe_write_path("/v1/sessions/S-1/workshop"));
        assert!(is_replay_safe_write_path("/v1/sessions/S-1/gaps/close"));
        assert!(is_replay_safe_write_path(
            "/v1/sessions/S-1/hypotheses/H-1/kill"
        ));
        assert!(is_replay_safe_write_path(
            "/v1/sessions/S-1/leases/L-1/release"
        ));

        // One-time exchanges and enrollment paths are unconditionally blocked.
        for forbidden in [
            "/v1/fellows",
            "/v1/enrollments",
            "/v1/enrollments/ASIMP-EN-1/decision",
            "/v1/device/start",
            "/v1/device/poll",
            "/join/ASIMP-EN-1",
            "/v1/rebinds",
            "/v1/sessions/S-1/promote?extra=1",
            "/v1/sessions/../fellows",
        ] {
            assert!(
                !is_replay_safe_write_path(forbidden),
                "must refuse {forbidden}"
            );
        }
    }

    #[test]
    fn http_date_and_rfc3339_round_trip_accurately() {
        let epoch = parse_http_date("Sat, 21 Nov 2026 01:45:00 GMT").expect("valid IMF-fixdate");
        assert_eq!(format_utc_rfc3339(epoch), "2026-11-21T01:45:00Z");
        let leap = parse_http_date("Thu, 29 Feb 2024 12:00:00 GMT").expect("leap day");
        assert_eq!(format_utc_rfc3339(leap), "2024-02-29T12:00:00Z");
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(
            parse_http_date("Fri, 31 Dec 9999 23:59:59 GMT"),
            Some(MAX_SPOOL_EPOCH_SECONDS)
        );
        for invalid in [
            "not-a-date",
            "Sat, 21 Nov 9223372036854775807 01:45:00 GMT",
            "Sat, 21 Nov 10000 01:45:00 GMT",
            "Wed, 31 Dec 1969 23:59:59 GMT",
            "Fri, 29 Feb 2100 12:00:00 GMT",
            "Fri, 29 Feb 2025 12:00:00 GMT",
            "Mon, 31 Nov 2026 01:45:00 GMT",
            "Sat, 00 Nov 2026 01:45:00 GMT",
            "Sat, 21 Nov 2026 24:00:00 GMT",
            "Sat, 21 Nov 2026 01:60:00 GMT",
            "Sat, 21 Nov 2026 01:45:60 GMT",
            "Bad, 21 Nov 2026 01:45:00 GMT",
            "Sat, 21 Nov 2026 1:45:00 GMT",
            "Sat, 21 Nov 2026 01:45:00 UTC",
        ] {
            assert!(parse_http_date(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn clock_probe_requires_an_unaged_valid_server_date() {
        let date = Some("Sat, 21 Nov 2026 01:45:00 GMT");
        let expected = date.and_then(parse_http_date);
        assert!(expected.is_some());
        assert_eq!(fresh_server_clock(date, None), expected);
        assert_eq!(fresh_server_clock(date, Some("0")), expected);
        for age in [
            "1",
            "15",
            "86400",
            "",
            "-1",
            "+0",
            "0, 15",
            "invalid",
            "18446744073709551616",
        ] {
            assert_eq!(fresh_server_clock(date, Some(age)), None, "{age}");
        }
        assert_eq!(fresh_server_clock(None, None), None);
        assert_eq!(fresh_server_clock(Some("invalid"), Some("0")), None);
    }

    #[test]
    fn replay_window_truth_table_handles_unsent_old_draft_in_window_and_expired_unknown_commit() {
        let base_item = SpoolItem {
            id: "SP-1000-abcdef012345".into(),
            origin: "https://example.test".into(),
            path: "/v1/sessions/S-1/promote".into(),
            session_id: Some("S-1".into()),
            problem_id: Some("P-4DSP".into()),
            state: SpoolState::Unsent,
            idempotency_key: None,
            body_json: "{}".into(),
            body_sha256: sha256_hex(b"{}"),
            client_occurred_at: format_utc_rfc3339(1_000),
            created_epoch_s: 1_000,
            first_attempted_epoch_s: None,
            first_attempted_clock: None,
            attempts: 0,
            last_http_status: None,
            last_error_code: None,
            receipt_sha256: None,
            server_event_id: None,
            server_object_id: None,
            resolution_note: None,
        };

        // 1. Drafted 48h ago, never attempted -> SendFresh (key assigned at first send).
        assert_eq!(
            decide_replay(&base_item, 1_000 + 48 * 3600, true),
            ReplayDecision::SendFresh
        );

        // 2. Attempted 23h ago -> ReplayInWindow (same key).
        let mut in_flight = base_item.clone();
        in_flight.state = SpoolState::InFlight;
        in_flight.idempotency_key = Some("orig-key-1".into());
        in_flight.first_attempted_epoch_s = Some(10_000);
        in_flight.first_attempted_clock = Some("server".into());
        in_flight.attempts = 1;
        assert_eq!(
            decide_replay(&in_flight, 10_000 + 23 * 3600, true),
            ReplayDecision::ReplayInWindow
        );

        // 3. Attempted 24h+1s ago -> FreezeUnknownCommit (NEVER resubmits or rotates key).
        assert_eq!(
            decide_replay(&in_flight, 10_000 + REPLAY_WINDOW_SECONDS + 1, true),
            ReplayDecision::FreezeUnknownCommit
        );

        // 4. Rejected stays rejected.
        let mut rejected = base_item.clone();
        rejected.state = SpoolState::Rejected;
        assert_eq!(
            decide_replay(&rejected, 20_000, true),
            ReplayDecision::SkipRejected
        );
    }

    #[test]
    fn sync_treats_http_408_and_425_as_retryable_in_flight_and_keeps_dry_run_read_only() {
        let dir = std::env::temp_dir().join(format!(
            "asimp-spool-408-dryrun-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let origin = "https://a.asimposium.org";
        let item_408 = SpoolItem {
            id: "SP-2000-timeout40800".into(),
            origin: origin.into(),
            path: "/v1/sessions/S-1/promote".into(),
            session_id: Some("S-1".into()),
            problem_id: Some("P-4DSP".into()),
            state: SpoolState::Unsent,
            idempotency_key: Some("idem-408-stable".into()),
            body_json: r#"{"statement":"x"}"#.into(),
            body_sha256: sha256_hex(br#"{"statement":"x"}"#),
            client_occurred_at: format_utc_rfc3339(2_000),
            created_epoch_s: 2_000,
            first_attempted_epoch_s: None,
            first_attempted_clock: None,
            attempts: 0,
            last_http_status: None,
            last_error_code: None,
            receipt_sha256: None,
            server_event_id: None,
            server_object_id: None,
            resolution_note: None,
        };
        save_item(&dir, &item_408).unwrap();

        let cli_live = Cli {
            origin: Some(origin.into()),
            identity: "default".into(),
            protocol_version: None,
            pop_key: None,
            command: Command::Sync(Box::new(SyncArgs {
                spool_dir: Some(dir.clone()),
                item: Some(item_408.id.clone()),
                dry_run: false,
                json: true,
            })),
        };
        let out = run_sync_with_io(
            &cli_live,
            origin,
            "0.2.0-draft",
            Some("tok"),
            Some(2_010),
            2_010,
            |_url, _tok, _pv, _key, _at, _body| {
                Err(SyncPostError::Status {
                    status: 408,
                    code: Some("REQUEST_TIMEOUT".into()),
                    server_epoch_s: Some(2_010),
                })
            },
        );
        assert_eq!(out.exit_code, 1);
        let loaded = load_all_items(&dir).unwrap();
        let after = loaded.iter().find(|i| i.id == item_408.id).unwrap();
        assert_eq!(after.state, SpoolState::InFlight);
        assert_eq!(after.idempotency_key.as_deref(), Some("idem-408-stable"));

        // Non-replayable path under --dry-run must NOT mutate the on-disk item.
        let bad_item = SpoolItem {
            id: "SP-2001-badpath00001".into(),
            path: "/v1/fellows".into(),
            ..item_408
        };
        save_item(&dir, &bad_item).unwrap();
        let cli_dry = Cli {
            origin: Some(origin.into()),
            identity: "default".into(),
            protocol_version: None,
            pop_key: None,
            command: Command::Sync(Box::new(SyncArgs {
                spool_dir: Some(dir.clone()),
                item: Some(bad_item.id.clone()),
                dry_run: true,
                json: true,
            })),
        };
        let dry_out = run_sync_with_io(
            &cli_dry,
            origin,
            "0.2.0-draft",
            None,
            Some(2_020),
            2_020,
            |_url, _tok, _pv, _key, _at, _body| unreachable!("dry_run must never POST"),
        );
        assert_eq!(dry_out.exit_code, 1);
        let reloaded = load_all_items(&dir).unwrap();
        let untouched = reloaded.iter().find(|i| i.id == bad_item.id).unwrap();
        assert_eq!(untouched.state, SpoolState::Unsent);
    }
}
