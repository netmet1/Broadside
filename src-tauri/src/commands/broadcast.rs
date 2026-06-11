//! Broadcast execution commands (D-002/D-003/D-004) with destructive-command
//! re-validation (D-014) and sudo auto-elevation (D-026).

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::ssh::{auth_for_host, with_db};
use crate::credentials::CredentialState;
use crate::db::host_keys;
use crate::db::hosts as host_repo;
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::guard::{self, GuardHit};
use crate::ssh::exec::{exec, ExecResult};
use crate::ssh::AuthMethod;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 3600;

/// Event emitted once per host as that host finishes — the frontend renders
/// blocks in arrival order (per-host-first-done, D-003).
pub const RESULT_EVENT: &str = "broadcast:result";

#[derive(Debug, Clone, Serialize)]
pub struct HostExecReport {
    pub run_id: String,
    pub host_id: i64,
    pub label: String,
    pub color: String,
    pub result: ExecResult,
}

/// Frontend pre-send check for the CONFIRM modal. The same check re-runs
/// inside `broadcast_command` — this command is UX, that one is the gate.
#[tauri::command]
pub fn check_destructive(command: String) -> Vec<GuardHit> {
    guard::check(&command)
}

/// Runs `command` on every host in `host_ids` concurrently. Each host's
/// outcome is emitted as a `broadcast:result` event the moment it completes,
/// and the full set is also returned (completion order).
#[tauri::command]
pub async fn broadcast_command(
    run_id: String,
    host_ids: Vec<i64>,
    command: String,
    timeout_secs: Option<u64>,
    confirmed: Option<bool>,
    app: AppHandle,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
) -> AppResult<Vec<HostExecReport>> {
    if host_ids.is_empty() {
        return Err(AppError::InvalidInput("no hosts selected".into()));
    }
    if command.trim().is_empty() {
        return Err(AppError::InvalidInput("command is empty".into()));
    }
    let timeout = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    // Defense in depth (D-014): the frontend modal is the UX, this check is
    // the gate. A destructive command without the confirmed flag is refused
    // regardless of what the IPC caller claims.
    let hits = guard::check(&command);
    if !hits.is_empty() && confirmed != Some(true) {
        let rules: Vec<&str> = hits.iter().map(|h| h.rule_id.as_str()).collect();
        return Err(AppError::DestructiveBlocked(rules.join(", ")));
    }

    // Sudo auto-elevation (D-026): rewrite once, then apply per host only
    // when that host actually has a sudo password stored.
    let rewrite = guard::rewrite_for_sudo(&command);

    // Gather every per-host input synchronously so no db/credential lock is
    // held across an await point.
    struct Job {
        host: host_repo::Host,
        fingerprints: Vec<String>,
        auth: Option<AuthMethod>,
        command: String,
        stdin_payload: Option<String>,
    }
    let mut jobs: Vec<Job> = Vec::with_capacity(host_ids.len());
    for host_id in &host_ids {
        let (host, keys) = with_db(&state, |conn| {
            let host = host_repo::get(conn, *host_id)?;
            let keys = host_keys::list_for_endpoint(conn, &host.hostname, host.port)?;
            Ok((host, keys))
        })?;
        let auth = auth_for_host(&host, &cred_state)?;
        let sudo_password = if rewrite.needs_password && host.has_sudo_password {
            cred_state.get_sudo_password(host.id)?
        } else {
            None
        };
        let (cmd, stdin_payload) = match sudo_password {
            Some(pw) => (rewrite.command.clone(), Some(format!("{pw}\n"))),
            // No stored sudo password: send the original command — sudo's
            // own failure surfaces in this host's output (D-026).
            None => (command.clone(), None),
        };
        jobs.push(Job {
            fingerprints: keys.iter().map(|k| k.fingerprint_sha256.clone()).collect(),
            auth,
            command: cmd,
            stdin_payload,
            host,
        });
    }

    let mut handles = Vec::with_capacity(jobs.len());
    for job in jobs {
        let app = app.clone();
        let run_id = run_id.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let result = match job.auth {
                None => ExecResult::NoCredentials,
                Some(auth) => exec(
                    &job.host.hostname,
                    job.host.port,
                    &job.host.username,
                    job.fingerprints,
                    auth,
                    &job.command,
                    job.stdin_payload,
                    timeout,
                )
                .await
                .unwrap_or_else(|e| ExecResult::Unreachable {
                    message: e.to_string(),
                }),
            };
            let report = HostExecReport {
                run_id,
                host_id: job.host.id,
                label: job.host.label,
                color: job.host.color,
                result,
            };
            let _ = app.emit(RESULT_EVENT, &report);
            report
        }));
    }

    let mut reports = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(report) => reports.push(report),
            Err(e) => return Err(AppError::State(format!("broadcast task panicked: {e}"))),
        }
    }
    Ok(reports)
}
