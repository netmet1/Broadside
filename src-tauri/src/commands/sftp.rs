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
    self, FileTransfer, SftpConnectResult, SftpEntry, SftpState, TransferMode, TransferStats,
};

use super::ssh::{auth_for_host, note_connect, with_db};

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
            note_connect(&state, host.id, true);
            return Ok(SftpConnectResult::NoCredentials);
        }
    };

    let fingerprints: Vec<String> = trusted
        .iter()
        .map(|k: &HostKey| k.fingerprint_sha256.clone())
        .collect();

    // As in `test_connection`: an error out of the open is a failed attempt, and
    // `?` alone would leave it unlogged and the host unmarked.
    let result = match sftp::open(
        &sftp_state,
        session_id,
        &host.hostname,
        host.port,
        &host.username,
        fingerprints,
        auth,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            errlog.log(
                "sftp_connect",
                Some(host.id),
                Some(&host.label),
                &format!("connection failed: {e}"),
            );
            note_connect(&state, host.id, true);
            return Err(e);
        }
    };

    // Failure modes that surface to the operator also persist to the error log
    // (mirrors test_connection / D-055), and say whether the host answered, so
    // the Hosts tab's red Test button agrees with what happened here.
    match &result {
        SftpConnectResult::Ok { .. } => note_connect(&state, host.id, false),
        SftpConnectResult::AuthFailed { message } => {
            errlog.log(
                "sftp_connect",
                Some(host.id),
                Some(&host.label),
                &format!("authentication failed: {message}"),
            );
            note_connect(&state, host.id, true);
        }
        SftpConnectResult::Unreachable { message } => {
            errlog.log(
                "sftp_connect",
                Some(host.id),
                Some(&host.label),
                &format!("unreachable: {message}"),
            );
            note_connect(&state, host.id, true);
        }
        SftpConnectResult::KeyMismatch { .. } => errlog.log(
            "sftp_connect",
            Some(host.id),
            Some(&host.label),
            "host key mismatch: connection refused",
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

/// Renames a remote file or folder in its own folder; resolves with the new path.
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    path: String,
    new_name: String,
    sftp_state: State<'_, SftpState>,
) -> AppResult<String> {
    sftp::rename(&sftp_state, &session_id, &path, &new_name).await
}

/// Uploads a local file to the remote path and audits the transfer. When a
/// `transfer_id` is given, emits `sftp:transfer_progress` (keyed by it) as the
/// file streams, so the broadcast tab can show a live byte progress bar.
///
/// A cancelled upload is not an error: it comes back with `cancelled` set and
/// the part-written remote file already removed. Only a completed one is
/// audited, because a transfer that left nothing behind did not happen. `mode`
/// is the clash mode, and a file it skips comes back with `skipped` set and is
/// not audited either: nothing was sent.
#[tauri::command]
pub async fn sftp_upload(
    host_id: i64,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    mode: TransferMode,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<FileTransfer> {
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
    let (key, cancel) = sftp_state.begin_transfer(&session_id, transfer_id.as_deref());
    let result = sftp::upload(&sftp_state, &session_id, &local_path, &remote_path, mode, &cancel, on_progress).await;
    sftp_state.end_transfer(&key);
    let transfer = match result {
        Ok(t) => t,
        Err(e) => {
            errlog.log("sftp_upload", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if !transfer.cancelled && !transfer.skipped {
        if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
            let _ = audit.append(&AuditEvent::SftpTransfer {
                host_label: host.label,
                hostname: host.hostname,
                port: host.port,
                direction: "put".into(),
                local_path,
                remote_path,
                bytes: transfer.bytes,
            });
        }
    }
    Ok(transfer)
}

/// Downloads a remote file to the local path and audits the transfer. When a
/// `transfer_id` is given, emits `sftp:transfer_progress` (keyed by it) as the
/// file streams, so the broadcast tab can show a live byte progress bar.
///
/// A cancelled download is not an error: it comes back with `cancelled` set and
/// the part-written local file already removed. Only a completed one is audited,
/// because a transfer that left nothing behind did not happen. `mode` is the
/// clash mode, as for [`sftp_upload`].
#[tauri::command]
pub async fn sftp_download(
    host_id: i64,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    mode: TransferMode,
    app: AppHandle,
    sftp_state: State<'_, SftpState>,
    db: State<'_, DbState>,
    audit: State<'_, AuditState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<FileTransfer> {
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
    let (key, cancel) = sftp_state.begin_transfer(&session_id, transfer_id.as_deref());
    let result = sftp::download(&sftp_state, &session_id, &remote_path, &local_path, mode, &cancel, on_progress).await;
    sftp_state.end_transfer(&key);
    let transfer = match result {
        Ok(t) => t,
        Err(e) => {
            errlog.log("sftp_download", Some(host_id), None, &e.to_string());
            return Err(e);
        }
    };
    if !transfer.cancelled && !transfer.skipped {
        if let Ok(host) = with_db(&db, |c| host_repo::get(c, host_id)) {
            let _ = audit.append(&AuditEvent::SftpTransfer {
                host_label: host.label,
                hostname: host.hostname,
                port: host.port,
                direction: "get".into(),
                local_path,
                remote_path,
                bytes: transfer.bytes,
            });
        }
    }
    Ok(transfer)
}

/// Pre-flight: counts files + total bytes under a remote directory (drives the
/// large-folder warning before a recursive get). `scan_id` makes it cancellable
/// through `sftp_cancel_transfer` like a transfer, and a disconnect stops it.
#[tauri::command]
pub async fn sftp_scan_dir(
    session_id: String,
    path: String,
    scan_id: Option<String>,
    sftp_state: State<'_, SftpState>,
) -> AppResult<TransferStats> {
    let (key, cancel) = sftp_state.begin_transfer(&session_id, scan_id.as_deref());
    let result = sftp::scan_remote_dir(&sftp_state, &session_id, &path, &cancel).await;
    sftp_state.end_transfer(&key);
    result
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
    let (key, cancel) = sftp_state.begin_transfer(&session_id, Some(&transfer_id));
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
    sftp_state.end_transfer(&key);
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
    let (key, cancel) = sftp_state.begin_transfer(&session_id, Some(&transfer_id));
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
    sftp_state.end_transfer(&key);
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

/// Signals an in-flight transfer to stop at its next chunk. With a
/// `transfer_id`, just that one; without, every transfer the session has in
/// flight (what Disconnect and "cancel all" want).
#[tauri::command]
pub fn sftp_cancel_transfer(
    session_id: String,
    transfer_id: Option<String>,
    sftp_state: State<'_, SftpState>,
) -> AppResult<()> {
    match transfer_id {
        Some(tid) => sftp_state.cancel_transfer(&session_id, &tid),
        None => sftp_state.cancel_session(&session_id),
    }
    Ok(())
}

/// Closes and deregisters an SFTP session (idempotent). Also stops any in-flight
/// transfer for the session (see `SftpState::remove`).
#[tauri::command]
pub fn sftp_disconnect(session_id: String, sftp_state: State<'_, SftpState>) -> AppResult<()> {
    sftp_state.remove(&session_id);
    Ok(())
}
