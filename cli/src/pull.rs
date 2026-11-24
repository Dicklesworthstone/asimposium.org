//! Download complete public archives and verify their payloads, event chain,
//! publication context and checkpoint signatures before publishing a local file.

use crate::{Cli, CliOutput, FetchError, READ_TIMEOUT, canonical_json::canonical_json};
use flate2::bufread::GzDecoder;
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

// Match the mounted public export producer. Gzip may be slightly larger than
// incompressible input, so the compressed bound includes framing overhead.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_GZIP_BYTES: u64 = MAX_BYTES + 65_536;
const MAX_EVENTS: usize = 10_000;
const V4: &str = "asimposium.problem-export.v4";
const V5: &str = "asimposium.problem-export.v5";
const INVALID: &str = "The archive is incomplete, unsupported or inconsistent. Retry this public read later, or inspect available event envelopes with asimp watch <problem> --once --json.";

#[derive(Debug, clap::Args)]
pub struct PullArgs {
    /// Public problem ID, for example P-4DSP.
    problem: String,
    /// New gzip file to create. Defaults to .asimp/<problem>-<archive-sha256>.jsonl.gz.
    #[arg(long, value_name = "FILE")]
    output: Option<PathBuf>,
    /// Independently obtained JSON array of {key_id, public_key} verification keys.
    #[arg(long, value_name = "JSON_FILE")]
    trusted_keys: Option<PathBuf>,
    /// Require an independently pinned signature covering the complete event chain.
    #[arg(long, requires = "trusted_keys")]
    require_authenticated: bool,
    /// Print a JSON receipt with the destination, digests and signature coverage.
    #[arg(long)]
    json: bool,
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
    let mut decoder = GzDecoder::new(bytes);
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

pub(crate) fn run(cli: &Cli, args: &PullArgs) -> CliOutput {
    run_with_download(cli, args, download)
}

fn run_with_download(
    cli: &Cli,
    args: &PullArgs,
    fetch: impl FnOnce(&str) -> Result<Archive, FetchError>,
) -> CliOutput {
    if !problem_id(&args.problem) {
        return failed(args, 2, "Supply a public problem ID such as P-4DSP.");
    }
    let url = match crate::resolve_origin(cli.origin.as_ref()).and_then(|origin| {
        crate::build_url(&origin, &format!("/p/{}/export.jsonl.gz", args.problem))
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
    let mut receipt = match verify(&args.problem, &decoded, &trusted) {
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
            PathBuf::from(".asimp").join(format!("{}-{archive_digest}.jsonl.gz", args.problem))
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
#[path = "pull_tests.rs"]
mod tests;
