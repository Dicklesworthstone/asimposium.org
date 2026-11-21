//! Subprocess tests for `asimp pull` and protocol-version negotiation (W11.2,
//! `asimposiumorg-l3b`).

use asimp::{
    pull::{
        EXPORT_LICENSE, KRATER_CHAIN_VERSION, PUBLIC_EXPORT_FORMAT, checkpoint_digest,
        event_chain_digest, event_envelope_row_digest, genesis_chain_digest,
        publication_context_digest,
    },
    validate::sha256_hex,
};
use flate2::{Compression, write::GzEncoder};
use serde_json::{Map, Value, json};
use std::{fs, io::Write, process::Command};

fn asimp_bin() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_asimp"));
    cmd.env("ASIMP_ORIGIN", "https://example.invalid")
        .env_remove("ASIMP_TOKEN");
    cmd
}

fn sample_v5_export(problem: &str) -> (String, String) {
    let payload = r#"{"kind":"claim","statement":"Every prime > 2 is odd."}"#;
    let payload_sha = sha256_hex(payload.as_bytes());
    let genesis = genesis_chain_digest(problem).unwrap();
    let row = event_envelope_row_digest(
        problem,
        "EV-1",
        1,
        "claim.created",
        "claim",
        "C-1",
        1,
        &payload_sha,
        "2026-09-10T00:00:00.000Z",
        Some("F-1"),
        Some("usr_1"),
        Some("S-1"),
        Some("claude-opus-4-6"),
        Some("claude-code"),
        Some("cred_1"),
    )
    .unwrap();
    let chain = event_chain_digest(problem, 1, &payload_sha, &row, &genesis).unwrap();
    let cp = checkpoint_digest(problem, 1, &chain).unwrap();

    let mut ctx = Map::new();
    ctx.insert("control".into(), json!("publication_context"));
    ctx.insert("format".into(), json!("asimposium.publication-context.v1"));
    ctx.insert("problem".into(), json!(problem));
    ctx.insert("through".into(), json!(1));
    ctx.insert("assurance".into(), json!("export-self-consistency-only"));
    ctx.insert("notices".into(), json!([]));
    let ctx_sha = publication_context_digest(&ctx).unwrap();
    ctx.insert("context_sha256".into(), json!(ctx_sha));

    let header = json!({
        "control": "export_header",
        "format": PUBLIC_EXPORT_FORMAT,
        "license": EXPORT_LICENSE,
        "problem": problem,
        "title": "Sample Problem",
        "generated_at": "2026-09-10T00:01:00.000Z",
        "checkpoints": [{
            "checkpoint_seq": 1,
            "root_chain_digest": chain,
            "checkpoint_digest": cp,
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
        "event_id": "EV-1",
        "seq": 1,
        "type": "claim.created",
        "object_kind": "claim",
        "object_id": "C-1",
        "object_version": 1,
        "payload_sha256": payload_sha,
        "row_digest": row,
        "chain_digest": chain,
        "chain_version": KRATER_CHAIN_VERSION,
        "created_at": "2026-09-10T00:00:00.000Z",
        "actor_fellow_id": "F-1",
        "actor_sponsor_id": "usr_1",
        "actor_session_id": "S-1",
        "model_string_self_declared": "claude-opus-4-6",
        "harness": "claude-code",
        "writer_credential_id": "cred_1",
        "payload_json": payload,
    });
    let trailer = json!({
        "control": "export_end",
        "problem": problem,
        "event_count": 1,
        "final_cursor": 1,
    });
    (
        format!(
            "{}\n{}\n{}\n{}\n",
            serde_json::to_string(&header).unwrap(),
            serde_json::to_string(&Value::Object(ctx)).unwrap(),
            serde_json::to_string(&event).unwrap(),
            serde_json::to_string(&trailer).unwrap(),
        ),
        chain,
    )
}

#[test]
fn pull_verify_file_verifies_gzip_and_plain_offline_and_rejects_tampering() {
    let dir = std::env::temp_dir().join(format!("asimp-pull-bin-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    let (ndjson, chain) = sample_v5_export("P-4DSP");
    let gz_path = dir.join("sample.export.jsonl.gz");
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(ndjson.as_bytes()).unwrap();
    fs::write(&gz_path, enc.finish().unwrap()).unwrap();

    // Valid gzip verification succeeds even with a hostile ASIMP_TOKEN env (proves zero credential use).
    let out = asimp_bin()
        .env("ASIMP_TOKEN", "bad\r\ntoken-canary")
        .args([
            "pull",
            "--verify-file",
            gz_path.to_str().unwrap(),
            "--pin-seq",
            "1",
            "--pin-root",
            &chain,
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains("token-canary"));
    let parsed: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["problem_id"], "P-4DSP");
    assert_eq!(parsed["final_chain_digest"], chain);
    assert_eq!(parsed["assurance"], "export-self-consistency-only");

    // Tampered file fails with exit 1 and broken_at_seq = 1.
    let bad_path = dir.join("tampered.jsonl");
    fs::write(&bad_path, ndjson.replace("is odd", "is even")).unwrap();
    let bad_out = asimp_bin()
        .args([
            "pull",
            "--verify-file",
            bad_path.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(bad_out.status.code(), Some(1));
    let bad_parsed: Value =
        serde_json::from_str(&String::from_utf8_lossy(&bad_out.stdout)).unwrap();
    assert_eq!(bad_parsed["ok"], false);
    assert_eq!(bad_parsed["broken_at_seq"], 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cli_refuses_unsupported_protocol_version_flag_before_network() {
    let out = asimp_bin()
        .args(["--protocol-version", "9.9.9", "capabilities", "--json"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not supported by this asimp build"));
    assert!(stderr.contains("0.2.0-draft"));
}
