use super::*;
use clap::Parser;
use flate2::{Compression, write::GzEncoder};

// Produced by the Worker's serializePublicProblemExport/checkpoint signer,
// and accepted by verifyPublicProblemExportChain with these independent pins.
const FIXTURE: &str = include_str!("../tests/fixtures/public-export-v5.jsonl");
const KEYS: &str = include_str!("../tests/fixtures/public-export-keys.json");

fn records() -> Vec<Value> {
    FIXTURE
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn encode(records: &[Value]) -> String {
    records
        .iter()
        .map(|value| format!("{}\n", serde_json::to_string(value).unwrap()))
        .collect()
}

fn pins() -> BTreeMap<String, String> {
    serde_json::from_str::<Vec<Value>>(KEYS)
        .unwrap()
        .iter()
        .map(|key| {
            (
                key["key_id"].as_str().unwrap().to_owned(),
                key["public_key"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn gzip(text: &[u8]) -> Vec<u8> {
    let mut writer = GzEncoder::new(Vec::new(), Compression::fast());
    writer.write_all(text).unwrap();
    writer.finish().unwrap()
}

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        SystemRandom::new().fill(&mut nonce).unwrap();
        let path = std::env::temp_dir().join(format!("asimp-pull-test-{}", sha256(&nonce)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn invocation(output: &Path) -> Cli {
    Cli::try_parse_from([
        "asimp",
        "--origin",
        "https://example.test",
        "pull",
        "P-PULL",
        "--output",
        output.to_str().unwrap(),
        "--json",
    ])
    .unwrap()
}

fn pull_args(cli: &Cli) -> &PullArgs {
    match &cli.command {
        crate::Command::Pull(args) => args,
        _ => panic!("pull expected"),
    }
}

#[test]
fn verifies_worker_signed_fixture_and_reports_exact_trust_coverage() {
    let result = verify("P-PULL", FIXTURE, &pins()).unwrap();
    assert_eq!(result["event_count"], 2);
    assert_eq!(
        result["final_chain_digest"],
        "52ff1b93a0401873d5b425536b0238fdec6169731a44ce13e0cc4757f94d7282"
    );
    assert_eq!(
        result["publication_context_sha256"],
        "d62052439a97cd419be562380a98d247d06dd8c3248cea0e7c762f8501121ba2"
    );
    assert_eq!(result["checkpoint_signature_count"], 2);
    assert_eq!(result["publication_notice_count"], 1);
    assert_eq!(result["authenticated"], true);
    assert_eq!(result["trusted_through"], 2);
    let unpinned = verify("P-PULL", FIXTURE, &BTreeMap::new()).unwrap();
    assert_eq!(unpinned["authenticated"], false);
    assert_eq!(unpinned["signature_coverage"], "complete");
    assert_eq!(unpinned["trusted_through"], 0);
    let mut prefix_keys = pins();
    prefix_keys.remove("key-0");
    let prefix = verify("P-PULL", FIXTURE, &prefix_keys).unwrap();
    assert_eq!(prefix["authenticated"], false);
    assert_eq!(prefix["trusted_through"], 1);
    let wrong = BTreeMap::from([("key-0".into(), "00".repeat(32))]);
    assert_eq!(
        verify("P-PULL", FIXTURE, &wrong).unwrap()["trusted_through"],
        0
    );
}

#[test]
fn v4_and_empty_exports_retain_context_and_cannot_imply_authentication() {
    let mut value = records();
    value[0]["format"] = json!(V4);
    value[0]
        .as_object_mut()
        .unwrap()
        .remove("checkpoint_signatures");
    let result = verify("P-PULL", &encode(&value), &pins()).unwrap();
    assert_eq!(result["authenticated"], false);
    assert_eq!(result["signature_coverage"], "none");
    assert_eq!(result["publication_notice_count"], 1);
    value.drain(2..4);
    value[0]["checkpoints"] = json!([]);
    value[1]["through"] = json!(0);
    value[1]["notices"] = json!([]);
    value[1].as_object_mut().unwrap().remove("context_sha256");
    let context = sha256(
        format!(
            "asimposium.publication-context.v1\n{}",
            canonical_json(&value[1]).unwrap()
        )
        .as_bytes(),
    );
    value[1]["context_sha256"] = json!(context);
    value[0]["publication_context_sha256"] = json!(context);
    value[2]["event_count"] = json!(0);
    value[2]["final_cursor"] = json!(0);
    let result = verify("P-PULL", &encode(&value), &pins()).unwrap();
    assert_eq!(result["cursor"], 0);
    assert_eq!(result["authenticated"], false);
}

#[test]
fn refuses_tampering_across_every_integrity_domain() {
    let mutations: Vec<Box<dyn Fn(&mut Vec<Value>)>> = vec![
        Box::new(|r| r[0]["problem"] = json!("P-OTHER")),
        Box::new(|r| r[0]["format"] = json!("asimposium.problem-export.v3")),
        Box::new(|r| r[0]["unrecognized"] = json!(true)),
        Box::new(|r| r[0]["checkpoints"][1]["root_chain_digest"] = json!("00".repeat(32))),
        Box::new(|r| r[0]["checkpoints"][1]["checkpoint_digest"] = json!("00".repeat(32))),
        Box::new(|r| r[0]["checkpoints"].as_array_mut().unwrap().reverse()),
        Box::new(|r| {
            r[0]["checkpoint_signatures"]["signatures"][0]["signature"] = json!("00".repeat(64))
        }),
        Box::new(|r| r[0]["checkpoint_signatures"]["signatures"][0]["checkpoint_seq"] = json!(2)),
        Box::new(|r| {
            r[0]["checkpoint_signatures"]["keys"][0]["public_key"] = json!("00".repeat(32))
        }),
        Box::new(|r| {
            r[0]["checkpoint_signatures"]["keys"]
                .as_array_mut()
                .unwrap()
                .reverse()
        }),
        Box::new(|r| {
            r[0]["checkpoint_signatures"]["signatures"]
                .as_array_mut()
                .unwrap()
                .reverse()
        }),
        Box::new(|r| r[0]["checkpoint_signatures"]["through"] = json!(1)),
        Box::new(|r| r[1]["notices"] = json!([])),
        Box::new(|r| r[2]["payload_json"] = json!("private-canary")),
        Box::new(|r| r[2]["actor_sponsor_id"] = json!("changed")),
        Box::new(|r| r[2]["row_digest"] = json!("00".repeat(32))),
        Box::new(|r| r[2]["chain_digest"] = json!("00".repeat(32))),
        Box::new(|r| r[2]["created_at"] = json!("2026-02-30T00:00:00.000Z")),
        Box::new(|r| r[3]["seq"] = json!(3)),
        Box::new(|r| r[3]["object_version"] = json!(9_007_199_254_740_992u64)),
        Box::new(|r| r[4]["event_count"] = json!(1)),
        Box::new(|r| r[4]["final_cursor"] = json!(1)),
    ];
    for (index, mutate) in mutations.into_iter().enumerate() {
        let mut changed = records();
        mutate(&mut changed);
        assert!(
            verify("P-PULL", &encode(&changed), &pins()).is_err(),
            "mutation {index}"
        );
    }
    assert!(verify("P-OTHER", FIXTURE, &pins()).is_err());
    let mut detached = records();
    detached[1]["notices"][0]["event_id"] = json!("E-detached");
    detached[1]
        .as_object_mut()
        .unwrap()
        .remove("context_sha256");
    let context = sha256(
        format!(
            "asimposium.publication-context.v1\n{}",
            canonical_json(&detached[1]).unwrap()
        )
        .as_bytes(),
    );
    detached[0]["publication_context_sha256"] = json!(context);
    detached[1]["context_sha256"] = json!(context);
    assert!(verify("P-PULL", &encode(&detached), &pins()).is_err());
}

#[test]
fn rejects_incomplete_framing_bad_gzip_and_expansion_past_the_limit() {
    for invalid in [
        FIXTURE.trim_end().to_owned(),
        FIXTURE.replace('\n', "\r\n"),
        format!("{FIXTURE}\n"),
        format!("{FIXTURE}{{}}\n"),
        "".to_owned(),
    ] {
        assert!(verify("P-PULL", &invalid, &pins()).is_err());
    }
    let valid = gzip(FIXTURE.as_bytes());
    assert_eq!(unpack(&valid).unwrap(), FIXTURE);
    for bytes in [
        valid[..valid.len() - 1].to_vec(),
        [valid.as_slice(), b"extra"].concat(),
        [valid.as_slice(), valid.as_slice()].concat(),
        gzip(&vec![b'a'; MAX_BYTES as usize + 1]),
    ] {
        assert!(unpack(&bytes).is_err());
    }
    let mut bad_crc = valid;
    let index = bad_crc.len() - 8;
    bad_crc[index] ^= 1;
    assert!(unpack(&bad_crc).is_err());
}

#[test]
fn complete_command_preserves_download_bytes_and_existing_files() {
    let directory = Directory::new();
    let destination = directory.0.join("export.jsonl.gz");
    let cli = invocation(&destination);
    let bytes = gzip(FIXTURE.as_bytes());
    let fetch = |url: &str| {
        assert_eq!(url, "https://example.test/p/P-PULL/export.jsonl.gz");
        Ok(Archive {
            bytes: bytes.clone(),
            format: V5.into(),
        })
    };
    let output = run_with_download(&cli, pull_args(&cli), fetch);
    assert_eq!(output.exit_code, 0, "{}", output.stdout);
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    let receipt: Value = serde_json::from_str(&output.stdout).unwrap();
    assert_eq!(receipt["archive_sha256"], sha256(&bytes));
    assert_eq!(receipt["authenticated"], false);
    assert!(output.stderr.is_empty());
    let second = run_with_download(&cli, pull_args(&cli), fetch);
    assert_ne!(second.exit_code, 0);
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn authenticated_gate_and_transport_refusals_never_create_snapshots() {
    let directory = Directory::new();
    let destination = directory.0.join("export.jsonl.gz");
    let key_file = directory.0.join("keys.json");
    fs::write(&key_file, r#"[{"key_id":"key-0","public_key":"0000000000000000000000000000000000000000000000000000000000000000"}]"#).unwrap();
    let mut cli = invocation(&destination);
    if let crate::Command::Pull(args) = &mut cli.command {
        args.trusted_keys = Some(key_file.clone());
        args.require_authenticated = true;
    }
    let output = run_with_download(&cli, pull_args(&cli), |_| {
        Ok(Archive {
            bytes: gzip(FIXTURE.as_bytes()),
            format: V5.into(),
        })
    });
    assert_ne!(output.exit_code, 0);
    assert!(!destination.exists());
    for status in [301, 400, 401, 403, 404, 409, 429, 500] {
        let output = run_with_download(&cli, pull_args(&cli), |_| Err(FetchError::Status(status)));
        assert_ne!(output.exit_code, 0);
        assert!(!destination.exists());
    }
    fs::write(&key_file, KEYS).unwrap();
    let output = run_with_download(&cli, pull_args(&cli), |_| {
        Ok(Archive {
            bytes: gzip(FIXTURE.as_bytes()),
            format: V5.into(),
        })
    });
    assert_eq!(output.exit_code, 0, "{}", output.stdout);
    assert_eq!(
        serde_json::from_str::<Value>(&output.stdout).unwrap()["authenticated"],
        true
    );
}

#[test]
fn concurrent_saves_have_one_complete_winner() {
    let directory = Directory::new();
    let destination = directory.0.join("same.gz");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
        .into_iter()
        .map(|bytes| {
            let path = destination.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                save(&path, bytes)
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(Result::is_ok)
            .count(),
        1
    );
    let bytes = fs::read(destination).unwrap();
    assert!(bytes == b"first" || bytes == b"second");
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[test]
fn invalid_navigation_and_keys_fail_before_network_without_input_reflection() {
    let directory = Directory::new();
    assert!(!problem_id("P-BAD--ID"));
    let cli = Cli::try_parse_from(["asimp", "pull", "../private-canary", "--json"]).unwrap();
    let result = run_with_download(&cli, pull_args(&cli), |_| panic!("invalid ID fetched"));
    assert_eq!(result.exit_code, 2);
    assert!(!result.stdout.contains("private-canary"));
    let mut cli = invocation(&directory.0.join("export.gz"));
    cli.origin = Some("http://private-canary.test".into());
    let result = run_with_download(&cli, pull_args(&cli), |_| panic!("invalid origin fetched"));
    assert_eq!(result.exit_code, 2);
    assert!(!result.stdout.contains("private-canary"));
    let path = directory.0.join("keys.json");
    fs::write(&path, "private-key-canary").unwrap();
    assert!(trusted_keys(Some(&path)).is_err());
    fs::write(&path, "[]").unwrap();
    assert!(trusted_keys(Some(&path)).is_err());
    let mut keys: Vec<Value> = serde_json::from_str(KEYS).unwrap();
    keys.push(keys[0].clone());
    fs::write(&path, serde_json::to_vec(&keys).unwrap()).unwrap();
    assert!(trusted_keys(Some(&path)).is_err());
}

#[test]
fn download_uses_public_http_and_rejects_partial_or_mislabeled_responses() {
    use std::net::TcpListener;
    let compressed = gzip(FIXTURE.as_bytes());
    for (status, content_type, format, encoding, expected) in [
        (200, "application/gzip", V5, "identity", true),
        (206, "application/gzip", V5, "identity", false),
        (302, "application/gzip", V5, "identity", false),
        (200, "text/plain", V5, "identity", false),
        (200, "application/gzip", "other", "identity", false),
        (200, "application/gzip", V5, "br", false),
        (200, "application/gzip", V5, "gzip", false),
        (200, "application/gzip", V5, "x-gzip", false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        // ureq's optional transparent gzip feature used to remove the
        // encoding header and decode this outer layer before our wire bound.
        let body = if matches!(encoding, "gzip" | "x-gzip") {
            gzip(&compressed)
        } else {
            compressed.clone()
        };
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(request.starts_with("get /p/p-pull/export.jsonl.gz http/1.1\r\n"));
            assert!(request.contains("user-agent: asimposium.org-agent"));
            assert!(request.contains("accept-encoding: identity\r\n"));
            assert!(!request.contains("authorization:") && !request.contains("cookie:"));
            let headers = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Encoding: {encoding}\r\nX-Asimposium-Export-Format: {format}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/private-canary\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(&body);
        });
        let result = download(&format!("http://{address}/p/P-PULL/export.jsonl.gz"));
        assert_eq!(
            result.is_ok(),
            expected,
            "HTTP {status}, {content_type}, {format}, {encoding}"
        );
        if let Ok(archive) = result {
            assert_eq!(archive.bytes, compressed);
        }
        server.join().unwrap();
    }
}
