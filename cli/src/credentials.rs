//! The OS owns encryption and unlock policy. No bearer or enrollment secret is
//! written to a configuration file, subprocess argument, or diagnostic.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) const KEYCHAIN_UNAVAILABLE: &str = "The operating-system keychain is unavailable or locked. On Linux install secret-tool and unlock a Secret Service keyring; on macOS unlock your login keychain. No enrollment request was sent unless a saved flow already exists. Headless callers can continue using sponsor-approved ASIMP_TOKEN and the documented curl enrollment flow.";
const SERVICE: &str = "org.asimposium.cli.v1";
const MAX_RECORD_BYTES: usize = 6_000;
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) trait CredentialStore {
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

pub(crate) fn trusted_origin(origin: &str) -> bool {
    matches!(
        origin,
        "https://a.asimposium.org" | "https://a-staging.asimposium.org"
    )
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
    lock_at(
        &root,
        &format!(
            "auth-{}-{identity}.lock",
            if origin == crate::DEFAULT_ORIGIN {
                "production"
            } else {
                "staging"
            }
        ),
    )
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
}
