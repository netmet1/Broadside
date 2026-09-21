//! Saved local-shell launch profiles. See `db::shell_profiles` for why they are
//! in the database and what keeps the startup command honest.
//!
//! Every command here is a database read or write, or a file the operator
//! picked in a dialog. Nothing spawns a process. File reads and writes happen
//! outside the database lock, so a slow disk never holds up other IPC.

use tauri::State;

use crate::commands::ssh::with_db;
use crate::db::shell_profiles::{
    self as repo, LegacyImport, NewShellProfile, ShellProfile, ShellProfileInput,
};
use crate::db::DbState;
use crate::error::AppResult;

/// Every profile, in launcher order.
#[tauri::command]
pub fn list_shell_profiles(state: State<'_, DbState>) -> AppResult<Vec<ShellProfile>> {
    with_db(&state, repo::list)
}

/// Creates a profile under a uuid the frontend made. `after` puts it directly
/// below that profile (Duplicate); without it, it goes at the end.
#[tauri::command]
pub fn create_shell_profile(
    id: String,
    input: ShellProfileInput,
    after: Option<String>,
    state: State<'_, DbState>,
) -> AppResult<ShellProfile> {
    with_db(&state, |conn| repo::create(conn, &id, &input, after.as_deref()))
}

#[tauri::command]
pub fn update_shell_profile(
    id: String,
    input: ShellProfileInput,
    state: State<'_, DbState>,
) -> AppResult<ShellProfile> {
    with_db(&state, |conn| repo::update(conn, &id, &input))
}

#[tauri::command]
pub fn delete_shell_profile(id: String, state: State<'_, DbState>) -> AppResult<usize> {
    with_db(&state, |conn| repo::delete(conn, &id))
}

/// Saves the launcher order after a drag.
#[tauri::command]
pub fn reorder_shell_profiles(ids: Vec<String>, state: State<'_, DbState>) -> AppResult<()> {
    with_db(&state, |conn| repo::reorder(conn, &ids))
}

/// The one-time copy of the profiles build 68 and earlier kept in localStorage.
/// Safe to call more than once; only the first call on a database does anything.
#[tauri::command]
pub fn import_legacy_shell_profiles(
    profiles: Vec<NewShellProfile>,
    state: State<'_, DbState>,
) -> AppResult<LegacyImport> {
    with_db(&state, |conn| repo::import_legacy(conn, &profiles))
}

/// Writes profiles to a file the operator chose. Returns how many.
///
/// `ids` is the subset to write, for the Hosts tab's "export this one" and
/// "export the ticked ones"; without it, every profile, which is what the
/// launcher's Export does.
#[tauri::command]
pub fn export_shell_profiles(
    path: String,
    ids: Option<Vec<String>>,
    state: State<'_, DbState>,
) -> AppResult<usize> {
    let (json, count) = with_db(&state, |conn| repo::export_json(conn, ids.as_deref()))?;
    std::fs::write(&path, json)?;
    Ok(count)
}

/// Reads an export file for the import preview. Writes nothing: the operator
/// sees every profile, startup command included, before anything is saved.
#[tauri::command]
pub fn read_shell_profile_file(
    path: String,
    state: State<'_, DbState>,
) -> AppResult<Vec<ShellProfileInput>> {
    let text = repo::read_file_text(&path)?;
    with_db(&state, |conn| repo::parse_file(conn, &text))
}

/// Saves the profiles the operator confirmed in the import preview, after the
/// ones already there. All or nothing.
#[tauri::command]
pub fn import_shell_profiles(
    profiles: Vec<NewShellProfile>,
    state: State<'_, DbState>,
) -> AppResult<usize> {
    with_db(&state, |conn| repo::import_many(conn, &profiles))
}
