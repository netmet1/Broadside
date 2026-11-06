//! Workspace snapshot CRUD (see db/snapshots.rs).
//!
//! Like the template commands, nothing here opens a session. A snapshot is a
//! list of references; the frontend turns it into tabs through the one path
//! every session takes, and decides whether they connect straight away.

use tauri::State;

use super::ssh::with_db;
use crate::db::snapshots as repo;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

fn with_db_mut<T>(
    state: &State<'_, DbState>,
    f: impl FnOnce(&mut rusqlite::Connection) -> AppResult<T>,
) -> AppResult<T> {
    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))?;
    f(&mut conn)
}

#[tauri::command]
pub fn list_snapshots(state: State<'_, DbState>) -> AppResult<Vec<repo::Snapshot>> {
    with_db(&state, repo::list)
}

#[tauri::command]
pub fn create_snapshot(
    input: repo::SnapshotInput,
    state: State<'_, DbState>,
) -> AppResult<repo::Snapshot> {
    with_db_mut(&state, |conn| repo::create(conn, &input))
}

/// Takes the snapshot again from what is open now.
#[tauri::command]
pub fn update_snapshot(
    id: i64,
    input: repo::SnapshotInput,
    state: State<'_, DbState>,
) -> AppResult<repo::Snapshot> {
    with_db_mut(&state, |conn| repo::update(conn, id, &input))
}

#[tauri::command]
pub fn rename_snapshot(
    id: i64,
    name: String,
    state: State<'_, DbState>,
) -> AppResult<repo::Snapshot> {
    with_db_mut(&state, |conn| repo::rename(conn, id, &name))
}

#[tauri::command]
pub fn delete_snapshot(id: i64, state: State<'_, DbState>) -> AppResult<usize> {
    with_db(&state, |conn| repo::delete(conn, id))
}
