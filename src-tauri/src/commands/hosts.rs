use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

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

#[tauri::command]
pub fn delete_host(id: i64, state: State<'_, DbState>) -> AppResult<()> {
    let conn = lock(&state)?;
    host_repo::delete(&conn, id)
}
