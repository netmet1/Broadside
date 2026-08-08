//! Interactive PTY sessions for per-host terminal tabs (D-002 hybrid model).
//! PTY mode is deliberately exempt from the destructive guard (D-014), the
//! operator is interactive. Sudo password auto-fill, however, IS wired in here
//! (D-065, reversing D-026's PTY exemption): the session task feeds the
//! keystroke and output streams through a [`SudoInjector`](super::sudo_inject)
//! that answers a sudo password prompt with the host's stored sudo password.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use super::sudo_inject::SudoInjector;
use super::{
    connect_and_auth, detect_login_shell, shell_capability, AuthMethod, ConnectFailure,
    PresentedKey, ShellCapability, ShellIntegrationPref,
};
use crate::error::{AppError, AppResult};

pub const DATA_EVENT: &str = "pty:data";
pub const CLOSED_EVENT: &str = "pty:closed";
/// Completed command blocks for the MultiTerminal aggregate view (D-061).
pub const BLOCK_EVENT: &str = "pty:block";
/// The stored sudo password was auto-filled at a prompt (D-065).
pub const SUDO_EVENT: &str = "pty:sudo";
/// An auto-filled sudo password was rejected by sudo (`Sorry, try again.`),
/// so the stored password is probably wrong (D-065, 11.3).
pub const SUDO_REJECTED_EVENT: &str = "pty:sudo-rejected";

const TERM: &str = "xterm-256color";

/// Bound on the post-auth channel + PTY + shell setup. Connect and auth are
/// already bounded upstream (`CONNECT_TIMEOUT` / `AUTH_TIMEOUT`), but a host
/// that authenticates and then never grants a shell (a locked or shell-less
/// account, a forced command, a half-dead sshd) used to stall these awaits
/// forever, leaving a skill pane or terminal tab hung on "starting…" with no
/// outcome. Ten seconds matches the other phases.
const SHELL_SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct PtyData {
    pub session_id: String,
    /// Raw terminal bytes. Base64 is a property of the Tauri event wire rather
    /// than of this type, so it is applied once, at the emit boundary. Keeping
    /// the bytes raw in here is also what makes batching possible at all: two
    /// base64 strings cannot be concatenated into the encoding of the two
    /// chunks joined, because of the padding in the middle.
    pub data: Vec<u8>,
}

/// The `pty:data` payload in the shape the frontend actually receives. JSON
/// cannot carry binary, so the bytes travel base64-encoded; `onPtyData` in
/// `src/lib/tauri/pty.ts` is the other half of this.
#[derive(Serialize, Clone)]
struct PtyDataWire<'a> {
    session_id: &'a str,
    data_b64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyClosed {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
}

/// The stored sudo password was auto-filled for one session (D-065). Carries
/// no secret, only enough to audit-log and toast.
#[derive(Debug, Clone, Serialize)]
pub struct SudoInjected {
    pub session_id: String,
    pub host_label: String,
    pub hostname: String,
    pub port: u16,
}

/// A completed command block for one session, fed to the MultiTerminal view
/// (D-061). The block fields are flattened in so the frontend payload is
/// `{ session_id, command, lines, exit_code, interactivity }`.
#[derive(Debug, Clone, Serialize)]
pub struct PtyBlock {
    pub session_id: String,
    #[serde(flatten)]
    pub block: crate::omni::CommandBlock,
}

/// Where session output goes. The app implements this with Tauri events;
/// integration tests implement it with a channel.
pub trait PtyEvents: Send + Sync + 'static {
    fn data(&self, payload: PtyData);
    /// Send anything this sink has gathered for the session right now, rather
    /// than when its batch window closes. Only matters to a sink that batches,
    /// so it defaults to doing nothing.
    fn flush(&self, _session_id: &str) {}
    fn closed(&self, payload: PtyClosed);
    /// A command finished, its completion-delimited block (D-061).
    fn block(&self, payload: PtyBlock);
    /// The sudo password was auto-filled at a prompt (D-065).
    fn sudo_injected(&self, payload: SudoInjected);
    /// An auto-filled sudo password was rejected (probably wrong) (D-065).
    fn sudo_rejected(&self, payload: SudoInjected);
}

/// How long a session's output may be gathered before it has to go out.
///
/// Nothing ever waits this long unless the session is *already* producing
/// faster than the window: the first chunk after a quiet moment is emitted on
/// the spot. So an echoed keystroke never pays it, while a `cat` of a large
/// file stops paying a JSON serialize, a JS source string and a WebView2
/// parse-and-compile for every single read the session task does.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);

/// Force a batch out once it reaches this size, rather than waiting for the
/// window. The window already bounds the batch under any normal load; this
/// only matters if a flush is delayed, and it stops one emit from becoming
/// arbitrarily large.
const COALESCE_MAX_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct PumpSlot {
    /// When bytes last went out for this session. `None` until the first ones
    /// do, which is what makes a brand new session take the immediate path.
    last_emit: Option<Instant>,
    /// Gathered since then, waiting for the window to close.
    pending: Vec<u8>,
    /// A flush is already scheduled, so don't schedule a second one.
    armed: bool,
}

/// Batches `pty:data` on its way to the UI (see [`COALESCE_WINDOW`]).
///
/// The ordering rule that makes this safe: a chunk only takes the immediate
/// path when nothing is already gathered for that session. So bytes can never
/// overtake bytes, and the pane sees exactly the stream the host sent.
#[derive(Default)]
pub struct DataPump {
    slots: Mutex<HashMap<String, PumpSlot>>,
}

/// What [`PumpSlot::accept`] decided should happen to one chunk.
#[derive(Debug)]
enum PumpAction {
    /// These bytes go out now.
    SendNow(Vec<u8>),
    /// Added to the batch; a flush is already scheduled for it.
    Gathered,
    /// Added to the batch, and the caller now owes it a scheduled flush.
    GatheredArmFlush,
}

impl PumpSlot {
    /// Decide what happens to one chunk. Split out from [`DataPump::push`] so
    /// the batching rules can be tested with a clock we control, rather than
    /// only through a live `AppHandle`.
    fn accept(&mut self, now: Instant, bytes: &[u8]) -> PumpAction {
        let quiet = self
            .last_emit
            .is_none_or(|t| now.duration_since(t) >= COALESCE_WINDOW);
        // Going out immediately is conditional on nothing being gathered yet,
        // not merely on the session being quiet, and that is the whole ordering
        // guarantee: bytes can never overtake bytes that are already waiting.
        if self.pending.is_empty() && quiet {
            self.last_emit = Some(now);
            return PumpAction::SendNow(bytes.to_vec());
        }
        self.pending.extend_from_slice(bytes);
        if self.pending.len() >= COALESCE_MAX_BYTES {
            self.last_emit = Some(now);
            return PumpAction::SendNow(std::mem::take(&mut self.pending));
        }
        if self.armed {
            PumpAction::Gathered
        } else {
            self.armed = true;
            PumpAction::GatheredArmFlush
        }
    }

    /// Take whatever is gathered, disarming the flush that was scheduled for it.
    fn take_pending(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.armed = false;
        if self.pending.is_empty() {
            return None;
        }
        self.last_emit = Some(now);
        Some(std::mem::take(&mut self.pending))
    }
}

impl DataPump {
    /// Deliver `bytes` for `session_id`: immediately if the session has been
    /// quiet, otherwise added to the batch already forming for it.
    fn push(&self, app: &tauri::AppHandle, session_id: &str, bytes: &[u8]) {
        let action = {
            let mut slots = self.slots.lock().unwrap();
            slots
                .entry(session_id.to_string())
                .or_default()
                .accept(Instant::now(), bytes)
        };
        // Emitting happens outside the lock deliberately: an emit hops to the
        // UI thread, and holding the map across it would queue every other
        // session's output behind this one.
        match action {
            PumpAction::SendNow(bytes) => emit_data(app, session_id, &bytes),
            PumpAction::Gathered => {}
            PumpAction::GatheredArmFlush => {
                let app = app.clone();
                let session_id = session_id.to_string();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(COALESCE_WINDOW).await;
                    app.state::<DataPump>().flush_session(&app, &session_id);
                });
            }
        }
    }

    /// Send whatever is gathered for this session right now.
    fn flush_session(&self, app: &tauri::AppHandle, session_id: &str) {
        let send_now = {
            let mut slots = self.slots.lock().unwrap();
            slots
                .get_mut(session_id)
                .and_then(|slot| slot.take_pending(Instant::now()))
        };
        if let Some(bytes) = send_now {
            emit_data(app, session_id, &bytes);
        }
    }

    /// Flush a finished session and forget it, so the map tracks live sessions
    /// only rather than growing for the life of the process.
    fn retire(&self, app: &tauri::AppHandle, session_id: &str) {
        self.flush_session(app, session_id);
        self.slots.lock().unwrap().remove(session_id);
    }
}

fn emit_data(app: &tauri::AppHandle, session_id: &str, bytes: &[u8]) {
    let _ = app.emit(
        DATA_EVENT,
        PtyDataWire {
            session_id,
            data_b64: B64.encode(bytes),
        },
    );
}

impl PtyEvents for tauri::AppHandle {
    fn data(&self, payload: PtyData) {
        self.state::<DataPump>()
            .push(self, &payload.session_id, &payload.data);
    }
    fn flush(&self, session_id: &str) {
        self.state::<DataPump>().flush_session(self, session_id);
    }
    fn closed(&self, payload: PtyClosed) {
        // Anything still gathered is this session's last words, so it has to
        // reach the pane before the pane is told the session ended.
        self.state::<DataPump>().retire(self, &payload.session_id);
        let _ = self.emit(CLOSED_EVENT, &payload);
    }
    fn block(&self, payload: PtyBlock) {
        let _ = self.emit(BLOCK_EVENT, &payload);
    }
    fn sudo_injected(&self, payload: SudoInjected) {
        // Always-on audit (D-011), never includes the password (D-026 rule).
        let _ = self
            .state::<crate::audit::AuditState>()
            .append(&crate::audit::AuditEvent::SudoInjected {
                host_label: payload.host_label.clone(),
                hostname: payload.hostname.clone(),
                port: payload.port,
            });
        // Notify the UI so it can toast (transparency: the operator should know
        // a password was typed for them).
        let _ = self.emit(SUDO_EVENT, &payload);
    }
    fn sudo_rejected(&self, payload: SudoInjected) {
        // Transparency: the auto-filled password didn't work; tell the operator
        // so they can fix the stored sudo password. No secret in the payload.
        let _ = self.emit(SUDO_REJECTED_EVENT, &payload);
    }
}

/// Typed result of a PTY open attempt, mirrors ProbeResult/ExecResult so the
/// frontend reuses the same TOFU dialogs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PtyOpenResult {
    Opened {
        /// The host's login shell, when the probe could read it (X4). Lets the
        /// tab warn that command-block tracking is unavailable on a shell that
        /// cannot take the OSC 133 integration.
        login_shell: Option<String>,
        /// What the probe concluded, *before* the per-host override. Sent
        /// separately from `login_shell` because the two answer different
        /// questions: the name is what the host said, this is what Broadside
        /// made of it. It is also the only way the frontend can tell an
        /// `unreadable` host (fixable, point at the override) from an
        /// `unsupported` one (a fact, nothing to fix), the name is `None` in
        /// the first case and unstorable in the second.
        ///
        /// This is the value that gets stored, so it stays the host's own
        /// answer: overwriting it with the override would mean turning the
        /// override off could never reveal what the host actually said.
        capability: ShellCapability,
        /// The override that was in force for this open. The probed capability
        /// alone does not say what happened: a bash host set to `Never` was
        /// sent nothing, and a host that answered nothing but is set to
        /// `Always` was sent everything. The pane's warning strip is about what
        /// happened, so it needs both, and it is the same pair the Hosts and
        /// rail chips already resolve, so the two cannot disagree.
        integration: ShellIntegrationPref,
    },
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
    NoCredentials,
}

impl From<ConnectFailure> for PtyOpenResult {
    fn from(f: ConnectFailure) -> Self {
        match f {
            ConnectFailure::UnknownKey { key } => PtyOpenResult::UnknownKey { key },
            ConnectFailure::KeyMismatch {
                stored_fingerprint,
                presented,
            } => PtyOpenResult::KeyMismatch {
                stored_fingerprint,
                presented,
            },
            ConnectFailure::AuthFailed { message } => PtyOpenResult::AuthFailed { message },
            ConnectFailure::Unreachable { message } => PtyOpenResult::Unreachable { message },
        }
    }
}

/// Commands sent into a live session task. Shared by the SSH path (below) and
/// the local-shell path (`crate::local`), both consume the same channel so the
/// `pty_write`/`pty_resize`/`pty_close` commands work identically for either.
pub(crate) enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// One registered session: the command channel into its task, plus the epoch
/// stamped at registration so a task can tell whether the map entry is still
/// its own (a later open with the same id replaces the entry, see
/// `remove_if_current`).
struct SessionEntry {
    epoch: u64,
    tx: mpsc::Sender<SessionCmd>,
}

/// Live sessions, keyed by the frontend-supplied session id. Clone-cheap
/// (shared map) so the session task can deregister itself.
#[derive(Default, Clone)]
pub struct PtyState(Arc<Mutex<HashMap<String, SessionEntry>>>, Arc<AtomicU64>);

impl PtyState {
    fn sender(&self, session_id: &str) -> AppResult<mpsc::Sender<SessionCmd>> {
        self.0
            .lock()
            .unwrap()
            .get(session_id)
            .map(|e| e.tx.clone())
            .ok_or_else(|| AppError::Ssh(format!("no such pty session: {session_id}")))
    }

    /// Registers (or replaces) the session and returns its epoch. Replacing
    /// drops the old entry's sender, which shuts down the old task.
    fn insert(&self, session_id: String, tx: mpsc::Sender<SessionCmd>) -> u64 {
        let epoch = self.1.fetch_add(1, Ordering::Relaxed);
        self.0
            .lock()
            .unwrap()
            .insert(session_id, SessionEntry { epoch, tx });
        epoch
    }

    /// Creates the command channel, registers the session and returns its epoch
    /// plus the receiver for the session task to consume. Used by the local-shell
    /// path so it can reuse the same write/resize/close plumbing as SSH.
    pub(crate) fn register(&self, session_id: String) -> (u64, mpsc::Receiver<SessionCmd>) {
        let (tx, rx) = mpsc::channel::<SessionCmd>(64);
        let epoch = self.insert(session_id, tx);
        (epoch, rx)
    }

    /// Deregisters the session only if the entry still belongs to the task
    /// stamped with `epoch`. Returns whether it did, false means the entry
    /// was already removed (deliberate close) or replaced by a newer open
    /// with the same id, and the caller must not tear down or report on the
    /// replacement's behalf.
    pub(crate) fn remove_if_current(&self, session_id: &str, epoch: u64) -> bool {
        let mut map = self.0.lock().unwrap();
        match map.get(session_id) {
            Some(entry) if entry.epoch == epoch => {
                map.remove(session_id);
                true
            }
            _ => false,
        }
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> AppResult<()> {
        self.sender(session_id)?
            .try_send(SessionCmd::Write(data.to_vec()))
            .map_err(|e| AppError::Ssh(format!("pty write: {e}")))
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        self.sender(session_id)?
            .try_send(SessionCmd::Resize { cols, rows })
            .map_err(|e| AppError::Ssh(format!("pty resize: {e}")))
    }

    pub fn close(&self, session_id: &str) -> AppResult<()> {
        // Best effort: the session may already be gone. Removing the entry
        // first means the task's own remove_if_current comes back false, so
        // a deliberate close never emits a pty:closed event.
        if let Some(entry) = self.0.lock().unwrap().remove(session_id) {
            let _ = entry.tx.try_send(SessionCmd::Close);
        }
        Ok(())
    }
}

/// Connects, opens a PTY + shell, and spawns the session task that pumps
/// remote output to the event sink and accepts Write/Resize/Close commands.
/// Registers the session in `state` on success; the task deregisters itself
/// when the channel closes.
#[allow(clippy::too_many_arguments)]
pub async fn open<E: PtyEvents>(
    events: E,
    state: &PtyState,
    session_id: String,
    host_label: &str,
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
    // The host's stored sudo password (D-065), or None to disable auto-fill
    // (root host, or no password stored). Never leaves this task.
    sudo_password: Option<String>,
    // The host's standing answer for shell integration (D-067). `Auto` is the
    // default and believes the probe.
    shell_pref: ShellIntegrationPref,
    cols: u32,
    rows: u32,
) -> AppResult<PtyOpenResult> {
    let handle =
        match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
            Ok(h) => h,
            Err(failure) => return Ok(failure.into()),
        };

    // Read the login shell before the shell channel opens, so no banner is
    // streaming into a channel nobody is draining yet, and so the answer is in
    // hand by the time the setup line has to be built. One extra round trip on
    // a host that answers; bounded and ignored on one that doesn't (X4).
    let login_shell = detect_login_shell(&handle).await;
    // What the probe read, then what the operator said about it. An unreadable
    // probe is now silent rather than injecting on the assumption that the
    // integration is harmless: it is only harmless in a *shell*, and the same
    // write carries `clear; cat /etc/motd`, which a pfSense console menu reads
    // as a menu selection and answers by reprinting itself. `Always` on the
    // host is how a box that will not answer `echo $SHELL` gets its
    // command-block tracking back.
    let probed = shell_capability(login_shell.as_deref());
    let effective = shell_pref.resolve(probed);

    // Bound the whole channel/PTY/shell handshake: on a host that authenticates
    // but never grants a shell, these awaits would otherwise hang forever and
    // strand the caller (a skill pane frozen on "starting…", a terminal tab that
    // never connects). A timeout turns that into a clean, reported failure.
    let setup = async {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("channel open: {e}")))?;
        channel
            .request_pty(false, TERM, cols, rows, 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(format!("pty request: {e}")))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::Ssh(format!("shell request: {e}")))?;
        Ok::<_, AppError>(channel)
    };
    let mut channel = match tokio::time::timeout(SHELL_SETUP_TIMEOUT, setup).await {
        Ok(result) => result?,
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            return Err(AppError::Ssh(format!(
                "timed out opening a shell after {}s",
                SHELL_SETUP_TIMEOUT.as_secs()
            )));
        }
    };

    // OSC 133 shell integration is injected from inside the session task once
    // the login banner has streamed (so we can capture the real "Last login:"
    // line before clearing), see the task below (D-061 / D-063 / T1).
    let (tx, mut rx) = mpsc::channel::<SessionCmd>(64);
    let epoch = state.insert(session_id.clone(), tx);
    let state = state.clone();

    // Sudo password auto-fill (D-065). Inert when `sudo_password` is None.
    let mut sudo = SudoInjector::new(sudo_password);
    let sudo_meta = SudoInjected {
        session_id: session_id.clone(),
        host_label: host_label.to_string(),
        hostname: hostname.to_string(),
        port,
    };

    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<u32> = None;
        let mut message: Option<String> = None;
        // Per-session VT interpreter feeding the MultiTerminal block stream
        // (D-061). The raw `pty:data` stream below is unchanged; the live
        // terminal pane still renders every byte; this is a parallel feed.
        let mut omni = crate::omni::OmniParser::new();

        // T1 (D-063): let the login banner stream, capture the real "Last
        // login:" line, then inject the integration + clear + reprinted MOTD +
        // re-echoed last-login so the session looks like a fresh login without
        // the visible setup line. Inject on capture, or after a short timeout
        // if the host prints no last-login line.
        let mut setup_sent = false;
        let mut banner = String::new();
        let setup_timeout =
            tokio::time::sleep(std::time::Duration::from_millis(1500));
        tokio::pin!(setup_timeout);

        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data })
                    | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        if !setup_sent {
                            banner.push_str(&String::from_utf8_lossy(&data[..]));
                            let last_login = crate::omni::extract_last_login(&banner);
                            // Inject once we've captured the last-login line, or
                            // bail out if the banner is unexpectedly large.
                            if last_login.is_some() || banner.len() > 8192 {
                                if let Some(setup) = crate::omni::shell_setup_command(
                                    last_login.as_deref(),
                                    effective,
                                ) {
                                    let _ = channel.data(setup.as_bytes()).await;
                                }
                                // Marked sent either way: a shell we don't write
                                // to must not keep re-entering this branch and
                                // growing `banner` for the life of the session.
                                setup_sent = true;
                                banner = String::new();
                            }
                        }
                        for block in omni.feed(&data[..]) {
                            events.block(PtyBlock {
                                session_id: session_id.clone(),
                                block,
                            });
                        }
                        events.data(PtyData {
                            session_id: session_id.clone(),
                            data: data.to_vec(),
                        });
                        // Answer a sudo prompt after the bytes reach the UI so
                        // the operator sees the prompt (D-065). The password
                        // never enters the visible stream.
                        if let Some(payload) = sudo.on_output(&data[..]) {
                            // "Reach the UI" has to mean it, so the prompt is
                            // pushed out ahead of the password rather than
                            // sitting in a batch while the password is typed
                            // for it.
                            events.flush(&session_id);
                            if channel.data(payload.as_bytes()).await.is_ok() {
                                events.sudo_injected(sudo_meta.clone());
                            }
                        }
                        // An injected password that sudo rejected, warn once so
                        // the operator knows to fix the stored password (11.3).
                        if sudo.take_rejected() {
                            events.sudo_rejected(sudo_meta.clone());
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                _ = &mut setup_timeout, if !setup_sent => {
                    // No last-login arrived in time, set up without re-echoing it.
                    // A silent host reaches this arm too (it prints a menu, not a
                    // last-login line) and must still write nothing.
                    if let Some(setup) = crate::omni::shell_setup_command(None, effective) {
                        let _ = channel.data(setup.as_bytes()).await;
                    }
                    setup_sent = true;
                },
                cmd = rx.recv() => match cmd {
                    Some(SessionCmd::Write(data)) => {
                        // Track typed input to arm sudo auto-fill (D-065).
                        sudo.on_input(&data);
                        if let Err(e) = channel.data(&data[..]).await {
                            message = Some(format!("write failed: {e}"));
                            break;
                        }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCmd::Close) | None => break,
                },
            }
        }
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        // Drop our map entry so later writes fail fast instead of queueing
        // into a dead task, but only if the entry is still OURS. A second
        // open with the same session id replaces the entry; the replaced
        // task must not deregister its successor or report a close the UI
        // would misattribute to the live session.
        if state.remove_if_current(&session_id, epoch) {
            // Flush a dangling block (a command still running when the shell
            // died, or a shell without OSC 133 integration) so its output
            // isn't lost from the MultiTerminal view.
            if let Some(block) = omni.flush() {
                events.block(PtyBlock {
                    session_id: session_id.clone(),
                    block,
                });
            }
            events.closed(PtyClosed {
                session_id: session_id.clone(),
                exit_code,
                message,
            });
        }
    });

    // The *probed* capability is reported and stored, not the resolved one: the
    // override lives in its own column, and overwriting the truth with it would
    // mean turning the override off could never reveal what the host actually
    // said.
    Ok(PtyOpenResult::Opened {
        login_shell,
        capability: probed,
        integration: shell_pref,
    })
}

#[cfg(test)]
mod pump_tests {
    use super::*;

    fn sent(action: PumpAction) -> Option<Vec<u8>> {
        match action {
            PumpAction::SendNow(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// The property the whole design rests on: a session nobody is flooding
    /// pays nothing. Every chunk after a quiet moment goes straight out, so an
    /// echoed keystroke is never held back.
    #[test]
    fn a_quiet_session_always_sends_immediately() {
        let mut slot = PumpSlot::default();
        let t0 = Instant::now();
        assert_eq!(sent(slot.accept(t0, b"a")).as_deref(), Some(&b"a"[..]));
        let later = t0 + COALESCE_WINDOW * 2;
        assert_eq!(sent(slot.accept(later, b"b")).as_deref(), Some(&b"b"[..]));
        let later_still = later + COALESCE_WINDOW * 5;
        assert_eq!(
            sent(slot.accept(later_still, b"c")).as_deref(),
            Some(&b"c"[..])
        );
    }

    #[test]
    fn a_busy_session_gathers_and_goes_out_in_one_piece() {
        let mut slot = PumpSlot::default();
        let t0 = Instant::now();
        assert!(sent(slot.accept(t0, b"one")).is_some());
        // Inside the window now, so these gather; only the first one owes a
        // scheduled flush, or every chunk would spawn its own.
        let t1 = t0 + Duration::from_millis(1);
        assert!(matches!(
            slot.accept(t1, b"two"),
            PumpAction::GatheredArmFlush
        ));
        assert!(matches!(slot.accept(t1, b"three"), PumpAction::Gathered));
        assert_eq!(slot.take_pending(t1).as_deref(), Some(&b"twothree"[..]));
        // Disarmed by the take, so the next burst arms a fresh flush.
        assert!(!slot.armed);
    }

    /// The ordering invariant. Once anything is waiting, a later chunk joins
    /// the queue instead of jumping it, even long after the window has passed,
    /// so the pane can never be shown bytes out of the order the host sent them.
    #[test]
    fn nothing_overtakes_bytes_that_are_already_waiting() {
        let mut slot = PumpSlot::default();
        let t0 = Instant::now();
        slot.accept(t0, b"first");
        slot.accept(t0 + Duration::from_millis(1), b"second");
        let long_after = t0 + COALESCE_WINDOW * 10;
        assert!(matches!(
            slot.accept(long_after, b"third"),
            PumpAction::Gathered
        ));
        assert_eq!(
            slot.take_pending(long_after).as_deref(),
            Some(&b"secondthird"[..])
        );
    }

    #[test]
    fn a_batch_past_the_cap_is_forced_out_without_waiting() {
        let mut slot = PumpSlot::default();
        let t0 = Instant::now();
        slot.accept(t0, b"x");
        let big = vec![b'y'; COALESCE_MAX_BYTES];
        let out = sent(slot.accept(t0 + Duration::from_millis(1), &big))
            .expect("a batch at the cap goes out at once rather than growing");
        assert_eq!(out.len(), COALESCE_MAX_BYTES);
        assert!(slot.pending.is_empty());
    }

    #[test]
    fn taking_from_an_idle_slot_emits_nothing() {
        // The scheduled flush fires even when the burst already drained itself
        // through the size cap, and it must not emit an empty payload.
        let mut slot = PumpSlot::default();
        assert!(slot.take_pending(Instant::now()).is_none());
    }
}
