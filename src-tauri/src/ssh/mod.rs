use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, Handle};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub mod connect_curtain;
pub mod exec;
pub mod pty;
pub mod sftp;
pub mod skill_run;
pub mod sudo_inject;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// How often a keepalive goes out on a new connection, in seconds. Zero is off.
///
/// A process-wide setting rather than a per-connect argument, because it is a
/// preference about this copy of Broadside and not about any host: threading it
/// through every caller (terminals, exec, SFTP, skill runs) would be a lot of
/// signature for a number that is the same everywhere. Written by
/// `set_ssh_keepalive` when the app starts and whenever the setting changes.
///
/// Read at connect time, so a change reaches the next connection rather than
/// the ones already up. russh sets the interval when the session starts and
/// there is no supported way to move it afterwards, and reconnecting somebody's
/// live shells to apply a preference would be a much worse trade than waiting.
static KEEPALIVE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Set the keepalive interval for connections opened from now on. Zero is off.
#[tauri::command]
pub fn set_ssh_keepalive(secs: u64) {
    KEEPALIVE_SECS.store(secs, std::sync::atomic::Ordering::Relaxed);
}

/// How many SSH handshakes may be in flight at once, across the whole program.
///
/// Opening a wall of terminals fires every connect at the same instant, and an
/// OpenSSH server counts connections that have not finished authenticating
/// against `MaxStartups`, `10:30:100` by default, meaning it starts randomly
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
/// Bound on the login-shell probe, end to end.
///
/// Three seconds, and described as a bound on a server that will not answer,
/// made this a network timeout. It is not one. The probe runs a command *in the
/// host's login shell*, and a login shell runs the operator's rc file before it
/// runs anything of ours, so this is a budget for somebody else's startup
/// script: an `nvm`, `conda` or `pyenv` block above the `case $- in *i*` guard
/// at the top of a `.bashrc`, or a home directory on a cold NFS mount, any of
/// which costs seconds without the host being slow in any sense the operator
/// would recognise.
///
/// What three seconds did to such a host was not a slower connect, it was a
/// worse one. The probe returned nothing, the host was recorded `Unreadable`,
/// and an unreadable host is sent nothing at all; so command blocks and skills
/// went away, a dialog said the shell could not be read, and the login screen
/// arrived in pieces, because with no setup line there is no `clear` for
/// [`crate::ssh::connect_curtain`] to cut at and nothing for it to hold. One
/// slow rc file, three symptoms, none of them naming the cause.
///
/// It is [`SHELL_PROBE_QUIET`] and the marker below that end the ordinary case,
/// not this. Hosts that answer are not made to wait for this value, and hosts
/// that answer with something that is not a shell are not made to wait for it
/// either. It bounds one case only: a host that says nothing whatsoever.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// How long the probe keeps listening after the host has said something that
/// was not the answer.
///
/// A shell that ran the command closes the channel when it is done, and the
/// close is what ends the probe. A console menu never closes: pfSense's
/// `rc.initial` answers by reprinting itself and waits for the next selection,
/// so on the old code it cost the entire budget and then read as a timeout. So
/// once bytes have arrived without [`SHELL_PROBE_MARK`] among them, a gap this
/// long is taken to mean the host has finished saying whatever it was going to
/// say, and what arrived is parsed as it stands.
///
/// This is why the budget above could be raised without making any real host
/// slower. Silence *before* the host speaks is an rc file still running and is
/// worth waiting out; silence *after* it speaks is an answer, and this is how
/// long it takes to be sure of one.
const SHELL_PROBE_QUIET: Duration = Duration::from_millis(750);

/// What the probe asks the shell to print in front of its answer.
///
/// `echo $SHELL` on its own has no end to it. The reply lands somewhere inside
/// whatever the rc file also printed, so the only way to know all of it had
/// arrived was to wait for the channel to close, and waiting for the close is
/// what made a host that never closes indistinguishable from a host that is
/// merely slow. A marker gives the answer an edge the probe can see: it can
/// stop the instant the answer lands, which is sooner than the close on every
/// host that works, and it can tell "still starting up" from "this is not a
/// shell and no answer is coming".
///
/// Still `echo` and still `$SHELL`, for the reason given on
/// [`detect_login_shell`]: both are understood by every shell this has to
/// survive, fish and csh included. A shell that does not expand it echoes the
/// literal, which the `$` check below still catches.
const SHELL_PROBE_MARK: &str = "__broadside_shell=";

/// How much of the connect-time setup a host's login shell can be given.
///
/// One value decides everything the terminal path does on connect, so the four
/// cases can't drift apart the way two independent predicates could.
///
/// The two silent variants behave *identically* (nothing at all is written
/// to the channel), but they are separate values because they are separate
/// situations and must not say the same thing to the operator. `Unsupported` is
/// a fact and there is nothing to fix; `Unreadable` is a guess, and the host may
/// well be a bash box behind a `ForceCommand` that would work fine if told to.
/// Collapsing them would leave the second case invisible: MultiTerminal would
/// simply show no blocks and nothing would point at the per-host override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellCapability {
    /// bash and zsh: parses the integration *and* installs the OSC 133 hooks,
    /// so MultiTerminal can track command blocks with exit codes.
    Full,
    /// The rest of the Bourne family. The `if [ ... ]; then ... elif ... fi`
    /// form is POSIX, so these read the whole line fine and fall through both
    /// branches, installing nothing. They still get the clear, MOTD reprint and
    /// last-login re-echo that ride on the same line.
    ParseSafe,
    /// A real shell, but not a Bourne-family one: fish, csh, tcsh. These fail
    /// the integration at *parse* time and abort the whole line with it, so they
    /// get only the clear / MOTD / last-login tail, which they do understand.
    ///
    /// Kept as its own tier rather than folded in with the silent ones on
    /// purpose. Sending fish the tail is why a fish tab looks like a fresh login
    /// instead of showing a parse error (X4), and that was deliberate work.
    /// What makes it safe here and not on `rc.initial` is that these are known
    /// *shells*: a line of shell syntax is a line of shell syntax to them, not a
    /// selection from a menu.
    TailOnly,
    /// A name we read that is no shell we know. pfSense's `rc.initial` is the
    /// case that matters: a console menu, genuinely the admin account's
    /// `$SHELL`, which answers anything sent to it by reprinting itself. Send
    /// nothing and leave the login screen exactly as the host drew it.
    ///
    /// An unrecognised name is treated the same way rather than optimistically
    /// given the tail, because the next appliance to do what pfSense does will
    /// also arrive here under a name nobody has seen before.
    Unsupported,
    /// The probe answered nothing at all: a `ForceCommand`, a restricted
    /// account, a server too slow to reply inside [`SHELL_PROBE_TIMEOUT`].
    /// Also send nothing: guessing wrong is how a console menu ends up being
    /// typed into.
    Unreadable,
}

impl ShellCapability {
    /// Whether the OSC 133 integration line is worth prepending. Only `Full`
    /// installs hooks, but `ParseSafe` is included because the line is harmless
    /// there and the [`crate::omni::OmniParser::flush`] fallback still gets a
    /// block out of it.
    pub fn with_integration(self) -> bool {
        matches!(self, Self::Full | Self::ParseSafe)
    }

    /// Whether anything at all may be written to this shell on connect.
    pub fn sends_setup(self) -> bool {
        matches!(self, Self::Full | Self::ParseSafe | Self::TailOnly)
    }

    /// The stored form, and what the frontend matches on.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::ParseSafe => "parse_safe",
            Self::TailOnly => "tail_only",
            Self::Unsupported => "unsupported",
            Self::Unreadable => "unreadable",
        }
    }
}

/// What the connect-time probe read, turned into the one thing that decides
/// what gets sent. `None` means the probe could not answer.
///
/// Note what changed here: an unreadable probe used to fall through to "inject
/// anyway", on the reasoning that the integration is harmless in every
/// Bourne-family shell and refusing it would silently drop command-block
/// tracking. That reasoning only held while the *only* thing at stake was the
/// OSC 133 line. It is not: the same write carries `clear; cat /etc/motd`, and
/// on a pfSense console menu that is a menu selection, which is why the menu
/// printed twice. Unknown is now silent, and the per-host override is how a
/// host that simply won't answer the probe gets its tracking back.
pub fn shell_capability(shell: Option<&str>) -> ShellCapability {
    let Some(shell) = shell else {
        return ShellCapability::Unreadable;
    };
    match shell_name(shell).as_str() {
        "bash" | "zsh" => ShellCapability::Full,
        "sh" | "dash" | "ash" | "ksh" | "ksh93" | "mksh" | "pdksh" => ShellCapability::ParseSafe,
        "fish" | "csh" | "tcsh" => ShellCapability::TailOnly,
        _ => ShellCapability::Unsupported,
    }
}

/// The operator's standing answer for a host, overriding what the probe reads.
///
/// Stored per host so a box that will never answer `echo $SHELL` can still be
/// told what it is, once, instead of losing command-block tracking forever.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellIntegrationPref {
    /// Believe the probe. The default, and what every existing host has.
    #[default]
    Auto,
    /// "It is bash or zsh, I promise." Sends the full setup regardless.
    Always,
    /// "Never write to this host." Sends nothing regardless.
    Never,
}

impl ShellIntegrationPref {
    /// Parses the stored column. Anything unrecognised (including NULL) is
    /// `Auto`, so a database written by a newer build downgrades safely.
    pub fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("always") => Self::Always,
            Some("never") => Self::Never,
            _ => Self::Auto,
        }
    }

    /// Resolves the preference against what the probe read.
    pub fn resolve(self, probed: ShellCapability) -> ShellCapability {
        match self {
            Self::Auto => probed,
            Self::Always => ShellCapability::Full,
            Self::Never => ShellCapability::Unsupported,
        }
    }
}

/// Whether a line of the shell probe's output could be the value of `$SHELL`:
/// a single absolute path, no whitespace in it, not a bare directory.
///
/// Deliberately strict. Everything a chatty rc file prints (banners, `Last
/// login:` lines, MOTD fragments, the literal `$SHELL` from a shell that does
/// not expand it) fails at least one of these, and a line we cannot vouch for
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

/// Whether a bare basename could be the *name of a shell*: letters, digits,
/// `_` and `-`, nothing else: bash, zsh, ksh93, busybox-ash all fit.
///
/// [`looks_like_shell_path`] is about the line; this is about the name.
/// `/etc/rc.initial`, pfSense's console menu, and genuinely the admin
/// account's `$SHELL`, is a perfectly good absolute path, so the path check
/// believes it; but `rc.initial` is a script that happens to live in passwd,
/// not a shell, and a Hosts chip naming it is noise. This alphabet (the same
/// one migrations 17 and 18 enforce with a GLOB) gates what is stored and
/// shown, *not* what [`detect_login_shell`] learns: the terminal path needs
/// the truthful answer to keep the integration line out of the menu.
pub(crate) fn is_shell_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
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
///
/// # Whose clock this is on
///
/// This is not a round trip. `exec` runs the command through the account's
/// login shell, which sources the operator's rc file first, so the probe takes
/// as long as somebody else's startup script takes and there is no bound on
/// that worth guessing at. Everything about the timing here follows from
/// that: the budget is [`SHELL_PROBE_TIMEOUT`], the ordinary case ends on
/// [`SHELL_PROBE_MARK`] long before the budget, and a host that talks without
/// ever answering ends on [`SHELL_PROBE_QUIET`].
///
/// It matters more than a probe usually would, because `None` is not a missing
/// nicety. `None` is `Unreadable`, `Unreadable` sends nothing, and a host that
/// is sent nothing loses command blocks, loses skills, and has its login screen
/// painted in pieces for want of a `clear` to cut at. A wrong answer here is
/// not a wrong chip, it is a connect that looks broken.
pub(crate) async fn detect_login_shell(handle: &Handle<TofuHandler>) -> Option<String> {
    let probe = async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel
            .exec(true, format!("echo \"{SHELL_PROBE_MARK}$SHELL\""))
            .await
            .ok()?;
        let mut out = String::new();
        loop {
            // The two silences are different facts and are given different
            // amounts of patience. Nothing said yet means the rc file is still
            // running and the only honest bound is the whole budget. Silence
            // after the host has spoken means it has finished: a shell would
            // have closed the channel by now, so what is left is something that
            // answers and then waits, which is a console menu.
            let next = if out.is_empty() {
                channel.wait().await
            } else {
                match tokio::time::timeout(SHELL_PROBE_QUIET, channel.wait()).await {
                    Ok(msg) => msg,
                    Err(_) => break,
                }
            };
            match next {
                Some(ChannelMsg::Data { ref data }) => {
                    out.push_str(&String::from_utf8_lossy(data));
                    // The marker gives the answer an end, so there is no reason
                    // to sit through the close on a host that works.
                    if marked_answer_complete(&out) {
                        break;
                    }
                    // A chatty rc file can print a great deal on a
                    // non-interactive login. Read enough of it to get past a
                    // banner to the marker behind it, and no more: past this
                    // the host is not answering the question that was asked.
                    if out.len() > 4096 {
                        break;
                    }
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        shell_from_probe_output(&out)
    };
    tokio::time::timeout(SHELL_PROBE_TIMEOUT, probe)
        .await
        .ok()
        .flatten()
}

/// Whether the marked answer has arrived whole: the marker, and a newline after
/// it to say the value it introduces is finished rather than half delivered.
fn marked_answer_complete(out: &str) -> bool {
    match out.find(SHELL_PROBE_MARK) {
        Some(at) => out[at..].contains('\n'),
        None => false,
    }
}

/// The login shell the host reported, out of everything else it said.
///
/// Two readings, tried in that order. The marked one is exact: the probe asked
/// for the value behind [`SHELL_PROBE_MARK`], so a marked line is the answer
/// and nothing else on the stream can be taken for it.
///
/// The unmarked one is the older heuristic, kept for a host that answers
/// something other than what was asked. It takes the last line that could
/// actually *be* `$SHELL`, not simply the last non-empty one: an rc file that
/// prints on a non-interactive login puts its output on both sides of the echo,
/// and taking whatever came last once read an operator's rc banner as their
/// login shell, after which the host wore an "unsupported shell" chip naming a
/// line of their own startup script.
///
/// Finding nothing is not an error. `None` means "we could not tell", and that
/// warns about nothing.
fn shell_from_probe_output(out: &str) -> Option<String> {
    let line = out
        .lines()
        .filter_map(|l| l.trim().strip_prefix(SHELL_PROBE_MARK))
        .rfind(|value| !value.is_empty())
        .or_else(|| {
            out.lines()
                .map(str::trim)
                .rfind(|l| looks_like_shell_path(l))
        })?;
    let name = shell_name(line);
    // `$SHELL` unset echoes back empty, and a shell that does not expand it
    // echoes the literal. Either way we know nothing.
    //
    // Deliberately NOT held to `is_shell_name` here: the terminal path uses
    // this answer to decide against injecting the integration line, and on
    // a pfSense host the truthful `rc.initial` is exactly what keeps a
    // POSIX `if` from being typed into the console menu. The alphabet is
    // enforced where the answer is stored or shown, not where it is learned.
    if name.is_empty() || name.contains('$') {
        return None;
    }
    Some(name)
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
        /// What that name means for what can be sent, decided from the
        /// *unfiltered* probe answer.
        ///
        /// It has to be carried separately because `login_shell` above is held
        /// to the shell alphabet: pfSense's `rc.initial` arrives here as `None`,
        /// which is indistinguishable from a probe that answered nothing, and
        /// those are the two cases the operator most needs told apart.
        capability: ShellCapability,
    },
    /// No stored key for this endpoint, TOFU prompt needed.
    UnknownKey { key: PresentedKey },
    /// Stored key differs from the presented one, hard warning.
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
    // TCP_NODELAY, as OpenSSH has set it on interactive sessions for decades.
    // russh's default is the opposite (`nodelay: false`, i.e. Nagle's algorithm
    // active), which is wrong for a terminal: Nagle withholds a small segment
    // while any earlier byte is still unacknowledged, so two keystrokes typed
    // closer together than one round trip get coalesced and the second one
    // waits for an ACK before it even leaves the machine. Invisible on a LAN,
    // where the ACK always beats the next keypress; on a link with real
    // latency it reads as intermittent stickiness while typing, which is
    // exactly the complaint it was found from.
    //
    // Costs nothing in return here. SSH already batches at the packet layer,
    // and bulk transfers fill segments on their own.
    //
    // Keepalive, when the operator has asked for it: a small global request on
    // a repeat, so a firewall or NAT between here and the host keeps the state
    // table entry for this connection alive. Without it a session left at a
    // prompt for long enough is quietly cut in the middle, and the way you find
    // out is that a keystroke goes nowhere and the tab hangs until TCP gives up.
    //
    // `keepalive_max: 0` deliberately: russh's default of 3 *closes* the
    // connection after three unanswered keepalives, which would turn a feature
    // meant to keep sessions alive into a new way for a busy server to lose
    // one. Broadside detects a dead connection by the connection dying, the way
    // it always has.
    let keepalive = KEEPALIVE_SECS.load(std::sync::atomic::Ordering::Relaxed);
    let config = Arc::new(client::Config {
        nodelay: true,
        keepalive_interval: (keepalive > 0).then(|| Duration::from_secs(keepalive)),
        keepalive_max: 0,
        ..Default::default()
    });

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
                // Rejected before the handler saw a key, shouldn't happen.
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
            let probed = detect_login_shell(&handle).await;
            // The capability is decided from the raw answer, before the
            // alphabet filter below throws the interesting part away: it is the
            // difference between "read /etc/rc.initial, that is a console menu"
            // and "got no answer at all".
            let capability = shell_capability(probed.as_deref());
            // The *name* is held to the shell alphabet, because it is both shown
            // (the warning toast, the Hosts chip) and stored. pfSense's
            // /etc/rc.initial is a real `$SHELL` but not a shell, and a chip
            // naming it is the bug migration 17 cleared. Reporting exactly what
            // will be stored keeps the row and the database in agreement.
            let login_shell = probed.filter(|name| is_shell_name(name));
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(ProbeResult::Ok {
                latency_ms,
                login_shell,
                capability,
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

/// What reading a private key file off disk turned up. The interesting split is
/// [`Self::Encrypted`] against [`Self::WrongPassphrase`]: the first is a key
/// that needs a passphrase we do not have, the second a passphrase that is
/// wrong. They lead to different sentences, and to different fields.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum KeyCheck {
    /// Loaded, and usable for authentication as it stands.
    Ok,
    /// Encrypted, and no passphrase was offered.
    Encrypted,
    /// Encrypted, and the passphrase offered does not decrypt it.
    WrongPassphrase,
    /// Missing, not a private key, or of a type russh cannot parse.
    Unreadable { message: String },
}

/// Reads a private key exactly the way [`authenticate`] will, and reports what
/// happened instead of connecting.
///
/// The passphrase is a *local* secret: it decrypts a file on this machine
/// before the SSH handshake starts, so no server is ever in a position to
/// challenge for it and there is no point in the session where a terminal could
/// prompt. Broadside is the only thing that can ask, which is why the host form
/// asks while the key is being chosen rather than leaving the failure to the
/// first connect.
///
/// Blocking: reads a file and runs the key's KDF. Call it off the IPC thread.
pub fn check_key(path: &str, passphrase: Option<&str>) -> KeyCheck {
    // An empty passphrase means "none given", not "the empty string": russh
    // would hand `""` to the cipher and report the resulting garbage as a
    // cryptographic error, which reads as a broken key rather than a missing
    // passphrase. The credential store already stores empty as absent, so this
    // matches what a saved host would do.
    let passphrase = passphrase.filter(|p| !p.is_empty());
    match load_secret_key(path, passphrase) {
        Ok(_) => KeyCheck::Ok,
        Err(russh::keys::Error::KeyIsEncrypted) => KeyCheck::Encrypted,
        // Every cipher rejects a bad passphrase differently and russh passes
        // the underlying error through, so the reliable signal is that a
        // passphrase was offered at all: the no-passphrase case has its own
        // variant above, and a file that is not a key fails identically with
        // or without one. Re-read without the passphrase first so a genuinely
        // broken file is not blamed on it.
        Err(e) if passphrase.is_some() => match load_secret_key(path, None) {
            Err(russh::keys::Error::KeyIsEncrypted) => KeyCheck::WrongPassphrase,
            _ => KeyCheck::Unreadable {
                message: e.to_string(),
            },
        },
        Err(e) => KeyCheck::Unreadable {
            message: e.to_string(),
        },
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
            // Spelled out rather than passed through, because "The key is
            // encrypted" on its own names a fact and no remedy. The form
            // catches this while the key is being chosen; reaching it here
            // means the file changed under a host that was already saved.
            let key = load_secret_key(&path, passphrase.as_deref()).map_err(|e| match e {
                russh::keys::Error::KeyIsEncrypted => AppError::Ssh(format!(
                    "the private key {path} is encrypted and no passphrase is stored for it. \
                     Edit this host and enter the key's passphrase."
                )),
                e => AppError::Ssh(format!("load key {path}: {e}")),
            })?;
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
mod key_check_tests {
    use super::*;
    use std::io::Write;

    /// Throwaway ed25519 keys, generated for these tests and never used to
    /// authenticate anything. The encrypted one's passphrase is `hunter2`.
    const PLAIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
QyNTUxOQAAACBS5vsRkuq025nAg6MndtNMeK+pmR1XMAofBm3SZkjezwAAAJjnWoOx51qD\n\
sQAAAAtzc2gtZWQyNTUxOQAAACBS5vsRkuq025nAg6MndtNMeK+pmR1XMAofBm3SZkjezw\n\
AAAEBNGL5sl67z2jPEMuMHDDjt7khDGc2kH66Bo2oc5Jme4FLm+xGS6rTbmcCDoyd200x4\n\
r6mZHVcwCh8GbdJmSN7PAAAAFGJyb2Fkc2lkZS10ZXN0LXBsYWluAQ==\n\
-----END OPENSSH PRIVATE KEY-----\n";

    const ENCRYPTED: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCCmxgvye\n\
X82IW+wSmuTnNhAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIJpyUyqjFcYHz5fi\n\
fJs8bPTxVOdhBLrwFPgaFfrnBziTAAAAoBlJlF4gGx/u9JorA2w7pBsVsho5bHWb4fOd2T\n\
5dZs7e69v1vfHlB6XB7CY0Z0bZ/1c6CHmd1hc+caFTGUfvJOG5v7E5UJPOejezxcsJxfAU\n\
zyB509OJzfzxMEzkV8r04wVU8BbHOTprUoUTZM7EnkCope9Fi5J0ioaaky25tCsvIeJFEp\n\
Q/1ZvCAWpSpnxH4HYbDr5NIc4nIUv5wA+E9/g=\n\
-----END OPENSSH PRIVATE KEY-----\n";

    fn write(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        let path = dir.path().join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_plain_key_loads_with_or_without_a_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "plain", PLAIN);
        assert_eq!(check_key(&path, None), KeyCheck::Ok);
        // An unencrypted key ignores one rather than refusing it, so typing a
        // passphrase into the form for a key that does not need one is not an
        // error we should invent.
        assert_eq!(check_key(&path, Some("anything")), KeyCheck::Ok);
    }

    #[test]
    fn an_encrypted_key_with_no_passphrase_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "enc", ENCRYPTED);
        assert_eq!(check_key(&path, None), KeyCheck::Encrypted);
        assert_eq!(check_key(&path, Some("")), KeyCheck::Encrypted);
    }

    #[test]
    fn the_right_passphrase_opens_it_and_a_wrong_one_is_named_as_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "enc", ENCRYPTED);
        assert_eq!(check_key(&path, Some("hunter2")), KeyCheck::Ok);
        assert_eq!(check_key(&path, Some("hunter3")), KeyCheck::WrongPassphrase);
    }

    #[test]
    fn anything_that_is_not_a_key_is_unreadable_passphrase_or_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "notes.txt", "this is not a private key\n");
        // Not blamed on the passphrase in either direction: a file that cannot
        // be parsed is not a passphrase problem, and saying it is would send
        // the operator hunting for a passphrase that does not exist.
        assert!(matches!(
            check_key(&path, None),
            KeyCheck::Unreadable { .. }
        ));
        assert!(matches!(
            check_key(&path, Some("hunter2")),
            KeyCheck::Unreadable { .. }
        ));
        assert!(matches!(
            check_key(&dir.path().join("nope").to_string_lossy(), None),
            KeyCheck::Unreadable { .. }
        ));
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
            let cap = shell_capability(Some(s));
            assert!(cap.with_integration(), "{s} should parse");
            assert!(cap.sends_setup(), "{s} should be written to");
        }
    }

    #[test]
    fn fish_and_csh_cannot_parse_the_integration() {
        // The whole point of X4: these abort the line at parse time, taking the
        // clear/MOTD/last-login tail down with it. So they still get the tail,
        // which they understand, and never the integration.
        for s in ["/usr/bin/fish", "/bin/csh", "/bin/tcsh"] {
            let cap = shell_capability(Some(s));
            assert_eq!(cap, ShellCapability::TailOnly, "{s}");
            assert!(!cap.with_integration(), "{s} must not be sent the OSC 133");
            assert!(cap.sends_setup(), "{s} still gets its fresh-login tail");
        }
        // A name that is no shell we know gets nothing at all, rather than
        // optimistically being handed the tail: the next appliance to behave
        // like pfSense's console menu arrives here under a name nobody has seen.
        assert_eq!(
            shell_capability(Some("/opt/weird/shell")),
            ShellCapability::Unsupported
        );
    }

    #[test]
    fn only_bash_and_zsh_install_the_hooks() {
        assert_eq!(shell_capability(Some("/bin/bash")), ShellCapability::Full);
        assert_eq!(shell_capability(Some("/bin/zsh")), ShellCapability::Full);
        // sh parses the line but takes neither branch, so no block tracking.
        assert_eq!(shell_capability(Some("/bin/sh")), ShellCapability::ParseSafe);
        assert_eq!(
            shell_capability(Some("/usr/bin/fish")),
            ShellCapability::TailOnly
        );
    }

    #[test]
    fn a_console_menu_and_an_unanswered_probe_are_both_silent_but_distinct() {
        // The pfSense double-menu, at the level that decides it. rc.initial is
        // a name we read and know is not a shell; a probe that answered nothing
        // is a different situation with the same handling, and the operator has
        // to be able to tell them apart because only one of them is fixable.
        let menu = shell_capability(Some("/etc/rc.initial"));
        let silent = shell_capability(None);
        assert_eq!(menu, ShellCapability::Unsupported);
        assert_eq!(silent, ShellCapability::Unreadable);
        assert_ne!(menu, silent);
        for cap in [menu, silent] {
            assert!(!cap.sends_setup(), "{cap:?} must write nothing at all");
            assert!(!cap.with_integration());
        }
    }

    #[test]
    fn the_override_beats_the_probe_both_ways() {
        // A ForceCommand box that is really bash, told so once.
        assert_eq!(
            ShellIntegrationPref::Always.resolve(ShellCapability::Unreadable),
            ShellCapability::Full
        );
        // And a host that must never be written to, whatever it claims.
        assert_eq!(
            ShellIntegrationPref::Never.resolve(ShellCapability::Full),
            ShellCapability::Unsupported
        );
        // Auto, and anything unrecognised in the column, believes the probe.
        assert_eq!(
            ShellIntegrationPref::Auto.resolve(ShellCapability::ParseSafe),
            ShellCapability::ParseSafe
        );
        assert_eq!(
            ShellIntegrationPref::from_stored(None),
            ShellIntegrationPref::Auto
        );
        assert_eq!(
            ShellIntegrationPref::from_stored(Some("nonsense")),
            ShellIntegrationPref::Auto
        );
        assert_eq!(
            ShellIntegrationPref::from_stored(Some("never")),
            ShellIntegrationPref::Never
        );
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

    #[test]
    fn a_real_shell_is_not_always_a_shell_name() {
        // The pfSense case: the admin account's passwd shell really is
        // /etc/rc.initial, the console menu. It sails through the path check
        // because it is exactly what `$SHELL` said, the terminal path needs
        // that truth to keep the integration line out of the menu, but the
        // name is no shell, and storing it re-created the chip migration 17
        // clears. The probe result and the column both gate on this.
        assert!(looks_like_shell_path("/etc/rc.initial"));
        assert!(!is_shell_name("rc.initial"));
        // The same alphabet the migration's GLOB enforces on the column.
        for good in ["bash", "zsh", "sh", "ksh93", "busybox-ash", "mk_sh"] {
            assert!(is_shell_name(good), "{good} should be a shell name");
        }
        for bad in ["rc.initial", "", "$SHELL", "menu.sh", "sh 2"] {
            assert!(!is_shell_name(bad), "{bad:?} should not be a shell name");
        }
    }

    /// The probe must reach past trailing rc output to the line that is
    /// actually the shell. Predates the marker, and still has to hold, because
    /// the unmarked reading is what a host that answers something other than
    /// what was asked falls back to.
    #[test]
    fn the_shell_is_found_under_trailing_rc_output() {
        let out = "welcome\n/bin/bash\nrc.inital\n";
        assert_eq!(shell_from_probe_output(out).as_deref(), Some("bash"));
    }

    #[test]
    fn the_marked_answer_is_taken_over_anything_else_on_the_stream() {
        // An rc file that prints on a non-interactive login, on both sides of
        // the echo, and prints a path of its own for good measure. Before the
        // marker the last plausible path won; now the line that was asked for
        // does, whatever else is shouting.
        let out = "== welcome to prod ==\n\
                   using /usr/local/bin/python3.11\n\
                   __broadside_shell=/bin/zsh\n\
                   /opt/tools/bin/agent\n";
        assert_eq!(shell_from_probe_output(out).as_deref(), Some("zsh"));
    }

    #[test]
    fn an_unmarked_answer_still_reads() {
        // A host that mangles the quoting, or answers something other than what
        // was asked. The old heuristic is the fallback, not the primary.
        assert_eq!(
            shell_from_probe_output("/usr/bin/fish\n").as_deref(),
            Some("fish")
        );
        // pfSense's console menu: it reprints itself rather than running the
        // command, and nothing in that is a shell path. `None` is the truthful
        // answer, and it is `Unreadable` rather than a guess.
        let menu = "Welcome to pfSense!\n\n\
                    0) Logout (SSH only)\n\
                    1) Assign Interfaces\n\
                    8) Shell\n\nEnter an option: ";
        assert_eq!(shell_from_probe_output(menu), None);
    }

    #[test]
    fn a_shell_that_does_not_expand_it_is_not_believed() {
        // The marker arrives, the value behind it does not: a shell that echoed
        // the literal. Knowing nothing is the correct answer, and the `$` check
        // is what keeps it from being stored as a shell called `$SHELL`.
        assert_eq!(shell_from_probe_output("__broadside_shell=$SHELL\n"), None);
        // And `$SHELL` unset, which echoes back as an empty value. Empty must
        // not shadow a real path further up the stream either.
        assert_eq!(shell_from_probe_output("__broadside_shell=\n"), None);
        assert_eq!(
            shell_from_probe_output("/bin/dash\n__broadside_shell=\n").as_deref(),
            Some("dash")
        );
    }

    #[test]
    fn the_marker_is_what_says_the_answer_is_whole() {
        // The reason the probe can stop before the channel closes: a marker
        // with a newline behind it is a complete line, and a complete line is
        // the answer. Half of one is not, and waiting for the rest of it is the
        // difference between reading `/bin/ba` and reading bash.
        assert!(marked_answer_complete("__broadside_shell=/bin/bash\n"));
        assert!(!marked_answer_complete("__broadside_shell=/bin/ba"));
        assert!(!marked_answer_complete("__broadside_sh"));
        // Noise in front of it is fine; noise is what the marker exists for.
        assert!(marked_answer_complete(
            "nvm: no such file\n__broadside_shell=/bin/zsh\n"
        ));
        // A menu never produces it, which is what sends that case to the quiet
        // gap instead of to the budget.
        assert!(!marked_answer_complete("Enter an option: "));
    }

    #[test]
    fn the_probe_budget_outlasts_a_slow_rc_file() {
        // The 68-5 fault, at the level that caused it. A `.bashrc` with an
        // `nvm` or `conda` block above the `case $- in *i*` guard runs on the
        // probe's non-interactive login too, and at three seconds it ran the
        // clock out: the host was recorded Unreadable, was therefore sent
        // nothing, and lost command blocks, skills, and the curtain with them.
        assert!(SHELL_PROBE_TIMEOUT >= Duration::from_secs(8));
        // And the reason that could be afforded: the hosts that answer are not
        // waiting on it. A shell closes the channel, a marked answer ends the
        // read sooner still, and a host that talks without answering ends on a
        // gap that is a fraction of the budget.
        assert!(SHELL_PROBE_QUIET < SHELL_PROBE_TIMEOUT / 4);
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
