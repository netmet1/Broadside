use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::credentials::{AuthInput, CredentialState};
use crate::db::hosts as host_repo;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

fn lock_db<'a>(state: &'a State<'_, DbState>) -> AppResult<MutexGuard<'a, Connection>> {
    state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))
}

#[tauri::command]
pub fn set_host_credentials(
    host_id: i64,
    auth: AuthInput,
    cred_state: State<'_, CredentialState>,
    db_state: State<'_, DbState>,
) -> AppResult<()> {
    cred_state.apply_auth(host_id, &auth)?;
    let (auth_method, key_path) = match &auth {
        AuthInput::Password { .. } => ("password", None),
        AuthInput::Key { path, .. } => ("key", Some(path.as_str())),
    };
    let conn = lock_db(&db_state)?;
    host_repo::set_auth_method(&conn, host_id, Some(auth_method), key_path)
}

#[tauri::command]
pub fn clear_host_credentials(
    host_id: i64,
    cred_state: State<'_, CredentialState>,
    db_state: State<'_, DbState>,
) -> AppResult<()> {
    cred_state.clear_host(host_id)?;
    let conn = lock_db(&db_state)?;
    host_repo::set_auth_method(&conn, host_id, None, None)
}

/// Sets (Some) or clears (None) the per-host sudo password (D-026) and
/// records its presence on the host row for UI affordances.
#[tauri::command]
pub fn set_sudo_password(
    host_id: i64,
    value: Option<String>,
    cred_state: State<'_, CredentialState>,
    db_state: State<'_, DbState>,
) -> AppResult<()> {
    let value = value.filter(|v| !v.is_empty());
    cred_state.set_sudo_password(host_id, value.as_deref())?;
    let conn = lock_db(&db_state)?;
    host_repo::set_has_sudo_password(&conn, host_id, value.is_some())
}

/// Copies the host's stored SSH password into the sudo password slot
/// ("Same as SSH password" checkbox, D-026). Backend-side copy because
/// stored credentials never flow back to the UI (D-031).
#[tauri::command]
pub fn set_sudo_same_as_login(
    host_id: i64,
    cred_state: State<'_, CredentialState>,
    db_state: State<'_, DbState>,
) -> AppResult<()> {
    let password = cred_state.get_password(host_id)?.ok_or_else(|| {
        AppError::InvalidInput("no SSH password stored for this host".into())
    })?;
    cred_state.set_sudo_password(host_id, Some(&password))?;
    let conn = lock_db(&db_state)?;
    host_repo::set_has_sudo_password(&conn, host_id, true)
}

#[tauri::command]
pub fn is_credentials_unlocked(state: State<'_, CredentialState>) -> bool {
    state.is_unlocked()
}

#[tauri::command]
pub fn requires_master_password(state: State<'_, CredentialState>) -> bool {
    state.requires_master_password()
}

#[tauri::command]
pub fn unlock_credentials(
    master_password: String,
    state: State<'_, CredentialState>,
) -> AppResult<bool> {
    state.unlock(&master_password)
}
