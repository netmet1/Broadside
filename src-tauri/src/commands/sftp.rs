//! Tauri commands for the SFTP feature (single-host browser + transfers).
//!
//! Follows the SSH command conventions: gather DB/credential data before any
//! `.await` (no sync guard across a suspend point), return `AppResult`, log
//! failures to `ErrLogState`, and audit transfers via `AuditState`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::audit::{AuditEvent, AuditState};
use crate::credentials::CredentialState;
use crate::db::host_keys::{self, HostKey};
use crate::db::hosts as host_repo;
use crate::db::DbState;
use crate::errlog::ErrLogState;
use crate::error::AppResult;
use crate::ssh::sftp::{
    self, SftpConnectResult, SftpEntry, SftpState, TransferMode, TransferStats,
};

use super::ssh::{auth_for_host, with_db};

/// Live progress for a recursive folder transfer, emitted as `sftp:transfer_progress`.
/// The frontend already knows the name/direction/totals (from its pre-flight
/// scan), so this only carries the running counts keyed by `transfer_id`.
#[derive(Clone, Serialize)]
struct TransferProgress {
    transfer_id: String,
    files_done: u64,
    bytes_done: u64,
}

/// Opens an SFTP session to a host and registers it under `session_id`. Mirrors
/// `test_connection`'s gather-then-await flow and result shape.
#[tauri::command]
pub async fn sftp_connect(
    host_id: i64,
    session_id: String,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
    sftp_state: State<'_, SftpState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<SftpConnectResult> {
    // Gather host + trusted keys + credentials before any await.
    let (host, trusted) = with_db(&state, |conn| {
        let host = host_repo::get(conn, host_id)?;
        let keys = host_keys::list_for_endpoint(conn, &host.hostname, host.port)?;
        Ok((host, keys))
    })?;

    let auth = match auth_for_host(&host, &cred_state)? {
        Some(a) => a,
        None => {
            errlog.log(
                "sftp_connect",
                Some(host.id),
                Some(&host.label),
                "no credentials stored",
            );
            return Ok(SftpConnectResult::NoCredentials);
        }
    };

    let fingerprints: Vec<String> = trusted
        .iter()
        .map(|k: &HostKey| k.fingerprint_sha256.clone())
        .collect();

    let result = sftp::open(
        &sftp_state,
        session_id,
        &host.hostname,
        host.port,
        &host.username,
        fingerprints,
        auth,
    )
    .await?;

    // Failure modes that surface to the operator also persist to the error log
    // (mirrors test_connection / D-055).
    match &result {
        SftpConnectResult::AuthFailed { message } => errlog.log(
            "sftp_connect",
            Some(host.id),
            Some(&host.label),
            &format!("authentication failed — {message}"),
        ),
        SftpConnectResult::Unreachable { message } => errlog.log(
            "sftp_connect",
            Some(host.id),
            Some(&host.label),
            &format!("unreachable — {message}"),
        ),
        SftpConnectResult::KeyMismatch { .. } => errlog.log(
            "sftp_connect",
            Some(host.id),
            Some(&host.label),
            "host key mismatch — connection refused",
        ),
        _ => {}
    }
    Ok(result)
}

/// Lists a remote directory (folders first, then files).
#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<Vec<SftpEntry>> {
    sftp::list(&sftp_state, &session_id, &path).await
}

/// Creates a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<()> {
    sftp::mkdir(&sftp_state, &session_id, &path).await
}

/// Creates a remote directory and any missing ancestors (like `mkdir -p`).
/// Backs the broadcast tab's "create path if doesn't exist" toggle.
#[tauri::command]
pub async fn sftp_ensure_remote_dir(
    session_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<()> {
    sftp::ensure_dir(&sftp_state, &session_id, &path).await
}

/// Deletes a remote file (or empty directory when `is_dir`).
#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    is_dir: bool,
    sftp_state: State<'_, SftpState>,
) -> AppResult<()> {
    sftp::remove(&sftp_state, &session_id, &path, is_dir).await
}

/// Uploads a local file to the remote path and audits the transfer. When a
/// `transfer_id` is given, emits `sftp:transfer_progress` (keyed by it) as the
/// file streams, so the broadcast tab can show a live byte progress bar.
#[tauri::command]
pub async fn sftp_upload(
    host_id: i64,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<u64> {
    let on_progress = |bytes_done: u64| {
        if let Some(tid) = &transfer_id {
            let _ = app.emit(
                "sftp:transfer_progress",
                TransferProgress {
                    transfer_id: tid.clone(),
                    files_done: 0,
                    bytes_done,
                },
            );
        }
    };
    let cancel = sftp_state.begin_transfer(&session_id);
    let result = sftp::upload(&sftp_state, &session_id, &local_path, &remote_path, &cancel, on_progress).await;
    sftp_state.end_transfer(&session_id);
    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            errlog.log("sftp_upload", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
        let _ = audit.append(&AuditEvent::SftpTransfer {
            host_label: host.label,
            hostname: host.hostname,
            port: host.port,
            direction: "put".into(),
            local_path,
            remote_path,
            bytes,
        });
    }
    Ok(bytes)
}

/// Downloads a remote file to the local path and audits the transfer. When a
/// `transfer_id` is given, emits `sftp:transfer_progress` (keyed by it) as the
/// file streams, so the broadcast tab can show a live byte progress bar.
#[tauri::command]
pub async fn sftp_download(
    host_id: i64,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<u64> {
    let on_progress = |bytes_done: u64| {
        if let Some(tid) = &transfer_id {
            let _ = app.emit(
                "sftp:transfer_progress",
                TransferProgress {
                    transfer_id: tid.clone(),
                    files_done: 0,
                    bytes_done,
                },
            );
        }
    };
    let cancel = sftp_state.begin_transfer(&session_id);
    let result = sftp::download(&sftp_state, &session_id, &remote_path, &local_path, &cancel, on_progress).await;
    sftp_state.end_transfer(&session_id);
    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            errlog.log("sftp_download", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
        let _ = audit.append(&AuditEvent::SftpTransfer {
            host_label: host.label,
            hostname: host.hostname,
            port: host.port,
            direction: "get".into(),
            local_path,
            remote_path,
            bytes,
        });
    }
    Ok(bytes)
}

/// Pre-flight: counts files + total bytes under a remote directory (drives the
/// large-folder warning before a recursive get).
#[tauri::command]
pub async fn sftp_scan_dir(
    session_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<TransferStats> {
    sftp::scan_remote_dir(&sftp_state, &session_id, &path).await
}

/// Recursively uploads a local directory and audits the transfer. Emits
/// `sftp:transfer_progress` events (keyed by `transfer_id`) as it runs.
#[tauri::command]
pub async fn sftp_upload_dir(
    host_id: i64,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    mode: TransferMode,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<TransferStats> {
    let on_progress = |files_done: u64, bytes_done: u64| {
        let _ = app.emit(
            "sftp:transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.clone(),
                files_done,
                bytes_done,
            },
        );
    };
    let cancel = sftp_state.begin_transfer(&session_id);
    let result = sftp::upload_dir(
        &sftp_state,
        &session_id,
        &local_path,
        &remote_path,
        mode,
        &cancel,
        on_progress,
    )
    .await;
    sftp_state.end_transfer(&session_id);
    let stats = match result {
        Ok(s) => s,
        Err(e) => {
            errlog.log("sftp_upload_dir", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
        let _ = audit.append(&AuditEvent::SftpTransfer {
            host_label: host.label,
            hostname: host.hostname,
            port: host.port,
            direction: "put".into(),
            local_path,
            remote_path,
            bytes: stats.bytes,
        });
    }
    Ok(stats)
}

/// Recursively downloads a remote directory and audits the transfer. Emits
/// `sftp:transfer_progress` events (keyed by `transfer_id`) as it runs.
#[tauri::command]
pub async fn sftp_download_dir(
    host_id: i64,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    mode: TransferMode,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<TransferStats> {
    let on_progress = |files_done: u64, bytes_done: u64| {
        let _ = app.emit(
            "sftp:transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.clone(),
                files_done,
                bytes_done,
            },
        );
    };
    let cancel = sftp_state.begin_transfer(&session_id);
    let result = sftp::download_dir(
        &sftp_state,
        &session_id,
        &remote_path,
        &local_path,
        mode,
        &cancel,
        on_progress,
    )
    .await;
    sftp_state.end_transfer(&session_id);
    let stats = match result {
        Ok(s) => s,
        Err(e) => {
            errlog.log("sftp_download_dir", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
        let _ = audit.append(&AuditEvent::SftpTransfer {
            host_label: host.label,
            hostname: host.hostname,
            port: host.port,
            direction: "get".into(),
            local_path,
            remote_path,
            bytes: stats.bytes,
        });
    }
    Ok(stats)
}

/// Signals the session's in-flight recursive transfer to stop at the next file.
#[tauri::command]
pub fn sftp_cancel_transfer(
    session_id: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<()> {
    sftp_state.signal_cancel(&session_id);
    Ok(())
}

/// Closes and deregisters an SFTP session (idempotent). Also stops any in-flight
/// transfer for the session (see `SftpState::remove`).
#[tauri::command]
pub fn sftp_disconnect(session_id: String, sftp_state: State<'_, SftpState>) -> AppResult<()> {
    sftp_state.remove(&session_id);
    Ok(())
}
