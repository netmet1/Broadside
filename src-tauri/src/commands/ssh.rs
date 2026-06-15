use tauri::State;

use crate::audit::{AuditEvent, AuditState};
use crate::credentials::CredentialState;
use crate::db::host_keys::{self, HostKey};
use crate::db::hosts as host_repo;
use crate::db::DbState;
use crate::errlog::ErrLogState;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, AuthMethod, ProbeResult};

pub(crate) fn with_db<T>(
    state: &State<'_, DbState>,
    f: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
) -> AppResult<T> {
    let conn = state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))?;
    f(&conn)
}

/// Builds the auth method for a host from its stored credentials, or None
/// when no usable credentials exist.
pub(crate) fn auth_for_host(
    host: &host_repo::Host,
    cred_state: &CredentialState,
) -> AppResult<Option<AuthMethod>> {
    Ok(match host.auth_method.as_deref() {
        Some("password") => cred_state.get_password(host.id)?.map(AuthMethod::Password),
        Some("key") => match &host.key_path {
            Some(path) => Some(AuthMethod::Key {
                path: path.clone(),
                passphrase: cred_state.get_passphrase(host.id)?,
            }),
            None => None,
        },
        _ => None,
    })
}

#[tauri::command]
pub async fn test_connection(
    host_id: i64,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
    errlog: State<'_, ErrLogState>,
) -> AppResult<ProbeResult> {
    // Gather everything from db + credential store before any await so no
    // sync guard lives across a suspension point.
    let (host, trusted) = with_db(&state, |conn| {
        let host = host_repo::get(conn, host_id)?;
        let keys = host_keys::list_for_endpoint(conn, &host.hostname, host.port)?;
        Ok((host, keys))
    })?;

    let auth = match auth_for_host(&host, &cred_state)? {
        Some(a) => a,
        None => {
            // A missing credential is an operator-visible failure too (D-055
            // amendment, 2026-06-13): the toast appears, so the error log must
            // record it like the other failure modes.
            errlog.log(
                "test_connection",
                Some(host.id),
                Some(&host.label),
                "no credentials stored",
            );
            return Ok(ProbeResult::NoCredentials);
        }
    };

    let fingerprints: Vec<String> = trusted
        .iter()
        .map(|k: &HostKey| k.fingerprint_sha256.clone())
        .collect();

    let result = ssh::probe(
        &host.hostname,
        host.port,
        &host.username,
        fingerprints,
        auth,
    )
    .await?;

    if matches!(result, ProbeResult::Ok { .. }) {
        // Refresh last_seen on whichever stored key matched.
        with_db(&state, |conn| {
            for key in &trusted {
                host_keys::touch_last_seen(conn, &key.hostname, key.port, &key.key_type)?;
            }
            Ok(())
        })?;
    }
    // Failures that toast also persist to the error log (D-055).
    match &result {
        ProbeResult::AuthFailed { message } => errlog.log(
            "test_connection",
            Some(host.id),
            Some(&host.label),
            &format!("authentication failed — {message}"),
        ),
        ProbeResult::Unreachable { message } => errlog.log(
            "test_connection",
            Some(host.id),
            Some(&host.label),
            &format!("unreachable — {message}"),
        ),
        ProbeResult::KeyMismatch { .. } => errlog.log(
            "test_connection",
            Some(host.id),
            Some(&host.label),
            "host key mismatch — connection refused",
        ),
        _ => {}
    }
    Ok(result)
}

/// Stores the presented key as the sole trusted key for the endpoint.
/// Used both for first-trust (TOFU accept) and trust-after-mismatch, so any
/// previously stored keys for the endpoint are removed first.
#[tauri::command]
pub fn trust_host_key(
    hostname: String,
    port: u16,
    key_type: String,
    public_key: String,
    fingerprint_sha256: String,
    state: State<'_, DbState>,
    audit: State<'_, AuditState>,
) -> AppResult<()> {
    with_db(&state, |conn| {
        host_keys::remove(conn, &hostname, port)?;
        host_keys::trust(
            conn,
            &hostname,
            port,
            &key_type,
            &public_key,
            &fingerprint_sha256,
        )
    })?;
    // Trust decisions are audit-worthy (D-034); failures never block trust.
    let _ = audit.append(&AuditEvent::KeyTrusted {
        hostname,
        port,
        key_type,
        fingerprint_sha256,
    });
    Ok(())
}

#[tauri::command]
pub fn remove_host_key(
    hostname: String,
    port: u16,
    state: State<'_, DbState>,
) -> AppResult<usize> {
    with_db(&state, |conn| host_keys::remove(conn, &hostname, port))
}
