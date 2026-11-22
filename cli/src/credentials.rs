//! The OS owns encryption and unlock policy. No bearer or enrollment secret is
//! written to a configuration file, subprocess argument, or diagnostic.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey},
    pbkdf2::{self, PBKDF2_HMAC_SHA256},
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub(crate) const KEYCHAIN_UNAVAILABLE: &str = "The operating-system keychain is unavailable or locked. On Linux install secret-tool and unlock a Secret Service keyring; on macOS unlock your login keychain. Alternatively use the encrypted file store (~/.asimp/credentials.enc with ASIMP_KEYSTORE_PASSPHRASE_FILE/FD), or paste the URL instead / use ASIMP_TOKEN with the documented curl enrollment flow. No enrollment request was sent unless a saved flow already exists.";
const SERVICE: &str = "org.asimposium.cli.v1";
const MAX_RECORD_BYTES: usize = 6_000;
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);
const ENCRYPTED_STORE_VERSION: u32 = 1;
const ENCRYPTED_STORE_KDF: &str = "pbkdf2-hmac-sha256";
const ENCRYPTED_STORE_AEAD: &str = "chacha20-poly1305";
pub const ENCRYPTED_STORE_DEFAULT_ITERATIONS: u32 = 600_000;
const ENCRYPTED_STORE_MIN_ITERATIONS: u32 = 100_000;
const ENCRYPTED_STORE_MAX_FILE_BYTES: usize = 32 * 1024;
const ENCRYPTED_STORE_SALT_LEN: usize = 16;
const ENCRYPTED_STORE_NONCE_LEN: usize = 12;

pub trait CredentialStore {
    fn load(&mut self) -> Result<Option<String>, &'static str>;
    fn save(&mut self, value: &str) -> Result<(), &'static str>;
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Accepts production (`https://a.asimposium.org`), staging (`https://a-staging.asimposium.org`),
/// and operator-owned HTTPS preview subdomains (`https://<label>.asimposium.org`) with no port,
/// credentials, path, query, or fragment.
pub(crate) fn trusted_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "https://a.asimposium.org" | "https://a-staging.asimposium.org"
    ) {
        return true;
    }
    let Some(host) = origin.strip_prefix("https://") else {
        return false;
    };
    if host.contains(['/', ':', '?', '#', '@']) {
        return false;
    }
    let Some(prefix) = host.strip_suffix(".asimposium.org") else {
        return false;
    };
    !prefix.is_empty()
        && prefix.len() <= 63
        && !prefix.starts_with('-')
        && !prefix.ends_with('-')
        && prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Clone, Copy)]
enum Backend {
    SecretService,
    MacKeychain,
}

struct HelperOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    had_stderr: bool,
}

/// Native helpers are fixed executables, never a shell or caller-supplied
/// command. Read pipes concurrently, cap their bytes, and reap on timeout.
fn run_helper(
    executable: &Path,
    args: &[String],
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<HelperOutput, &'static str> {
    let mut child = Command::new(executable)
        .args(args)
        .env_remove("ASIMP_TOKEN")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| KEYCHAIN_UNAVAILABLE)?;
    let stdout = child.stdout.take().ok_or(KEYCHAIN_UNAVAILABLE)?;
    let stderr = child.stderr.take().ok_or(KEYCHAIN_UNAVAILABLE)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(8_193).read_to_end(&mut bytes).map(|_| bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(1_025)
            .read_to_end(&mut bytes)
            .map(|_| !bytes.is_empty())
    });
    let writer = input.map(|bytes| {
        let stdin = child.stdin.take();
        std::thread::spawn(move || match stdin {
            Some(mut stdin) => stdin.write_all(&bytes),
            None => Err(std::io::Error::other("missing helper input")),
        })
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let write_ok = writer.is_none_or(|writer| matches!(writer.join(), Ok(Ok(()))));
    let output = reader
        .join()
        .map_err(|_| KEYCHAIN_UNAVAILABLE)?
        .map_err(|_| KEYCHAIN_UNAVAILABLE)?;
    let had_stderr = errors
        .join()
        .map_err(|_| KEYCHAIN_UNAVAILABLE)?
        .map_err(|_| KEYCHAIN_UNAVAILABLE)?;
    let status = status.ok_or(KEYCHAIN_UNAVAILABLE)?;
    if !write_ok || output.len() > 8_192 {
        return Err(KEYCHAIN_UNAVAILABLE);
    }
    Ok(HelperOutput {
        status: status.code(),
        stdout: output,
        had_stderr,
    })
}

pub(crate) struct NativeKeychain {
    backend: Backend,
    executable: PathBuf,
    account: String,
}

impl NativeKeychain {
    pub(crate) fn new(origin: &str, identity: &str) -> Result<Self, &'static str> {
        if !trusted_origin(origin) || !valid_identity(identity) {
            return Err(
                "Saved credentials require the exact production or staging Stoa origin and a 1–64 character --identity containing letters, digits, hyphens or underscores. ASIMP_TOKEN remains available for other explicitly configured HTTPS origins.",
            );
        }
        let (backend, executable) = if cfg!(target_os = "linux") {
            (
                Backend::SecretService,
                PathBuf::from("/usr/bin/secret-tool"),
            )
        } else if cfg!(target_os = "macos") {
            (Backend::MacKeychain, PathBuf::from("/usr/bin/security"))
        } else {
            return Err(KEYCHAIN_UNAVAILABLE);
        };
        Ok(Self {
            backend,
            executable,
            account: format!("{origin}|{identity}"),
        })
    }

    fn lookup_args(&self) -> Vec<String> {
        match self.backend {
            Backend::SecretService => vec![
                "lookup".into(),
                "service".into(),
                SERVICE.into(),
                "account".into(),
                self.account.clone(),
            ],
            Backend::MacKeychain => vec![
                "find-generic-password".into(),
                "-s".into(),
                SERVICE.into(),
                "-a".into(),
                self.account.clone(),
                "-w".into(),
            ],
        }
    }

    fn store_request(&self, value: &str) -> Result<(Vec<String>, Vec<u8>), &'static str> {
        if value.len() > MAX_RECORD_BYTES {
            return Err(
                "Enrollment metadata exceeds the keychain record bound; shorten optional metadata before starting enrollment.",
            );
        }
        // An encoding, not home-made encryption: encryption belongs to the OS.
        // Printable ASCII also round-trips through security(1)'s password reader.
        let encoded = URL_SAFE_NO_PAD.encode(value.as_bytes());
        match self.backend {
            Backend::SecretService => Ok((
                vec![
                    "store".into(),
                    "--label=ASImposium Fellow credential".into(),
                    "service".into(),
                    SERVICE.into(),
                    "account".into(),
                    self.account.clone(),
                ],
                encoded.into_bytes(),
            )),
            Backend::MacKeychain => {
                // security -i tokenizes stdin without invoking a shell. Both
                // account and encoded value are restricted ASCII; no injection
                // or secret is possible in argv. Its input line limit is 4096.
                let command = format!(
                    "add-generic-password -U -s {SERVICE} -a '{}' -w {encoded}\n",
                    self.account
                );
                if command.len() >= 4_096 {
                    return Err(
                        "Enrollment metadata exceeds the macOS keychain helper's input bound; shorten optional metadata before starting enrollment.",
                    );
                }
                Ok((vec!["-i".into()], command.into_bytes()))
            }
        }
    }
}

impl CredentialStore for NativeKeychain {
    fn load(&mut self) -> Result<Option<String>, &'static str> {
        let output = run_helper(&self.executable, &self.lookup_args(), None, HELPER_TIMEOUT)?;
        let missing = match self.backend {
            Backend::SecretService => {
                output.status == Some(1) && !output.had_stderr && output.stdout.is_empty()
            }
            Backend::MacKeychain => output.status == Some(44) && output.stdout.is_empty(),
        };
        if missing {
            return Ok(None);
        }
        if output.status != Some(0) {
            return Err(KEYCHAIN_UNAVAILABLE);
        }
        let encoded = std::str::from_utf8(&output.stdout)
            .map_err(|_| KEYCHAIN_UNAVAILABLE)?
            .trim_end_matches(['\r', '\n']);
        let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "The saved keychain record is invalid; use another --identity rather than overwriting it.")?;
        if decoded.len() > MAX_RECORD_BYTES {
            return Err(KEYCHAIN_UNAVAILABLE);
        }
        String::from_utf8(decoded)
            .map(Some)
            .map_err(|_| KEYCHAIN_UNAVAILABLE)
    }

    fn save(&mut self, value: &str) -> Result<(), &'static str> {
        let (args, input) = self.store_request(value)?;
        let output = run_helper(&self.executable, &args, Some(input), HELPER_TIMEOUT)?;
        if output.status != Some(0) {
            return Err(KEYCHAIN_UNAVAILABLE);
        }
        // Interactive security can complete after an individual command fails.
        // Only exact readback establishes that the flow/token is recoverable.
        if self.load()?.as_deref() != Some(value) {
            return Err(KEYCHAIN_UNAVAILABLE);
        }
        Ok(())
    }
}

/// Serialize mutations of one local identity across CLI processes. This file
/// contains no credential and is retained; the OS releases its lock on exit.
pub(crate) fn lock_identity(origin: &str, identity: &str) -> Result<File, &'static str> {
    if !trusted_origin(origin) || !valid_identity(identity) {
        return Err("Invalid local credential identity.");
    }
    let home = std::env::var_os("HOME")
        .ok_or("HOME is required for the local enrollment lock; no credential is written there.")?;
    let root = PathBuf::from(home).join(".asimp");
    let origin_slug = if origin == crate::DEFAULT_ORIGIN {
        "production".to_string()
    } else if origin == "https://a-staging.asimposium.org" {
        "staging".to_string()
    } else {
        origin
            .strip_prefix("https://")
            .unwrap_or("custom")
            .replace('.', "_")
    };
    lock_at(&root, &format!("auth-{origin_slug}-{identity}.lock"))
}

/// Encrypted-file credential fallback (`~/.asimp/credentials.enc`) for headless
/// Linux/Windows environments without OS keychain access (Fable §12).
///
/// Security properties:
/// - Strict `0700` parent directory and `0600` regular non-symlink file perms;
///   refuses `0644` or symlink files BEFORE reading or writing.
/// - Audited `ring` PBKDF2-HMAC-SHA256 (600,000 iterations default) +
///   ChaCha20-Poly1305 AEAD with fresh 96-bit CSPRNG nonce per write.
/// - AEAD Additional Authenticated Data binds `"asimp-cred-v1|<origin>|<identity>"`
///   so ciphertext cannot be transplanted across origins or identities.
/// - Passphrase is read from `ASIMP_KEYSTORE_PASSPHRASE_FD` or a `0600`
///   `ASIMP_KEYSTORE_PASSPHRASE_FILE` (NEVER CLI argv) and zeroized on drop.
/// - Zero plaintext fallback: if unusable, emits the Fable §12 hint
///   (*"paste the URL instead / use ASIMP_TOKEN"*).
pub struct EncryptedFileStore {
    path: PathBuf,
    origin: String,
    identity: String,
    passphrase: Zeroizing<Vec<u8>>,
    iterations: u32,
}

impl EncryptedFileStore {
    pub fn new(
        path: PathBuf,
        origin: &str,
        identity: &str,
        passphrase: Vec<u8>,
    ) -> Result<Self, &'static str> {
        Self::with_iterations(
            path,
            origin,
            identity,
            passphrase,
            ENCRYPTED_STORE_DEFAULT_ITERATIONS,
        )
    }

    pub fn with_iterations(
        path: PathBuf,
        origin: &str,
        identity: &str,
        passphrase: Vec<u8>,
        iterations: u32,
    ) -> Result<Self, &'static str> {
        if !trusted_origin(origin) || !valid_identity(identity) {
            return Err(
                "Encrypted credential storage requires a trusted *.asimposium.org HTTPS origin and valid --identity; paste the URL instead / use ASIMP_TOKEN.",
            );
        }
        if passphrase.is_empty() {
            return Err(
                "Encrypted credential store requires a non-empty passphrase via ASIMP_KEYSTORE_PASSPHRASE_FD or 0600 ASIMP_KEYSTORE_PASSPHRASE_FILE; otherwise paste the URL instead / use ASIMP_TOKEN.",
            );
        }
        if iterations < ENCRYPTED_STORE_MIN_ITERATIONS {
            return Err(
                "Encrypted credential store PBKDF2 iteration count is below minimum bound.",
            );
        }
        Ok(Self {
            path,
            origin: origin.to_string(),
            identity: identity.to_string(),
            passphrase: Zeroizing::new(passphrase),
            iterations,
        })
    }

    /// Reads the keystore passphrase from `ASIMP_KEYSTORE_PASSPHRASE_FILE` (strictly
    /// `0600` regular non-symlink) or `ASIMP_KEYSTORE_PASSPHRASE_FD` (Unix FD).
    /// Never reads passphrases from CLI argv.
    pub fn read_passphrase_from_env() -> Result<Zeroizing<Vec<u8>>, &'static str> {
        if let Ok(file_path) = std::env::var("ASIMP_KEYSTORE_PASSPHRASE_FILE") {
            let path = PathBuf::from(&file_path);
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|_| "Cannot inspect ASIMP_KEYSTORE_PASSPHRASE_FILE; paste the URL instead / use ASIMP_TOKEN.")?;
            if !meta.is_file() {
                return Err(
                    "ASIMP_KEYSTORE_PASSPHRASE_FILE must be a regular file, not a symlink; paste the URL instead / use ASIMP_TOKEN.",
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o077 != 0 {
                    return Err(
                        "ASIMP_KEYSTORE_PASSPHRASE_FILE must have 0600 permissions; paste the URL instead / use ASIMP_TOKEN.",
                    );
                }
            }
            let mut raw = Zeroizing::new(
                std::fs::read(&path)
                    .map_err(|_| "Cannot read ASIMP_KEYSTORE_PASSPHRASE_FILE; paste the URL instead / use ASIMP_TOKEN.")?,
            );
            while matches!(raw.last(), Some(b'\n' | b'\r')) {
                raw.pop();
            }
            if raw.is_empty() {
                return Err(
                    "ASIMP_KEYSTORE_PASSPHRASE_FILE is empty; paste the URL instead / use ASIMP_TOKEN.",
                );
            }
            return Ok(raw);
        }
        #[cfg(unix)]
        if let Ok(fd_str) = std::env::var("ASIMP_KEYSTORE_PASSPHRASE_FD") {
            let fd: u32 = fd_str.trim().parse().map_err(
                |_| "ASIMP_KEYSTORE_PASSPHRASE_FD must be an open file descriptor number.",
            )?;
            if fd < 3 {
                return Err("ASIMP_KEYSTORE_PASSPHRASE_FD must be >= 3 (not stdin/stdout/stderr).");
            }
            let fd_path = format!("/dev/fd/{fd}");
            let file = File::open(&fd_path)
                .map_err(|_| "Cannot open ASIMP_KEYSTORE_PASSPHRASE_FD via /dev/fd.")?;
            let mut buf = Zeroizing::new(Vec::new());
            file.take(4097)
                .read_to_end(&mut buf)
                .map_err(|_| "Failed reading ASIMP_KEYSTORE_PASSPHRASE_FD.")?;
            if buf.len() > 4096 {
                return Err("ASIMP_KEYSTORE_PASSPHRASE_FD exceeds 4096 bytes.");
            }
            while matches!(buf.last(), Some(b'\n' | b'\r')) {
                buf.pop();
            }
            if buf.is_empty() {
                return Err(
                    "ASIMP_KEYSTORE_PASSPHRASE_FD was empty; paste the URL instead / use ASIMP_TOKEN.",
                );
            }
            return Ok(buf);
        }
        Err(
            "No encrypted keystore passphrase configured (set ASIMP_KEYSTORE_PASSPHRASE_FILE or ASIMP_KEYSTORE_PASSPHRASE_FD), or paste the URL instead / use ASIMP_TOKEN.",
        )
    }

    fn aad_context(&self) -> String {
        format!("asimp-cred-v1|{}|{}", self.origin, self.identity)
    }

    fn derive_key(
        &self,
        salt: &[u8],
        iterations: u32,
    ) -> Result<Zeroizing<[u8; 32]>, &'static str> {
        let iters = NonZeroU32::new(iterations)
            .ok_or("Invalid PBKDF2 iteration count in encrypted credential store.")?;
        let mut key = Zeroizing::new([0u8; 32]);
        pbkdf2::derive(
            PBKDF2_HMAC_SHA256,
            iters,
            salt,
            self.passphrase.as_slice(),
            key.as_mut(),
        );
        Ok(key)
    }

    fn validate_existing_file(&self) -> Result<bool, &'static str> {
        match std::fs::symlink_metadata(&self.path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(
                "Cannot inspect encrypted credential store; paste the URL instead / use ASIMP_TOKEN.",
            ),
            Ok(meta) => {
                if !meta.is_file() {
                    return Err(
                        "Encrypted credential store must be a regular file, not a symlink; refusing to read.",
                    );
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.permissions().mode() & 0o077 != 0 {
                        return Err(
                            "Encrypted credential store has insecure permissions (must be 0600, refusing 0644/group/world-readable file).",
                        );
                    }
                }
                if meta.len() as usize > ENCRYPTED_STORE_MAX_FILE_BYTES {
                    return Err("Encrypted credential store exceeds maximum file size bound.");
                }
                Ok(true)
            }
        }
    }
}

impl CredentialStore for EncryptedFileStore {
    fn load(&mut self) -> Result<Option<String>, &'static str> {
        if !self.validate_existing_file()? {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&self.path)
            .map_err(|_| "Cannot read encrypted credential store.")?;
        let doc: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| "Encrypted credential store is malformed JSON; decryption refused.")?;
        if doc.get("version").and_then(serde_json::Value::as_u64)
            != Some(u64::from(ENCRYPTED_STORE_VERSION))
            || doc.get("kdf").and_then(serde_json::Value::as_str) != Some(ENCRYPTED_STORE_KDF)
            || doc.get("aead").and_then(serde_json::Value::as_str) != Some(ENCRYPTED_STORE_AEAD)
        {
            return Err("Encrypted credential store carries unsupported envelope parameters.");
        }
        let iterations = doc
            .get("iterations")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= ENCRYPTED_STORE_MIN_ITERATIONS)
            .ok_or("Encrypted credential store carries invalid KDF iteration count.")?;
        let aad_context = doc
            .get("aad_context")
            .and_then(serde_json::Value::as_str)
            .ok_or("Encrypted credential store missing aad_context.")?;
        let expected_aad = self.aad_context();
        if aad_context != expected_aad {
            return Err(
                "Encrypted credential store belongs to a different origin or identity; decryption refused.",
            );
        }
        let salt = URL_SAFE_NO_PAD
            .decode(
                doc.get("salt_b64")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("Encrypted credential store missing salt.")?,
            )
            .map_err(|_| "Encrypted credential store has malformed salt.")?;
        if salt.len() != ENCRYPTED_STORE_SALT_LEN {
            return Err("Encrypted credential store salt has unexpected length.");
        }
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(
                doc.get("nonce_b64")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("Encrypted credential store missing nonce.")?,
            )
            .map_err(|_| "Encrypted credential store has malformed nonce.")?;
        let nonce_arr: [u8; ENCRYPTED_STORE_NONCE_LEN] = nonce_bytes
            .try_into()
            .map_err(|_| "Encrypted credential store nonce has unexpected length.")?;
        let mut ciphertext = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(
                    doc.get("ciphertext_b64")
                        .and_then(serde_json::Value::as_str)
                        .ok_or("Encrypted credential store missing ciphertext.")?,
                )
                .map_err(|_| "Encrypted credential store has malformed ciphertext.")?,
        );

        let derived = self.derive_key(&salt, iterations)?;
        let unbound = UnboundKey::new(&CHACHA20_POLY1305, derived.as_ref())
            .map_err(|_| "Failed initializing AEAD key.")?;
        let key = LessSafeKey::new(unbound);
        let plaintext = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce_arr),
                Aad::from(expected_aad.as_bytes()),
                &mut ciphertext,
            )
            .map_err(|_| {
                "Encrypted credential store authentication failed (tampered file or wrong passphrase); zero partial data returned."
            })?;
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err("Decrypted credential record exceeds size bound.");
        }
        let decoded = std::str::from_utf8(plaintext)
            .map_err(|_| "Decrypted credential record is not valid UTF-8.")?
            .to_string();
        Ok(Some(decoded))
    }

    fn save(&mut self, value: &str) -> Result<(), &'static str> {
        if value.len() > MAX_RECORD_BYTES {
            return Err("Credential record exceeds encrypted store size bound.");
        }
        // If an existing file already exists at target path, refuse insecure perms or symlinks first.
        let _ = self.validate_existing_file()?;
        if let Some(parent) = self.path.parent()
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
                .map_err(|_| "Cannot create 0700 directory for encrypted credential store.")?;
            let meta = std::fs::symlink_metadata(parent)
                .map_err(|_| "Cannot inspect encrypted credential store parent directory.")?;
            if !meta.is_dir() {
                return Err("Encrypted credential store parent must be a real directory.");
            }
        }

        let rng = SystemRandom::new();
        let mut salt = [0u8; ENCRYPTED_STORE_SALT_LEN];
        let mut nonce_arr = [0u8; ENCRYPTED_STORE_NONCE_LEN];
        rng.fill(&mut salt)
            .map_err(|_| "CSPRNG failed while generating keystore salt.")?;
        rng.fill(&mut nonce_arr)
            .map_err(|_| "CSPRNG failed while generating keystore nonce.")?;

        let derived = self.derive_key(&salt, self.iterations)?;
        let unbound = UnboundKey::new(&CHACHA20_POLY1305, derived.as_ref())
            .map_err(|_| "Failed initializing AEAD key.")?;
        let key = LessSafeKey::new(unbound);

        let expected_aad = self.aad_context();
        let mut in_out = Zeroizing::new(value.as_bytes().to_vec());
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_arr),
            Aad::from(expected_aad.as_bytes()),
            &mut *in_out,
        )
        .map_err(|_| "AEAD encryption failed for credential store.")?;

        let envelope = serde_json::json!({
            "version": ENCRYPTED_STORE_VERSION,
            "kdf": ENCRYPTED_STORE_KDF,
            "iterations": self.iterations,
            "aead": ENCRYPTED_STORE_AEAD,
            "aad_context": expected_aad,
            "salt_b64": URL_SAFE_NO_PAD.encode(salt),
            "nonce_b64": URL_SAFE_NO_PAD.encode(nonce_arr),
            "ciphertext_b64": URL_SAFE_NO_PAD.encode(in_out.as_slice()),
        });
        let encoded = format!(
            "{}\n",
            serde_json::to_string_pretty(&envelope)
                .map_err(|_| "Failed encoding keystore envelope.")?
        );

        // Write atomically via a unique 0600 sibling temp file, fsync, then rename.
        let mut suffix_bytes = [0u8; 8];
        rng.fill(&mut suffix_bytes)
            .map_err(|_| "CSPRNG failed while generating temp filename.")?;
        let tmp_name = format!(
            ".{}.tmp-{}",
            self.path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("credentials.enc"),
            URL_SAFE_NO_PAD.encode(suffix_bytes)
        );
        let tmp_path = self.path.with_file_name(tmp_name);
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&tmp_path)
            .map_err(|_| "Cannot create temporary 0600 encrypted credential file.")?;
        if file
            .write_all(encoded.as_bytes())
            .and_then(|_| file.sync_all())
            .is_err()
        {
            drop(file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err("Failed writing encrypted credential store.");
        }
        drop(file);
        std::fs::rename(&tmp_path, &self.path).map_err(|_| {
            let _ = std::fs::remove_file(&tmp_path);
            "Failed atomically committing encrypted credential store."
        })?;
        Ok(())
    }
}

fn lock_at(root: &Path, name: &str) -> Result<File, &'static str> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(root) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("Cannot create the private local enrollment lock directory."),
    }
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|_| "Cannot inspect the enrollment lock directory.")?;
    if !metadata.is_dir() {
        return Err("The enrollment lock directory must be a real directory, not a symlink.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "The .asimp directory must be private (mode 0700) before enrollment; no permissions were changed.",
            );
        }
    }
    let path = root.join(name);
    if let Ok(metadata) = std::fs::symlink_metadata(&path)
        && !metadata.is_file()
    {
        return Err("The enrollment lock must be a regular file, not a symlink.");
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|_| "Cannot open the local enrollment lock.")?;
    let held = file
        .metadata()
        .map_err(|_| "Cannot inspect the local enrollment lock.")?;
    let named = std::fs::symlink_metadata(&path)
        .map_err(|_| "Cannot inspect the local enrollment lock.")?;
    if !held.is_file() || !named.is_file() {
        return Err("The enrollment lock must be a regular file.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if held.dev() != named.dev()
            || held.ino() != named.ino()
            || held.permissions().mode() & 0o077 != 0
        {
            return Err("The local enrollment lock must be private and unchanged while opening.");
        }
    }
    file.try_lock().map_err(|_| "Another enrollment is using this origin and --identity. Let it finish, then use asimp auth resume.")?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_keep_all_secret_material_on_stdin() {
        for backend in [Backend::SecretService, Backend::MacKeychain] {
            let keychain = NativeKeychain {
                backend,
                executable: PathBuf::from("unused"),
                account: "https://a.asimposium.org|default".into(),
            };
            let secret = "private-flow-canary\n\"'; unexpected-command";
            let (args, stdin) = keychain.store_request(secret).unwrap();
            assert!(!args.join(" ").contains(secret));
            assert!(!args.join(" ").contains(&URL_SAFE_NO_PAD.encode(secret)));
            let input = String::from_utf8(stdin).unwrap();
            assert!(input.contains(&URL_SAFE_NO_PAD.encode(secret)));
            assert!(!input.contains("unexpected-command"));
            if matches!(backend, Backend::MacKeychain) {
                assert_eq!(input.lines().count(), 1);
            }
        }
    }

    #[test]
    fn storage_is_bound_to_canonical_origins_and_safe_local_identities() {
        for origin in [
            "https://evil.test",
            "https://a.asimposium.org:443",
            "https://a.asimposium.org/",
            "http://127.0.0.1:8787",
        ] {
            assert!(NativeKeychain::new(origin, "default").is_err());
        }
        for identity in ["", "../escape", "default\ncommand", "a b", "a|b", "a'b"] {
            assert!(!valid_identity(identity));
        }
        assert!(valid_identity("codex_proof-2"));
    }

    #[test]
    fn macos_input_bound_prevents_command_truncation() {
        let keychain = NativeKeychain {
            backend: Backend::MacKeychain,
            executable: PathBuf::from("unused"),
            account: "https://a.asimposium.org|default".into(),
        };
        assert!(keychain.store_request(&"x".repeat(3_100)).is_err());
        assert!(keychain.store_request(&"x".repeat(2_500)).is_ok());
    }

    #[test]
    fn lock_excludes_concurrent_process_handles_without_deleting_files() {
        let root = std::env::temp_dir().join(format!(
            "asimp-auth-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = lock_at(&root, "identity.lock").unwrap();
        assert!(lock_at(&root, "identity.lock").is_err());
        assert_eq!(std::fs::read(root.join("identity.lock")).unwrap(), b"");
        drop(first);
        assert!(lock_at(&root, "identity.lock").is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn helper_io_round_trips_stdin_and_timeout_reaps_a_blocked_helper() {
        let secret = b"synthetic-helper-canary".to_vec();
        let output = run_helper(
            Path::new("/bin/cat"),
            &[],
            Some(secret.clone()),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(output.status, Some(0));
        assert_eq!(output.stdout, secret);
        assert!(!output.had_stderr);
        let started = Instant::now();
        assert!(
            run_helper(
                Path::new("/bin/sleep"),
                &["2".into()],
                None,
                Duration::from_millis(30)
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn encrypted_file_store_round_trips_0600_refuses_0644_and_tamper() {
        let dir = std::env::temp_dir().join(format!(
            "asimp-enc-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("credentials.enc");
        let canary_token = "asimp_ag_01JXYZ4K6QABCDEFGHJKMNPQRS_ENCRYPTION_CANARY_TOKEN_012345678";
        let origin = "https://preview-42.asimposium.org";

        let mut store = EncryptedFileStore::with_iterations(
            path.clone(),
            origin,
            "fellow_enc_1",
            b"strong-test-passphrase-for-chacha20".to_vec(),
            ENCRYPTED_STORE_MIN_ITERATIONS,
        )
        .unwrap();

        // Missing file loads cleanly as None.
        assert_eq!(store.load().unwrap(), None);

        // Save encrypts with 0600 permissions and zero plaintext token on disk.
        store.save(canary_token).unwrap();
        let disk_text = std::fs::read_to_string(&path).unwrap();
        assert!(!disk_text.contains(canary_token));
        assert!(!disk_text.contains("ENCRYPTION_CANARY"));
        assert!(!disk_text.contains("strong-test-passphrase"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::symlink_metadata(&path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Exact round-trip succeeds.
        assert_eq!(store.load().unwrap().as_deref(), Some(canary_token));

        // Wrong passphrase fails closed without leaking plaintext.
        let mut wrong_pass = EncryptedFileStore::with_iterations(
            path.clone(),
            origin,
            "fellow_enc_1",
            b"wrong-passphrase".to_vec(),
            ENCRYPTED_STORE_MIN_ITERATIONS,
        )
        .unwrap();
        let err = wrong_pass.load().unwrap_err();
        assert!(!err.contains(canary_token));

        // Cross-origin / cross-identity swap fails closed.
        let mut wrong_origin = EncryptedFileStore::with_iterations(
            path.clone(),
            "https://a.asimposium.org",
            "fellow_enc_1",
            b"strong-test-passphrase-for-chacha20".to_vec(),
            ENCRYPTED_STORE_MIN_ITERATIONS,
        )
        .unwrap();
        assert!(wrong_origin.load().is_err());

        // SHOULD-FAIL CONTROL: 0644 permissions are refused before decryption.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let perm_err = store.load().unwrap_err();
            assert!(perm_err.contains("0600"));
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        // SHOULD-FAIL CONTROL: tampering 1 byte of ciphertext fails AEAD authentication closed.
        let mut doc: serde_json::Value = serde_json::from_str(&disk_text).unwrap();
        let mut ct = URL_SAFE_NO_PAD
            .decode(doc["ciphertext_b64"].as_str().unwrap())
            .unwrap();
        ct[0] ^= 0x01;
        doc["ciphertext_b64"] = serde_json::Value::String(URL_SAFE_NO_PAD.encode(&ct));
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        let tamper_err = store.load().unwrap_err();
        assert!(tamper_err.contains("authentication failed"));
        assert!(!tamper_err.contains(canary_token));

        // Empty passphrase fails with the exact Fable §12 fallback hint.
        let hint_err = EncryptedFileStore::new(path, origin, "fellow_enc_1", Vec::new())
            .err()
            .unwrap();
        assert!(hint_err.contains("paste the URL instead / use ASIMP_TOKEN"));
    }
}
