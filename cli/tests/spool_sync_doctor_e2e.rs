//! Kill-and-resume & replay-window truth-table E2E tests for `asimp spool`,
//! `asimp sync`, and `asimp doctor` (W11.4, `asimposiumorg-jsj`).
//!
//! Uses a real loopback TCP HTTP server with an in-memory idempotency table to
//! prove:
//!   1. Mid-session network cut after server commit -> `sync` retries with the
//!      EXACT same `Idempotency-Key` and recovers exactly-once with ZERO
//!      duplicate promotions.
//!   2. 24h replay-window expiry (measured via server `Date` clock) freezes an
//!      `in_flight` item into `unknown_commit` with zero HTTP retries, preserving
//!      all evidence and read-only reconciliation commands.
//!   3. Drafted > 24h ago, never attempted (`unsent`) -> assigns key at first
//!      send and commits cleanly with `asimp-client-occurred-at` provenance.
//!   4. One-time enrollment exchanges and P7 secret-bearing payloads are refused.
//!   5. `asimp doctor` covers every detectable failure with an explicit fix line,
//!      and spool logs stay 100% secret-free.

use asimp::{
    Cli,
    doctor::{self, DoctorProbeResponse, TokenSource},
    scrub,
    spool::{
        self, CLIENT_OCCURRED_AT_HEADER, REPLAY_WINDOW_SECONDS, SpoolItem, SpoolState,
        SyncPostError, SyncPostResponse, format_utc_rfc3339, load_all_items, parse_http_date,
        save_item,
    },
};
use clap::Parser;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
};

fn asimp_bin() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_asimp"));
    cmd.env("ASIMP_ORIGIN", "https://example.invalid")
        .env_remove("ASIMP_TOKEN");
    cmd
}

#[test]
fn kill_and_resume_mid_session_recovers_exactly_once_against_real_tcp_idempotency_table() {
    let dir = std::env::temp_dir().join(format!("asimp-kill-resume-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let spool_dir = dir.join("spool");
    fs::create_dir_all(&spool_dir).unwrap();

    let payload_path = dir.join("promote.json");
    let promote_body = r#"{"workshop_id":"W-abcdefghijklmnopqrstuvwxyz","kind":"definition","statement":"An even integer is divisible by two."}"#;
    fs::write(&payload_path, promote_body).unwrap();

    // 1. Enqueue via compiled binary (`asimp spool enqueue --json`).
    let enq = asimp_bin()
        .args([
            "--origin",
            "https://example.test",
            "spool",
            "enqueue",
            "--path",
            "/v1/sessions/S-1/promote",
            "--file",
            payload_path.to_str().unwrap(),
            "--problem",
            "P-4DSP",
            "--spool-dir",
            spool_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(
        enq.status.code(),
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&enq.stderr)
    );
    let enq_json: Value = serde_json::from_slice(&enq.stdout).unwrap();
    let item_id = enq_json["item"]["id"].as_str().unwrap().to_owned();
    assert_eq!(enq_json["item"]["state"], "unsent");

    // 2. Spin up a real TCP HTTP server with an idempotency table that drops the
    //    FIRST connection right after committing the promotion (simulating a
    //    mid-session kill / network cut after server commit).
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let drop_first = Arc::new(AtomicBool::new(true));
    let promotions_created = Arc::new(AtomicUsize::new(0));
    let replays_served = Arc::new(AtomicUsize::new(0));
    let idempotency_table: Arc<Mutex<HashMap<String, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let observed_client_occurred = Arc::new(Mutex::new(None::<String>));

    let df = Arc::clone(&drop_first);
    let pc = Arc::clone(&promotions_created);
    let rs = Arc::clone(&replays_served);
    let tbl = Arc::clone(&idempotency_table);
    let oco = Arc::clone(&observed_client_occurred);

    let server = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let raw = String::from_utf8_lossy(&buf[..n]);
            let mut key = String::new();
            for line in raw.lines() {
                if let Some((h, v)) = line.split_once(':') {
                    if h.eq_ignore_ascii_case("idempotency-key") {
                        key = v.trim().to_owned();
                    }
                    if h.eq_ignore_ascii_case(CLIENT_OCCURRED_AT_HEADER) {
                        *oco.lock().unwrap() = Some(v.trim().to_owned());
                    }
                }
            }
            assert!(!key.is_empty(), "sync MUST send Idempotency-Key");

            let receipt = {
                let mut map = tbl.lock().unwrap();
                if let Some(cached) = map.get(&key) {
                    rs.fetch_add(1, Ordering::SeqCst);
                    cached.clone()
                } else {
                    let count = pc.fetch_add(1, Ordering::SeqCst) + 1;
                    let body = format!(
                        r#"{{"ok":true,"event_id":"EV-PROMOTE-{count}","claim_id":"C-{count}"}}"#
                    );
                    map.insert(key.clone(), body.clone());
                    body
                }
            };

            if df.swap(false, Ordering::SeqCst) {
                // Cut the TCP connection AFTER committing to idempotency table!
                drop(stream);
                continue;
            }
            let resp = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nDate: Sat, 21 Nov 2026 02:00:00 GMT\r\nasimp-protocol-version: 0.2.0-draft\r\nContent-Length: {}\r\n\r\n{}",
                receipt.len(),
                receipt
            );
            stream.write_all(resp.as_bytes()).unwrap();
        }
    });

    let token = format!(
        "asimp_ag_{}_{}",
        "0123456789ABCDEFGHJKMNPQRS",
        "k".repeat(43)
    );
    let sync_cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "https://example.test",
        "sync",
        "--spool-dir",
        spool_dir.to_str().unwrap(),
        "--json",
    ])
    .unwrap();
    let server_epoch = parse_http_date("Sat, 21 Nov 2026 02:00:00 GMT").unwrap();

    let send_over_loopback = |url: &str,
                              tok: &str,
                              proto: &str,
                              key: &str,
                              occurred: &str,
                              body: &str|
     -> Result<SyncPostResponse, SyncPostError> {
        let local_url = url.replace("https://example.test", &format!("http://{addr}"));
        let agent = ureq::AgentBuilder::new().redirects(0).build();
        let resp = agent
            .post(&local_url)
            .set("authorization", &format!("Bearer {tok}"))
            .set("content-type", "application/json")
            .set("idempotency-key", key)
            .set("asimp-protocol-version", proto)
            .set(CLIENT_OCCURRED_AT_HEADER, occurred)
            .send_bytes(body.as_bytes());
        match resp {
            Ok(r) => {
                let status = r.status();
                let date = r.header("date").and_then(parse_http_date);
                let text = r.into_string().map_err(|_| SyncPostError::Network {
                    server_epoch_s: date,
                })?;
                Ok(SyncPostResponse {
                    status,
                    body: text,
                    server_epoch_s: date,
                    deprecation: None,
                })
            }
            Err(_) => Err(SyncPostError::Network {
                server_epoch_s: None,
            }),
        }
    };

    // Attempt 1: hits server -> server commits -> TCP drops!
    let out1 = spool::run_sync_with_io(
        &sync_cli,
        "https://example.test",
        "0.2.0-draft",
        Some(&token),
        Some(server_epoch),
        server_epoch,
        send_over_loopback,
    );
    assert_eq!(out1.exit_code, 1);
    let s1: Value = serde_json::from_str(&out1.stdout).unwrap();
    assert_eq!(s1["in_flight"], 1);
    assert_eq!(s1["committed"], 0);
    let after1 = load_all_items(&spool_dir).unwrap();
    assert_eq!(after1[0].state, SpoolState::InFlight);
    let original_key = after1[0]
        .idempotency_key
        .clone()
        .expect("key persisted before send");

    // Attempt 2 (within 24h): replays EXACT same key -> server serves cached receipt!
    let out2 = spool::run_sync_with_io(
        &sync_cli,
        "https://example.test",
        "0.2.0-draft",
        Some(&token),
        Some(server_epoch + 60),
        server_epoch + 60,
        send_over_loopback,
    );
    server.join().unwrap();

    assert_eq!(out2.exit_code, 0);
    let s2: Value = serde_json::from_str(&out2.stdout).unwrap();
    assert_eq!(s2["committed"], 1);
    assert_eq!(s2["in_flight"], 0);
    // EXACTLY-ONCE PROOF:
    assert_eq!(promotions_created.load(Ordering::SeqCst), 1);
    assert_eq!(replays_served.load(Ordering::SeqCst), 1);
    assert!(observed_client_occurred.lock().unwrap().is_some());

    let after2 = load_all_items(&spool_dir).unwrap();
    assert_eq!(after2[0].id, item_id);
    assert_eq!(after2[0].state, SpoolState::Committed);
    assert_eq!(
        after2[0].idempotency_key.as_deref(),
        Some(original_key.as_str())
    );
    assert_eq!(after2[0].server_event_id.as_deref(), Some("EV-PROMOTE-1"));

    // Verify spool audit log is 100% secret-free and never contains the bearer token!
    let raw_log = fs::read_to_string(spool_dir.join("logs/spool.jsonl")).unwrap();
    assert!(!raw_log.contains(&token));
    assert!(!raw_log.contains("kkkk"));
    assert!(scrub::scan_field_for_credentials("spool_log", &raw_log).is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replay_window_expiry_freezes_unknown_commit_and_old_unsent_still_sends() {
    let dir = std::env::temp_dir().join(format!("asimp-window-e2e-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let spool_dir = dir.join("spool");
    let snap_dir = dir.join("snap");
    fs::create_dir_all(&snap_dir).unwrap();

    let t0 = 1_795_000_000u64;
    // Item A: attempted 25 hours ago -> MUST freeze into unknown_commit with ZERO HTTP POSTs.
    let expired_item = SpoolItem {
        id: "SP-1-expired".into(),
        origin: "https://example.test".into(),
        identity: Some("default".into()),
        path: "/v1/sessions/S-1/promote".into(),
        session_id: Some("S-1".into()),
        problem_id: Some("P-4DSP".into()),
        state: SpoolState::InFlight,
        idempotency_key: Some("orig-immutable-key".into()),
        body_json: r#"{"workshop_id":"W-1"}"#.into(),
        body_sha256: asimp::validate::sha256_hex(br#"{"workshop_id":"W-1"}"#),
        client_occurred_at: format_utc_rfc3339(t0),
        created_epoch_s: t0,
        first_attempted_epoch_s: Some(t0),
        first_attempted_clock: Some("server".into()),
        attempts: 1,
        last_http_status: None,
        last_error_code: Some("NETWORK_AMBIGUOUS".into()),
        receipt_sha256: None,
        server_event_id: None,
        server_object_id: None,
        resolution_note: None,
    };
    save_item(&spool_dir, &expired_item).unwrap();

    // Item B: drafted 48 hours ago, NEVER attempted (`unsent`, no key) -> MUST still send cleanly!
    let old_draft = SpoolItem {
        id: "SP-2-olddraft".into(),
        origin: "https://example.test".into(),
        identity: Some("default".into()),
        path: "/v1/sessions/S-1/workshop".into(),
        session_id: Some("S-1".into()),
        problem_id: Some("P-4DSP".into()),
        state: SpoolState::Unsent,
        idempotency_key: None,
        body_json: r#"{"type":"note","title":"Old draft","body_md":"Still valid."}"#.into(),
        body_sha256: asimp::validate::sha256_hex(
            br#"{"body_md":"Still valid.","title":"Old draft","type":"note"}"#,
        ),
        client_occurred_at: format_utc_rfc3339(t0 - 24 * 3600),
        created_epoch_s: t0 - 24 * 3600,
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
    save_item(&spool_dir, &old_draft).unwrap();

    let server_now = t0 + REPLAY_WINDOW_SECONDS + 3_600; // 25h after t0
    // Local clock is skewed backward by 10 hours — server_now MUST win!
    let skewed_local_now = t0 + 15 * 3600;

    let sync_cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "https://example.test",
        "sync",
        "--spool-dir",
        spool_dir.to_str().unwrap(),
        "--json",
    ])
    .unwrap();
    let mut posted_urls = Vec::new();
    let out = spool::run_sync_with_io(
        &sync_cli,
        "https://example.test",
        "0.2.0-draft",
        Some("token-placeholder"),
        Some(server_now),
        skewed_local_now,
        |url, _, _, key, _, _| {
            assert!(!key.is_empty());
            assert_ne!(
                key, "orig-immutable-key",
                "expired item MUST NEVER be posted"
            );
            posted_urls.push(url.to_owned());
            Ok(SyncPostResponse {
                status: 201,
                body: r#"{"workshop_id":"W-NEW"}"#.into(),
                server_epoch_s: Some(server_now),
                deprecation: None,
            })
        },
    );
    assert_eq!(out.exit_code, 1); // unknown_commit present
    assert_eq!(
        posted_urls,
        vec!["https://example.test/v1/sessions/S-1/workshop"]
    );

    let items = load_all_items(&spool_dir).unwrap();
    let a = items.iter().find(|i| i.id == "SP-1-expired").unwrap();
    let b = items.iter().find(|i| i.id == "SP-2-olddraft").unwrap();
    assert_eq!(a.state, SpoolState::UnknownCommit);
    assert_eq!(a.idempotency_key.as_deref(), Some("orig-immutable-key")); // key NOT rotated!
    assert_eq!(a.attempts, 1); // NOT retried!
    assert_eq!(b.state, SpoolState::Committed);
    assert!(b.idempotency_key.is_some());

    // Doctor must report unknown_commit + clock_skew + cursor corruption, each with a remediation!
    let cursor_cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "https://example.test",
        "spool",
        "cursor-set",
        "P-4DSP",
        "999",
        "--spool-dir",
        spool_dir.to_str().unwrap(),
    ])
    .unwrap();
    assert_eq!(spool::run_spool(&cursor_cli).exit_code, 0);

    let doc_cli = Cli::try_parse_from([
        "asimp",
        "--origin",
        "https://example.test",
        "doctor",
        "--spool-dir",
        spool_dir.to_str().unwrap(),
        "--snapshot-dir",
        snap_dir.to_str().unwrap(),
        "--json",
    ])
    .unwrap();
    let doc_out = doctor::run_with_io(
        &doc_cli,
        TokenSource::Absent,
        skewed_local_now,
        |url, _, _| {
            if url.ends_with("/capabilities") {
                Some(DoctorProbeResponse {
                    status: 200,
                    body:
                        r#"{"version":"0.2.0-draft","supported_protocol_versions":["0.2.0-draft"]}"#
                            .into(),
                    server_version: Some("0.2.0-draft".into()),
                    deprecation: None,
                    sunset: None,
                    link: None,
                    server_epoch_s: Some(server_now),
                })
            } else if url.contains("/events.ndjson") {
                Some(DoctorProbeResponse {
                    status: 200,
                    body: "{\"control\":\"page_end\",\"through\":5}\n".into(),
                    server_version: Some("0.2.0-draft".into()),
                    deprecation: None,
                    sunset: None,
                    link: None,
                    server_epoch_s: Some(server_now),
                })
            } else {
                Some(DoctorProbeResponse {
                    status: 200,
                    body: "5".into(),
                    server_version: Some("0.2.0-draft".into()),
                    deprecation: None,
                    sunset: None,
                    link: None,
                    server_epoch_s: Some(server_now),
                })
            }
        },
    );
    assert_eq!(doc_out.exit_code, 1);
    let report: Value = serde_json::from_str(&doc_out.stdout).unwrap();
    for finding in report["findings"].as_array().unwrap() {
        let status = finding["status"].as_str().unwrap();
        if status == "fail" || status == "warn" {
            assert!(
                finding["remediation"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty()),
                "every warn/fail finding must pair a remediation: {finding}"
            );
        }
    }
    assert!(
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["check"] == "cursors" && f["status"] == "fail")
    );
    assert!(
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["check"] == "clock_skew" && f["status"] == "warn")
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn spool_enqueue_refuses_one_time_exchanges_and_p7_secrets() {
    let dir = std::env::temp_dir().join(format!("asimp-spool-refuse-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let spool_dir = dir.join("spool");

    let ok_json = dir.join("req.json");
    fs::write(&ok_json, r#"{"hello":"world"}"#).unwrap();

    // 1. One-time enrollment exchange is refused with exit 2.
    let enroll = asimp_bin()
        .args([
            "spool",
            "enqueue",
            "--path",
            "/v1/fellows",
            "--file",
            ok_json.to_str().unwrap(),
            "--spool-dir",
            spool_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(enroll.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&enroll.stderr).contains("One-time enrollment"));

    // 2. P7 secret-bearing request is refused with exit 1 and never echoed.
    let secret = format!("ghp_{}", "q".repeat(36));
    let leaky = dir.join("leaky.json");
    fs::write(&leaky, format!(r#"{{"statement":"leaked {secret}"}}"#)).unwrap();
    let res = asimp_bin()
        .args([
            "spool",
            "enqueue",
            "--path",
            "/v1/sessions/S-1/promote",
            "--file",
            leaky.to_str().unwrap(),
            "--spool-dir",
            spool_dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(res.status.code(), Some(1));
    assert!(!String::from_utf8_lossy(&res.stdout).contains(&secret));
    assert!(!String::from_utf8_lossy(&res.stderr).contains(&secret));

    let _ = fs::remove_dir_all(&dir);
}
