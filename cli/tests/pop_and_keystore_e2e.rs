use asimp::{
    credentials::{CredentialStore, ENCRYPTED_STORE_DEFAULT_ITERATIONS, EncryptedFileStore},
    pop::{PopKey, verify_signature_header},
};
use clap::Parser;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const POP_VECTORS_JSON: &str = include_str!("pop_vectors.json");

fn hex_to_bytes_32(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64);
    let mut out = [0u8; 32];
    for (idx, chunk) in hex.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let s = std::str::from_utf8(chunk).unwrap();
        out[idx] = u8::from_str_radix(s, 16).unwrap();
    }
    out
}

#[test]
fn published_rfc9421_vectors_match_webcrypto_byte_for_byte() {
    let doc: Value = serde_json::from_str(POP_VECTORS_JSON).expect("valid vectors json");
    let seed = hex_to_bytes_32(doc["seed_hex"].as_str().unwrap());
    let key = PopKey::from_seed(&seed).expect("seed keypair");

    assert_eq!(
        key.public_key_b64url(),
        doc["public_key_b64url"].as_str().unwrap()
    );
    assert_eq!(key.key_id(), doc["key_id"].as_str().unwrap());

    for vec in doc["vectors"].as_array().unwrap() {
        let name = vec["name"].as_str().unwrap();
        let method = vec["method"].as_str().unwrap();
        let target_uri = vec["target_uri"].as_str().unwrap();
        let auth = vec["authorization"].as_str().unwrap();
        let body = vec["body"].as_str().map(str::as_bytes);
        let created = vec["created"].as_u64().unwrap();
        let expires = vec["expires"].as_u64().unwrap();
        let nonce = vec["nonce"].as_str().unwrap();

        let signed = key
            .sign_request(method, target_uri, auth, body, created, expires, nonce)
            .unwrap_or_else(|e| panic!("vector {name} sign failed: {e}"));

        assert_eq!(
            signed.content_digest.as_deref(),
            vec["content_digest"].as_str(),
            "content_digest mismatch on {name}"
        );
        assert_eq!(
            signed.signature_input,
            vec["signature_input"].as_str().unwrap(),
            "signature_input mismatch on {name}"
        );
        assert_eq!(
            signed.signature_base,
            vec["signature_base"].as_str().unwrap(),
            "signature_base mismatch on {name}"
        );
        assert_eq!(
            signed.signature,
            vec["signature"].as_str().unwrap(),
            "Ed25519 signature bytes must match TypeScript WebCrypto identically on {name}"
        );
        assert!(verify_signature_header(
            key.public_key_bytes(),
            &signed.signature_base,
            &signed.signature
        ));
    }
}

#[test]
fn cli_pop_keygen_and_live_http_pop_headers_round_trip() {
    let dir = std::env::temp_dir().join(format!(
        "asimp-pop-e2e-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let key_path = dir.join("fellow-pop.key.json");

    // 1. Run `asimp pop keygen --out <path> --json`
    let keygen_cli = asimp::Cli::try_parse_from([
        "asimp",
        "pop",
        "keygen",
        "--out",
        key_path.to_str().unwrap(),
        "--json",
    ])
    .unwrap();
    let keygen_out = asimp::run_cli(&keygen_cli);
    assert_eq!(keygen_out.exit_code, 0, "stderr={}", keygen_out.stderr);
    let keygen_doc: Value = serde_json::from_str(&keygen_out.stdout).unwrap();
    assert_eq!(keygen_doc["credential_profile"], "http-message-signature");
    assert_eq!(keygen_doc["alg"], "ed25519");
    let expected_key_id = keygen_doc["key_id"].as_str().unwrap().to_string();
    assert!(expected_key_id.starts_with("ed25519:"));
    // Never print private key material to stdout!
    assert!(!keygen_out.stdout.contains("pkcs8"));

    let loaded_key = PopKey::load_private_file(&key_path).unwrap();
    assert_eq!(loaded_key.key_id(), expected_key_id);

    // 2. Start a real local loopback HTTP server capturing headers on GET /v1/hello.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let captured_headers: Arc<Mutex<BTreeMap<String, String>>> =
        Arc::new(Mutex::new(BTreeMap::new()));
    let cap_clone = Arc::clone(&captured_headers);

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut req_line = String::new();
        reader.read_line(&mut req_line).unwrap();
        let mut headers = BTreeMap::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        *cap_clone.lock().unwrap() = headers;
        let body = r#"{"fellow_id":"F-POPTEST","credential_profile":"http-message-signature"}"#;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(resp.as_bytes()).unwrap();
        let mut sink = [0u8; 8];
        let _ = stream.read(&mut sink);
    });

    // Run `asimp` HTTP request with PopKey attached.
    let target_url = format!("http://{addr}/v1/hello");
    let token = "asimp_ag_01JXYZ4K6QABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let fetched = asimp::fetch_text_with_pop(&target_url, token, &loaded_key).unwrap();
    assert_eq!(fetched.status, 200);
    server.join().unwrap();

    let hdrs = captured_headers.lock().unwrap();
    let sig_input = hdrs
        .get("signature-input")
        .expect("missing signature-input header");
    let sig = hdrs.get("signature").expect("missing signature header");
    assert!(sig_input.contains(&expected_key_id));
    assert!(sig_input.contains("tag=\"asimposium-pop-v1\""));
    assert!(sig.starts_with("sig1=:"));

    // Independently reconstruct RFC 9421 signature base and verify the live signature!
    let params = sig_input.strip_prefix("sig1=").unwrap();
    let base = format!(
        "\"@method\": GET\n\"@authority\": {addr}\n\"@target-uri\": {target_url}\n\"authorization\": Bearer {token}\n\"@signature-params\": {params}"
    );
    assert!(verify_signature_header(
        loaded_key.public_key_bytes(),
        &base,
        sig
    ));
}

#[test]
fn encrypted_store_default_600k_iterations_round_trips_securely() {
    let dir = std::env::temp_dir().join(format!(
        "asimp-enc-600k-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = dir.join("credentials.enc");
    let mut store = EncryptedFileStore::new(
        path.clone(),
        "https://a-staging.asimposium.org",
        "default",
        b"my-ephemeral-e2e-passphrase".to_vec(),
    )
    .unwrap();
    let secret = "asimp_ag_01JXYZ4K6QABCDEFGHJKMNPQRS_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    store.save(secret).unwrap();
    let disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        disk["iterations"].as_u64(),
        Some(u64::from(ENCRYPTED_STORE_DEFAULT_ITERATIONS))
    );
    assert_eq!(store.load().unwrap().as_deref(), Some(secret));
}
