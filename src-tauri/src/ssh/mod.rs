use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, Handle};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub mod exec;
pub mod pty;
pub mod sftp;
pub mod skill_run;
pub mod sudo_inject;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// How many SSH handshakes may be in flight at once, across the whole program.
///
/// Opening a wall of terminals fires every connect at the same instant, and an
/// OpenSSH server counts connections that have not finished authenticating
/// against `MaxStartups` — `10:30:100` by default, meaning it starts randomly
/// dropping past ten and refuses everything past a hundred. A dropped one
/// arrives here as a TCP reset ("An existing connection was forcibly closed by
/// the remote host. (os error 10054)"), which is what an operator opening a
/// dozen hosts kept hitting.
///
/// Eight is under that default ceiling with room for the other tabs to breathe,
/// and the wait is only for the handshake: a permit is released the moment auth
/// finishes, so the sessions themselves are as parallel as they ever were. On a
/// small batch nothing queues at all.
const MAX_CONCURRENT_HANDSHAKES: usize = 8;

/// How many times a *reset* connect is retried before it is reported. Only
/// resets: a refused or timed-out connect means the host is not there, and
/// retrying that would just make a slow failure slower.
const HANDSHAKE_RETRIES: usize = 2;

fn handshake_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_HANDSHAKES))
}

/// Whether a failure is the server hanging up mid-handshake rather than a host
/// that isn't answering. Matched on the message because it reaches us as a
/// stringified `std::io::Error` from inside russh: Windows says "forcibly
/// closed" (WSAECONNRESET, os error 10054), Unix says "reset by peer".
fn is_connection_reset(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("forcibly closed")
        || m.contains("reset by peer")
        || m.contains("connection reset")
        || m.contains("10054")
}

/// Backoff before retry `attempt` (0-based), spread out so a batch that was
/// dropped together does not come back in lockstep and get dropped together
/// again. The spread is derived from the clock rather than a random number
/// generator, which is plenty for jitter and costs no dependency.
fn handshake_backoff(attempt: usize) -> Duration {
    let base = 250u64 << attempt;
    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0))
        % 250;
    Duration::from_millis(base + jitter)
}
/// Bound on the `echo $SHELL` probe. Short on purpose: it is a nicety, and a
/// server that will not answer it must not hold up opening the terminal.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Shells that can *parse* [`crate::omni::SHELL_INTEGRATION`] without erroring,
/// whether or not they take one of its branches. This is the gate on sending
/// the line at all.
///
/// The `if [ ... ]; then ... elif ... fi` form is POSIX, so every Bourne-family
/// shell reads it fine and simply falls through both branches. fish, csh and
/// tcsh are *not* Bourne-family: they fail at parse time and abort the whole
/// line, which used to leave a fish tab showing a parse error and missing the
/// clear, MOTD and last-login that ride on the same line.
pub fn shell_can_parse_integration(shell: &str) -> bool {
    matches!(
        shell_name(shell).as_str(),
        "bash" | "zsh" | "sh" | "dash" | "ash" | "ksh" | "ksh93" | "mksh" | "pdksh"
    )
}

/// Shells that actually install the OSC 133 hooks, so MultiTerminal can track
/// command blocks with exit codes. A subset of
/// [`shell_can_parse_integration`]: the others parse the line and no-op.
pub fn shell_supports_integration(shell: &str) -> bool {
    matches!(shell_name(shell).as_str(), "bash" | "zsh")
}

/// Whether a line of the shell probe's output could be the value of `$SHELL`:
/// a single absolute path, no whitespace in it, not a bare directory.
///
/// Deliberately strict. Everything a chatty rc file prints — banners, `Last
/// login:` lines, MOTD fragments, the literal `$SHELL` from a shell that does
/// not expand it — fails at least one of these, and a line we cannot vouch for
/// is better dropped than believed: the only thing the answer drives is a
/// warning chip, and a wrong chip is worse than no chip.
fn looks_like_shell_path(line: &str) -> bool {
    line.starts_with('/')
        && line.len() > 1
        && !line.ends_with('/')
        && !line.contains(char::is_whitespace)
        // A path is all we accept, so anything shell-ish left in the line
        // (an unexpanded variable, a substitution) means we misread it.
        && !line.contains('$')
}

/// The bare shell name from whatever we were given: `/usr/bin/fish` and `fish`
/// both come back as `fish`, lowercased.
pub fn shell_name(shell: &str) -> String {
    shell
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// The host's login shell, probed over a short-lived exec channel on an
/// already-authenticated connection.
///
/// `$SHELL` (the passwd entry) is used rather than `$0` because it expands in
/// every shell we care about, fish and csh included. `$0` does not expand in
/// fish, which is exactly why the skills engine reports a fish host's shell as
/// "unknown" today.
///
/// Returns `None` on any failure at all. A server with a `ForceCommand`, a
/// restricted account, or anything else that will not run this must keep the
/// behaviour it has today, so an unanswerable probe is not an error.
pub(crate) async fn detect_login_shell(handle: &Handle<TofuHandler>) -> Option<String> {
    let probe = async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel.exec(true, "echo $SHELL").await.ok()?;
        let mut out = String::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { ref data }) => {
                    out.push_str(&String::from_utf8_lossy(data));
                    // A login shell path is short; anything longer is noise from
                    // a chatty rc file and we are not going to find it there.
                    if out.len() > 512 {
                        break;
                    }
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        // Take the last line that could actually *be* `$SHELL`, not simply the
        // last non-empty one. An rc file that prints on a non-interactive login
        // puts its output on both sides of the echo, and taking whatever came
        // last read one operator's rc banner as their login shell — the host
        // then wore an "unsupported shell" chip naming a line of their own
        // startup script. Finding nothing that looks like a shell is not an
        // error: `None` means "we could not tell", which warns about nothing.
        let line = out
            .lines()
            .map(str::trim)
            .rev()
            .find(|l| looks_like_shell_path(l))?;
        let name = shell_name(line);
        // `$SHELL` unset echoes back empty, and a shell that does not expand it
        // echoes the literal. Either way we know nothing.
        if name.is_empty() || name.contains('$') {
            return None;
        }
        Some(name)
    };
    tokio::time::timeout(SHELL_PROBE_TIMEOUT, probe)
        .await
        .ok()
        .flatten()
}

/// Key the server presented during the handshake, captured by the handler
/// regardless of whether the connection was allowed to proceed.
#[derive(Debug, Clone, Serialize)]
pub struct PresentedKey {
    pub key_type: String,
    pub public_key: String,
    pub fingerprint_sha256: String,
}

/// What the caller should do about the server key, decided against the
/// trusted fingerprint (if any) the caller passed in.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProbeResult {
    /// Key trusted (or no auth requested) and authentication succeeded.
    Ok {
        latency_ms: u64,
        /// The host's login shell, if the probe could read it. `None` means we
        /// could not tell, not that the shell is unusable.
        login_shell: Option<String>,
    },
    /// No stored key for this endpoint — TOFU prompt needed.
    UnknownKey { key: PresentedKey },
    /// Stored key differs from the presented one — hard warning.
    KeyMismatch {
        stored_fingerprint: String,
        presented: PresentedKey,
    },
    AuthFailed { message: String },
    Unreachable { message: String },
    /// Host has no stored credentials; probe was not attempted.
    NoCredentials,
}

/// Connection attempt outcomes short of an authenticated session. Shared by
/// probe (test connection) and exec (broadcast) so both report key/auth
/// trouble identically.
#[derive(Debug, Clone)]
pub enum ConnectFailure {
    UnknownKey {
        key: PresentedKey,
    },
    KeyMismatch {
        stored_fingerprint: String,
        presented: PresentedKey,
    },
    AuthFailed {
        message: String,
    },
    Unreachable {
        message: String,
    },
}

/// `Clone` so a handshake can be retried after a reset without the caller
/// having to re-read the credential (see `connect_and_auth`).
#[derive(Clone)]
pub enum AuthMethod {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

pub(crate) struct TofuHandler {
    /// Fingerprints we already trust for this endpoint (one per key type).
    trusted_fingerprints: Vec<String>,
    /// Records what the server actually presented.
    seen: Arc<Mutex<Option<PresentedKey>>>,
}

impl client::Handler for TofuHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let presented = PresentedKey {
            key_type: server_public_key.algorithm().to_string(),
            public_key: server_public_key.to_openssh().unwrap_or_default(),
            fingerprint_sha256: fingerprint.clone(),
        };
        *self.seen.lock().unwrap() = Some(presented);
        Ok(self.trusted_fingerprints.contains(&fingerprint))
    }
}

/// TOFU-verified connect + authenticate. `Ok(Err(_))` are expected outcomes
/// (unknown key, wrong password, host down); `Err(_)` are our own failures.
///
/// Wraps [`connect_and_auth_once`] in the two things a burst of connections
/// needs: a permit, so we never present a server with more unauthenticated
/// connections than it will hold open, and a short retry on a reset, for the
/// ones it drops anyway (see [`MAX_CONCURRENT_HANDSHAKES`]).
pub(crate) async fn connect_and_auth(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<Result<Handle<TofuHandler>, ConnectFailure>> {
    // The permit is held for the whole handshake and dropped on return.
    // `acquire` only fails on a closed semaphore, and this one is never closed.
    let _permit = handshake_slots()
        .acquire()
        .await
        .map_err(|e| AppError::Ssh(format!("handshake slot unavailable: {e}")))?;

    for attempt in 0..=HANDSHAKE_RETRIES {
        let outcome = connect_and_auth_once(
            hostname,
            port,
            username,
            // Each attempt gets its own copy; the handler consumes them.
            trusted_fingerprints.clone(),
            auth.clone(),
        )
        .await?;
        match &outcome {
            Err(ConnectFailure::Unreachable { message })
                if attempt < HANDSHAKE_RETRIES && is_connection_reset(message) =>
            {
                tokio::time::sleep(handshake_backoff(attempt)).await;
            }
            _ => return Ok(outcome),
        }
    }
    // Unreachable in practice: the loop either returns or exhausts the retries
    // on the last iteration, which the guard above excludes.
    Ok(Err(ConnectFailure::Unreachable {
        message: "connection reset by the server".into(),
    }))
}

async fn connect_and_auth_once(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<Result<Handle<TofuHandler>, ConnectFailure>> {
    let seen: Arc<Mutex<Option<PresentedKey>>> = Arc::new(Mutex::new(None));
    let handler = TofuHandler {
        trusted_fingerprints: trusted_fingerprints.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config::default());

    let connect = client::connect(config, (hostname, port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Err(_) => {
            return Ok(Err(ConnectFailure::Unreachable {
                message: format!("connection timed out after {}s", CONNECT_TIMEOUT.as_secs()),
            }))
        }
        Ok(Err(russh::Error::UnknownKey)) => {
            // Handler rejected the key; classify from what it recorded.
            let presented = seen.lock().unwrap().clone();
            return Ok(Err(match presented {
                Some(p) if trusted_fingerprints.is_empty() => {
                    ConnectFailure::UnknownKey { key: p }
                }
                Some(p) => ConnectFailure::KeyMismatch {
                    stored_fingerprint: trusted_fingerprints.join(", "),
                    presented: p,
                },
                // Rejected before the handler saw a key — shouldn't happen.
                None => ConnectFailure::Unreachable {
                    message: "server key rejected before capture".into(),
                },
            }));
        }
        Ok(Err(e)) => {
            return Ok(Err(ConnectFailure::Unreachable {
                message: e.to_string(),
            }))
        }
        Ok(Ok(h)) => h,
    };

    let auth_result =
        tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, username, auth)).await;

    match auth_result {
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(Err(ConnectFailure::AuthFailed {
                message: format!("authentication timed out after {}s", AUTH_TIMEOUT.as_secs()),
            }))
        }
        Ok(Err(e)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Err(e)
        }
        Ok(Ok(AuthResult::Success)) => Ok(Ok(handle)),
        Ok(Ok(AuthResult::Failure { .. })) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(Err(ConnectFailure::AuthFailed {
                message: "server rejected the credentials".into(),
            }))
        }
    }
}

/// Connects to hostname:port, runs TOFU key verification against
/// `trusted_fingerprints`, and (when the key checks out) attempts auth.
pub async fn probe(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<ProbeResult> {
    let started = Instant::now();
    match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
        Ok(handle) => {
            // Latency is measured before the shell probe, so Test connection
            // still reports the connect+auth time it always did.
            let latency_ms = started.elapsed().as_millis() as u64;
            let login_shell = detect_login_shell(&handle).await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(ProbeResult::Ok {
                latency_ms,
                login_shell,
            })
        }
        Err(failure) => Ok(failure.into()),
    }
}

impl From<ConnectFailure> for ProbeResult {
    fn from(f: ConnectFailure) -> Self {
        match f {
            ConnectFailure::UnknownKey { key } => ProbeResult::UnknownKey { key },
            ConnectFailure::KeyMismatch {
                stored_fingerprint,
                presented,
            } => ProbeResult::KeyMismatch {
                stored_fingerprint,
                presented,
            },
            ConnectFailure::AuthFailed { message } => ProbeResult::AuthFailed { message },
            ConnectFailure::Unreachable { message } => ProbeResult::Unreachable { message },
        }
    }
}

async fn authenticate(
    handle: &mut Handle<TofuHandler>,
    username: &str,
    auth: AuthMethod,
) -> AppResult<AuthResult> {
    match auth {
        AuthMethod::Password(password) => handle
            .authenticate_password(username, password)
            .await
            .map_err(|e| AppError::Ssh(format!("password auth: {e}"))),
        AuthMethod::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref())
                .map_err(|e| AppError::Ssh(format!("load key {path}: {e}")))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| AppError::Ssh(format!("rsa hash negotiation: {e}")))?
                .flatten();
            handle
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Ssh(format!("publickey auth: {e}")))
        }
    }
}

#[cfg(test)]
mod shell_tests {
    use super::*;

    #[test]
    fn shell_name_takes_the_basename() {
        assert_eq!(shell_name("/usr/bin/fish"), "fish");
        assert_eq!(shell_name("/bin/bash\n"), "bash");
        assert_eq!(shell_name("BASH"), "bash");
        assert_eq!(shell_name(""), "");
    }

    #[test]
    fn bourne_family_can_parse_the_integration() {
        for s in ["/bin/bash", "/bin/zsh", "/bin/sh", "/bin/dash", "/bin/ksh"] {
            assert!(shell_can_parse_integration(s), "{s} should parse");
        }
    }

    #[test]
    fn fish_and_csh_cannot_parse_the_integration() {
        // The whole point of X4: these abort the line at parse time, taking the
        // clear/MOTD/last-login tail down with it.
        for s in ["/usr/bin/fish", "/bin/csh", "/bin/tcsh"] {
            assert!(!shell_can_parse_integration(s), "{s} should not parse");
        }
        // An unrecognised shell is treated as unable to parse rather than
        // assumed safe: a broken tab is worse than a tab without OSC 133.
        assert!(!shell_can_parse_integration("/opt/weird/shell"));
    }

    #[test]
    fn only_bash_and_zsh_install_the_hooks() {
        assert!(shell_supports_integration("/bin/bash"));
        assert!(shell_supports_integration("/bin/zsh"));
        // sh parses the line but takes neither branch, so no block tracking.
        assert!(!shell_supports_integration("/bin/sh"));
        assert!(!shell_supports_integration("/usr/bin/fish"));
    }

    #[test]
    fn a_shell_path_is_recognised() {
        assert!(looks_like_shell_path("/bin/bash"));
        assert!(looks_like_shell_path("/usr/local/bin/zsh"));
    }

    #[test]
    fn rc_file_noise_is_not_a_shell_path() {
        // The reported case: a startup script's own output, taken as the shell
        // because it was simply the last line the probe read.
        assert!(!looks_like_shell_path("rc.inital"));
        assert!(!looks_like_shell_path("Last login: Tue Jul 28 09:14:02 2026"));
        assert!(!looks_like_shell_path("== welcome to prod =="));
        assert!(!looks_like_shell_path(""));
        // A shell that does not expand it echoes the literal back.
        assert!(!looks_like_shell_path("$SHELL"));
        // A bare directory is not an executable.
        assert!(!looks_like_shell_path("/usr/bin/"));
        assert!(!looks_like_shell_path("/"));
    }

    /// The whole point of the change: the probe must reach past trailing rc
    /// output to the line that is actually the shell.
    #[test]
    fn the_shell_is_found_under_trailing_rc_output() {
        let out = "welcome\n/bin/bash\nrc.inital\n";
        let line = out
            .lines()
            .map(str::trim)
            .rev()
            .find(|l| looks_like_shell_path(l));
        assert_eq!(line, Some("/bin/bash"));
        assert_eq!(shell_name(line.unwrap()), "bash");
    }

    #[test]
    fn a_dropped_handshake_is_recognised_as_a_reset() {
        // What Windows hands us when sshd's MaxStartups drops the connection.
        assert!(is_connection_reset(
            "An existing connection was forcibly closed by the remote host. (os error 10054)"
        ));
        assert!(is_connection_reset("Connection reset by peer (os error 104)"));
    }

    #[test]
    fn a_host_that_is_not_there_is_not_a_reset() {
        // These must not be retried: the host is down, and three attempts would
        // only make the failure slower to report.
        assert!(!is_connection_reset("connection timed out after 10s"));
        assert!(!is_connection_reset(
            "No connection could be made because the target machine actively refused it. (os error 10061)"
        ));
    }

    #[test]
    fn the_handshake_backoff_grows_and_stays_bounded() {
        // Base doubles per attempt, plus up to 250ms of clock-derived jitter.
        let first = handshake_backoff(0);
        let second = handshake_backoff(1);
        assert!(first >= Duration::from_millis(250));
        assert!(first < Duration::from_millis(500));
        assert!(second >= Duration::from_millis(500));
        assert!(second < Duration::from_millis(750));
    }
}
