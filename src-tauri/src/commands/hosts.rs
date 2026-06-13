use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::credentials::CredentialState;
use crate::db::hosts::{self as host_repo, Host, HostInput};
use crate::db::DbState;
use crate::error::{AppError, AppResult};

fn lock<'a>(state: &'a State<'_, DbState>) -> AppResult<MutexGuard<'a, Connection>> {
    state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))
}

#[tauri::command]
pub fn list_hosts(state: State<'_, DbState>) -> AppResult<Vec<Host>> {
    let conn = lock(&state)?;
    host_repo::list_all(&conn)
}

#[tauri::command]
pub fn get_host(id: i64, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::get(&conn, id)
}

#[tauri::command]
pub fn create_host(input: HostInput, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::create(&conn, input)
}

#[tauri::command]
pub fn update_host(id: i64, input: HostInput, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::update(&conn, id, input)
}

/// Writes all hosts to a CSV or `.xlsx` file (chosen by the path's extension)
/// that round-trips through "Import hosts…". Returns the number written.
#[tauri::command]
pub fn export_hosts(path: String, state: State<'_, DbState>) -> AppResult<usize> {
    let hosts = {
        let conn = lock(&state)?;
        host_repo::list_all(&conn)?
    };
    let p = std::path::Path::new(&path);
    let is_xlsx = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
    if is_xlsx {
        crate::export::write_hosts_xlsx(&hosts, p)?;
    } else {
        crate::export::write_hosts_csv(&hosts, p)?;
    }
    Ok(hosts.len())
}

/// Whether a local path points at an existing file — used by the host form
/// to validate a hand-typed private-key path before saving.
#[tauri::command]
pub fn path_is_file(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

#[tauri::command]
pub fn delete_host(
    id: i64,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
) -> AppResult<()> {
    let auth_method = {
        let conn = lock(&state)?;
        host_repo::get(&conn, id)?.auth_method
    };
    if auth_method.is_some() {
        cred_state.clear_host(id)?;
    }
    let conn = lock(&state)?;
    host_repo::delete(&conn, id)
}
