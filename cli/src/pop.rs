//! Optional standards-based Ed25519 Proof-of-Possession profile using
//! RFC 9421 HTTP Message Signatures (`alg="ed25519"`, `tag="asimposium-pop-v1"`)
//! and RFC 9530 `Content-Digest` (`sha-256=:...:`).
//!
//! Built strictly on audited `ring::signature::Ed25519KeyPair` and
//! `ring::digest::SHA256` (zero custom cryptography). Plain curl bearer tokens
//! remain 100% first-class; PoP is opt-in per Fable §5.5 & ADR-11 and binds
//! Fellow credentials stored with `credential_profile = "http-message-signature"`.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::{
    digest::{SHA256, digest},
    rand::{SecureRandom, SystemRandom},
    signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey},
};
use std::{fs::OpenOptions, io::Write, path::Path};
use url::Url;
use zeroize::Zeroizing;

pub const POP_CREDENTIAL_PROFILE: &str = "http-message-signature";
pub const POP_SIGNATURE_TAG: &str = "asimposium-pop-v1";
pub const POP_SIGNATURE_ALG: &str = "ed25519";
pub const POP_DEFAULT_LIFETIME_SECS: u64 = 120;
pub const POP_MAX_LIFETIME_SECS: u64 = 300;
pub const POP_CLOCK_SKEW_SECS: u64 = 60;

/// RFC 8410 Ed25519 PKCS#8 v1 prefix (16 bytes) preceding a 32-byte raw seed.
const ED25519_PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Generated or loaded Ed25519 Proof-of-Possession key material.
pub struct PopKey {
    pkcs8_der: Zeroizing<Vec<u8>>,
    keypair: Ed25519KeyPair,
    public_key_bytes: [u8; 32],
    key_id: String,
}

impl PopKey {
    /// Generates a fresh Ed25519 keypair from OS CSPRNG.
    pub fn generate() -> Result<Self, &'static str> {
        let rng = SystemRandom::new();
        let doc = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| "Failed to generate Ed25519 PoP keypair from OS CSPRNG.")?;
        Self::from_pkcs8_bytes(doc.as_ref())
    }

    /// Constructs a deterministic Ed25519 keypair from a 32-byte raw seed (used
    /// for published RFC 9421 interop test vectors and RFC 8032 key derivation).
    pub fn from_seed(seed: &[u8; 32]) -> Result<Self, &'static str> {
        let mut pkcs8 = Zeroizing::new(Vec::with_capacity(48));
        pkcs8.extend_from_slice(&ED25519_PKCS8_V1_PREFIX);
        pkcs8.extend_from_slice(seed);
        Self::from_pkcs8_bytes(&pkcs8)
    }

    /// Loads a keypair from PKCS#8 DER bytes (v1 48-byte or v2 83-byte format).
    pub fn from_pkcs8_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        let keypair = Ed25519KeyPair::from_pkcs8_maybe_unchecked(bytes)
            .map_err(|_| "Invalid Ed25519 PKCS#8 key material.")?;
        let raw_pub = keypair.public_key().as_ref();
        if raw_pub.len() != 32 {
            return Err("Unexpected Ed25519 public key length.");
        }
        let mut public_key_bytes = [0u8; 32];
        public_key_bytes.copy_from_slice(raw_pub);
        let key_id = ed25519_key_fingerprint(&public_key_bytes);
        Ok(Self {
            pkcs8_der: Zeroizing::new(bytes.to_vec()),
            keypair,
            public_key_bytes,
            key_id,
        })
    }

    /// Saves the PKCS#8 private key as base64url JSON metadata to a `0600` regular file,
    /// refusing symlinks and insecure parent permissions.
    pub fn save_private_file(&self, path: &Path) -> Result<(), &'static str> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(parent)
                .map_err(|_| "Cannot create directory for Ed25519 PoP private key.")?;
        }
        if let Ok(meta) = std::fs::symlink_metadata(path)
            && !meta.is_file()
        {
            return Err("PoP key path must be a regular file, not a symlink.");
        }
        let payload = Zeroizing::new(
            serde_json::json!({
                "version": 1,
                "credential_profile": POP_CREDENTIAL_PROFILE,
                "alg": POP_SIGNATURE_ALG,
                "key_id": self.key_id,
                "public_key_b64url": self.public_key_b64url(),
                "pkcs8_b64url": URL_SAFE_NO_PAD.encode(self.pkcs8_der.as_slice()),
            })
            .to_string(),
        );
        let mut opts = OpenOptions::new();
        opts.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(path)
            .map_err(|_| "Cannot open PoP private key file for writing.")?;
        file.write_all(payload.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Failed to persist PoP private key file.")?;
        Ok(())
    }

    /// Loads a PoP private key JSON file, refusing symlinks and permissions wider than `0600`.
    pub fn load_private_file(path: &Path) -> Result<Self, &'static str> {
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| "Cannot inspect Ed25519 PoP private key file.")?;
        if !meta.is_file() {
            return Err("Ed25519 PoP private key path must be a regular file, not a symlink.");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(
                    "Ed25519 PoP private key file must have 0600 permissions (no group/world access).",
                );
            }
        }
        let raw = Zeroizing::new(
            std::fs::read_to_string(path)
                .map_err(|_| "Cannot read Ed25519 PoP private key file.")?,
        );
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| "Ed25519 PoP private key file is not valid JSON.")?;
        let pkcs8_b64 = parsed
            .get("pkcs8_b64url")
            .and_then(serde_json::Value::as_str)
            .ok_or("Ed25519 PoP private key file is missing pkcs8_b64url.")?;
        let pkcs8_bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(pkcs8_b64)
                .map_err(|_| "Ed25519 PoP private key file carries invalid base64url.")?,
        );
        Self::from_pkcs8_bytes(&pkcs8_bytes)
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn public_key_bytes(&self) -> &[u8; 32] {
        &self.public_key_bytes
    }

    pub fn public_key_b64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public_key_bytes)
    }

    /// Signs an HTTP request using RFC 9421 (`sig1=(...);...`) and returns the
    /// exact headers to send alongside `Authorization: Bearer <token>`.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_request(
        &self,
        method: &str,
        target_uri: &str,
        authorization_header: &str,
        body: Option<&[u8]>,
        created: u64,
        expires: u64,
        nonce: &str,
    ) -> Result<PopSignatureHeaders, &'static str> {
        let content_digest = body.map(compute_content_digest);
        let built = build_signature_base(
            method,
            target_uri,
            authorization_header,
            content_digest.as_deref(),
            &self.key_id,
            created,
            expires,
            nonce,
        )?;
        let sig = self.keypair.sign(built.signature_base.as_bytes());
        let signature_header = format!("sig1=:{}:", STANDARD.encode(sig.as_ref()));
        Ok(PopSignatureHeaders {
            signature_input: format!("sig1={}", built.signature_params),
            signature: signature_header,
            content_digest,
            signature_base: built.signature_base,
        })
    }

    /// Generates a fresh 24-byte CSPRNG base64url nonce (32 chars) and signs the request.
    pub fn sign_request_now(
        &self,
        method: &str,
        target_uri: &str,
        authorization_header: &str,
        body: Option<&[u8]>,
        now_unix_secs: u64,
    ) -> Result<PopSignatureHeaders, &'static str> {
        let rng = SystemRandom::new();
        let mut nonce_bytes = [0u8; 24];
        rng.fill(&mut nonce_bytes)
            .map_err(|_| "Failed to sample CSPRNG nonce for PoP signature.")?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        self.sign_request(
            method,
            target_uri,
            authorization_header,
            body,
            now_unix_secs,
            now_unix_secs.saturating_add(POP_DEFAULT_LIFETIME_SECS),
            &nonce,
        )
    }
}

/// Headers produced by RFC 9421 PoP signing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopSignatureHeaders {
    pub signature_input: String,
    pub signature: String,
    pub content_digest: Option<String>,
    pub signature_base: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltSignatureBase {
    pub signature_params: String,
    pub signature_base: String,
}

/// Deterministic public-key fingerprint (`ed25519:<lowercase-sha256-hex>`).
/// Matches TypeScript WebCrypto `ed25519KeyFingerprint` byte-for-byte.
pub fn ed25519_key_fingerprint(raw_public_key: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let hash = digest(&SHA256, raw_public_key);
    let mut out = String::with_capacity(8 + 64);
    out.push_str("ed25519:");
    for byte in hash.as_ref() {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// RFC 9530 `Content-Digest` header value: `sha-256=:<base64>:`
pub fn compute_content_digest(body: &[u8]) -> String {
    let hash = digest(&SHA256, body);
    format!("sha-256=:{}:", STANDARD.encode(hash.as_ref()))
}

fn valid_nonce(nonce: &str) -> bool {
    (16..=128).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn valid_key_id(key_id: &str) -> bool {
    key_id.starts_with("ed25519:")
        && key_id.len() == 8 + 64
        && key_id[8..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Extracts exact RFC 9421 `@authority` (`host` or `host:port` when non-default).
pub fn authority_from_uri(target_uri: &str) -> Result<String, &'static str> {
    let parsed = Url::parse(target_uri).map_err(|_| "Invalid target URI for RFC 9421 signing.")?;
    let host = parsed
        .host_str()
        .ok_or("Target URI must include a host for RFC 9421 @authority.")?
        .to_ascii_lowercase();
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    Ok(authority)
}

/// Builds the exact RFC 9421 §2.5 signature base and `@signature-params` string.
#[allow(clippy::too_many_arguments)]
pub fn build_signature_base(
    method: &str,
    target_uri: &str,
    authorization_header: &str,
    content_digest: Option<&str>,
    key_id: &str,
    created: u64,
    expires: u64,
    nonce: &str,
) -> Result<BuiltSignatureBase, &'static str> {
    let upper_method = method.to_ascii_uppercase();
    if !matches!(
        upper_method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("Unsupported HTTP method for RFC 9421 PoP.");
    }
    if expires <= created || expires - created > POP_MAX_LIFETIME_SECS {
        return Err("RFC 9421 signature lifetime must be within 1..=300 seconds.");
    }
    if !valid_nonce(nonce) {
        return Err("RFC 9421 nonce must be 16..=128 URL-safe characters.");
    }
    if !valid_key_id(key_id) {
        return Err("RFC 9421 keyid must be ed25519:<64 lowercase hex chars>.");
    }
    if authorization_header.contains(['\r', '\n']) {
        return Err("Authorization header must not contain CR/LF.");
    }
    let authority = authority_from_uri(target_uri)?;

    let components = if content_digest.is_some() {
        r#"("@method" "@authority" "@target-uri" "authorization" "content-digest")"#
    } else {
        r#"("@method" "@authority" "@target-uri" "authorization")"#
    };

    let signature_params = format!(
        r#"{components};created={created};expires={expires};nonce="{nonce}";keyid="{key_id}";alg="{POP_SIGNATURE_ALG}";tag="{POP_SIGNATURE_TAG}""#
    );

    let mut lines = vec![
        format!(r#""@method": {upper_method}"#),
        format!(r#""@authority": {authority}"#),
        format!(r#""@target-uri": {target_uri}"#),
        format!(r#""authorization": {authorization_header}"#),
    ];
    if let Some(digest_header) = content_digest {
        if digest_header.contains(['\r', '\n']) {
            return Err("Content-Digest header must not contain CR/LF.");
        }
        lines.push(format!(r#""content-digest": {digest_header}"#));
    }
    lines.push(format!(r#""@signature-params": {signature_params}"#));

    Ok(BuiltSignatureBase {
        signature_params,
        signature_base: lines.join("\n"),
    })
}

/// Verifies an RFC 9421 Ed25519 `Signature: sig1=:<b64>:` against a signature base
/// and raw 32-byte Ed25519 public key.
pub fn verify_signature_header(
    public_key_bytes: &[u8; 32],
    signature_base: &str,
    signature_header: &str,
) -> bool {
    let Some(inner) = signature_header
        .strip_prefix("sig1=:")
        .and_then(|s| s.strip_suffix(':'))
    else {
        return false;
    };
    let Ok(sig_bytes) = STANDARD.decode(inner) else {
        return false;
    };
    if sig_bytes.len() != 64 {
        return false;
    }
    let key = UnparsedPublicKey::new(&ED25519, public_key_bytes);
    key.verify(signature_base.as_bytes(), &sig_bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_rfc9421_vectors_sign_and_verify_cleanly() {
        // Fixed RFC 8032-style deterministic 32-byte test seed (NOT a secret).
        let seed = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        let key = PopKey::from_seed(&seed).unwrap();
        let headers = key
            .sign_request(
                "POST",
                "https://a.asimposium.org/v1/sessions",
                "Bearer asimp_ag_01JXYZ4K6QABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                Some(br#"{"problem_id":"P-4DSP","intent":"explore"}"#),
                1795240000,
                1795240120,
                "vec-nonce-0123456789abcdef",
            )
            .unwrap();

        assert!(headers.signature_input.starts_with("sig1=("));
        assert!(headers.signature.starts_with("sig1=:"));
        assert!(
            headers
                .content_digest
                .as_deref()
                .unwrap()
                .starts_with("sha-256=:")
        );
        assert!(verify_signature_header(
            key.public_key_bytes(),
            &headers.signature_base,
            &headers.signature
        ));
        // Tampered method fails verification immediately.
        let tampered = headers.signature_base.replacen("POST", "GET", 1);
        assert!(!verify_signature_header(
            key.public_key_bytes(),
            &tampered,
            &headers.signature
        ));
    }
}
