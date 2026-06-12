//! Interactive PTY sessions for per-host terminal tabs (D-002 hybrid model).
//! PTY mode is deliberately exempt from the destructive guard (D-014) and
//! sudo password piping (D-026) — the operator is interactive.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;

use super::{connect_and_auth, AuthMethod, ConnectFailure, PresentedKey};
use crate::error::{AppError, AppResult};

pub const DATA_EVENT: &str = "pty:data";
pub const CLOSED_EVENT: &str = "pty:closed";

const TERM: &str = "xterm-256color";

#[derive(Debug, Clone, Serialize)]
pub struct PtyData {
    pub session_id: String,
    /// Raw terminal bytes, base64-encoded (JSON events can't carry binary).
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyClosed {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
}

/// Where session output goes. The app implements this with Tauri events;
/// integration tests implement it with a channel.
pub trait PtyEvents: Send + Sync + 'static {
    fn data(&self, payload: PtyData);
    fn closed(&self, payload: PtyClosed);
}

impl PtyEvents for tauri::AppHandle {
    fn data(&self, payload: PtyData) {
        let _ = self.emit(DATA_EVENT, &payload);
    }
    fn closed(&self, payload: PtyClosed) {
        let _ = self.emit(CLOSED_EVENT, &payload);
    }
}

/// Typed result of a PTY open attempt — mirrors ProbeResult/ExecResult so the
/// frontend reuses the same TOFU dialogs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PtyOpenResult {
    Opened,
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

enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// One registered session: the command channel into its task, plus the epoch
/// stamped at registration so a task can tell whether the map entry is still
/// its own (a later open with the same id replaces the entry — see
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

    /// Deregisters the session only if the entry still belongs to the task
    /// stamped with `epoch`. Returns whether it did — false means the entry
    /// was already removed (deliberate close) or replaced by a newer open
    /// with the same id, and the caller must not tear down or report on the
    /// replacement's behalf.
    fn remove_if_current(&self, session_id: &str, epoch: u64) -> bool {
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
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
    cols: u32,
    rows: u32,
) -> AppResult<PtyOpenResult> {
    let handle =
        match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
            Ok(h) => h,
            Err(failure) => return Ok(failure.into()),
        };

    let mut channel = handle
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

    let (tx, mut rx) = mpsc::channel::<SessionCmd>(64);
    let epoch = state.insert(session_id.clone(), tx);
    let state = state.clone();

    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<u32> = None;
        let mut message: Option<String> = None;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        events.data(PtyData {
                            session_id: session_id.clone(),
                            data_b64: B64.encode(data),
                        });
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        events.data(PtyData {
                            session_id: session_id.clone(),
                            data_b64: B64.encode(data),
                        });
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(SessionCmd::Write(data)) => {
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
        // into a dead task — but only if the entry is still OURS. A second
        // open with the same session id replaces the entry; the replaced
        // task must not deregister its successor or report a close the UI
        // would misattribute to the live session.
        if state.remove_if_current(&session_id, epoch) {
            events.closed(PtyClosed {
                session_id: session_id.clone(),
                exit_code,
                message,
            });
        }
    });

    Ok(PtyOpenResult::Opened)
}
