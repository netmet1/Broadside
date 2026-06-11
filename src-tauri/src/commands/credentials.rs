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
