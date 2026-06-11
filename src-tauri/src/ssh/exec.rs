//! One-shot remote command execution for broadcast (D-002 exec model).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::Serialize;

use super::{connect_and_auth, AuthMethod, ConnectFailure, PresentedKey};
use crate::error::{AppError, AppResult};

/// Outcome of one host's broadcast execution.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExecResult {
    /// The command ran (possibly cut off by the timeout — see `timed_out`).
    Completed {
        /// None when the channel closed without reporting an exit status
        /// (e.g. after a timeout).
        exit_code: Option<u32>,
        stdout: String,
        stderr: String,
        duration_ms: u64,
        /// True when the per-command timeout elapsed; stdout/stderr hold
        /// whatever partial output arrived before the cutoff (D-004).
        timed_out: bool,
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

impl From<ConnectFailure> for ExecResult {
    fn from(f: ConnectFailure) -> Self {
        match f {
            ConnectFailure::UnknownKey { key } => ExecResult::UnknownKey { key },
            ConnectFailure::KeyMismatch {
                stored_fingerprint,
                presented,
            } => ExecResult::KeyMismatch {
                stored_fingerprint,
                presented,
            },
            ConnectFailure::AuthFailed { message } => ExecResult::AuthFailed { message },
            ConnectFailure::Unreachable { message } => ExecResult::Unreachable { message },
        }
    }
}

/// Connects, authenticates (TOFU-verified), runs `command` on an exec
/// channel, and drains output until close or `timeout`.
///
/// `stdin_payload` is written to the channel before stdin is closed — used
/// to pipe a sudo password to `sudo -S` (D-026). It never appears in the
/// remote argv.
#[allow(clippy::too_many_arguments)]
pub async fn exec(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
    command: &str,
    stdin_payload: Option<String>,
    timeout: Duration,
) -> AppResult<ExecResult> {
    let started = Instant::now();
    let handle =
        match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
            Ok(h) => h,
            Err(failure) => return Ok(failure.into()),
        };

    // Output accumulates in shared buffers AS it arrives so that a timeout
    // still surfaces the partial output (D-004).
    let stdout_acc = Arc::new(Mutex::new(String::new()));
    let stderr_acc = Arc::new(Mutex::new(String::new()));

    let run = {
        let stdout_acc = stdout_acc.clone();
        let stderr_acc = stderr_acc.clone();
        async move {
            let mut channel = handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(format!("channel open: {e}")))?;
            channel
                .exec(true, command)
                .await
                .map_err(|e| AppError::Ssh(format!("exec request: {e}")))?;

            if let Some(payload) = &stdin_payload {
                channel
                    .data(payload.as_bytes())
                    .await
                    .map_err(|e| AppError::Ssh(format!("stdin write: {e}")))?;
            }
            // Close stdin so commands that read it see EOF instead of hanging.
            channel
                .eof()
                .await
                .map_err(|e| AppError::Ssh(format!("stdin eof: {e}")))?;

            let mut exit_code: Option<u32> = None;
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { ref data }) => {
                        stdout_acc
                            .lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(data));
                    }
                    Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                        stderr_acc
                            .lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(data));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
            Ok::<_, AppError>((exit_code, handle))
        }
    };

    let result = tokio::time::timeout(timeout, run).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok((exit_code, handle))) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(ExecResult::Completed {
                exit_code,
                stdout: stdout_acc.lock().unwrap().clone(),
                stderr: stderr_acc.lock().unwrap().clone(),
                duration_ms,
                timed_out: false,
            })
        }
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => {
            // The run future (and the handle it owns) is dropped; the
            // connection tears down with it. Partial output survives in the
            // shared buffers.
            Ok(ExecResult::Completed {
                exit_code: None,
                stdout: stdout_acc.lock().unwrap().clone(),
                stderr: stderr_acc.lock().unwrap().clone(),
                duration_ms,
                timed_out: true,
            })
        }
    }
}
