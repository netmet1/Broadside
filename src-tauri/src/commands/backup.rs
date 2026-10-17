//! Application backup (work-queue 2026-06-12): snapshot the SQLite database
//! (hosts, settings, host keys, command history) into a user-chosen folder,
//! optionally alongside a re-importable hosts CSV (reuses the export module).
//!
//! Credentials are deliberately NOT included; they live in Windows
//! Credential Manager / the age-encrypted store (D-008), and copying secrets
//! into ad-hoc backup folders would undo that protection.

use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;
use tauri::State;

use super::ssh::with_db;
use crate::db::{hosts as host_repo, DbState};
use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct BackupReport {
    pub db_path: String,
    pub csv_path: Option<String>,
    pub host_count: usize,
}

#[derive(Serialize)]
pub struct RestoreReport {
    pub host_count: usize,
    /// Shell profiles whose startup command the restore emptied. The profiles
    /// themselves come back; see [`crate::db::restore`].
    pub cleared_startup_commands: usize,
    /// Shell profiles that named a custom terminal. Custom terminals are never
    /// restored, so each such profile was re-pointed at nothing and needs its
    /// shell picking again. Each one keeps the name of the terminal it wanted,
    /// so the launcher can say which shell to re-add.
    pub orphaned_custom_profiles: usize,
}

/// Online snapshot of the live database via `VACUUM INTO`, safe while the
/// app holds the connection, and the output is a compacted, consistent copy.
pub(crate) fn snapshot_db(conn: &rusqlite::Connection, dest: &Path) -> AppResult<()> {
    if dest.exists() {
        return Err(AppError::InvalidInput(format!(
            "backup target already exists: {}",
            dest.display()
        )));
    }
    let dest_str = dest
        .to_str()
        .ok_or_else(|| AppError::InvalidInput("backup path is not valid UTF-8".into()))?;
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])?;
    Ok(())
}

#[tauri::command]
pub fn backup_app_data(
    dir: String,
    include_hosts_csv: bool,
    state: State<'_, DbState>,
) -> AppResult<BackupReport> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "not a folder: {}",
            dir.display()
        )));
    }
    // Datetime first in the filename (S4), e.g. 20260613-101715-broadside-backup.db.
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let db_dest = dir.join(format!("{stamp}-broadside-backup.db"));

    let (hosts, ()) = with_db(&state, |conn| {
        let hosts = host_repo::list_all(conn)?;
        snapshot_db(conn, &db_dest)?;
        Ok((hosts, ()))
    })?;

    let csv_path = if include_hosts_csv {
        let csv_dest = dir.join(format!("{stamp}-broadside-hosts.csv"));
        crate::export::write_hosts_csv(&hosts, &csv_dest)?;
        Some(csv_dest.display().to_string())
    } else {
        None
    };

    Ok(BackupReport {
        db_path: db_dest.display().to_string(),
        csv_path,
        host_count: hosts.len(),
    })
}

/// Restores a backup `.db` into the live database. This OVERWRITES hosts,
/// history, skills, templates, shell profiles and preferences with the
/// snapshot's contents. Credentials are untouched: they live in Windows
/// Credential Manager, not the DB, so a restored host may need its password
/// re-entered.
///
/// The file is imported row by row inside one transaction, never copied over
/// the live database, and some of it is never read at all: launcher entries,
/// trusted host keys, startup commands and the security settings stay as they
/// are on this machine. See [`crate::db::restore`] for what and why. No app
/// restart is required.
#[tauri::command]
pub fn restore_app_data(path: String, state: State<'_, DbState>) -> AppResult<RestoreReport> {
    let src_path = PathBuf::from(&path);
    if !src_path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "not a file: {}",
            src_path.display()
        )));
    }

    // Staged before the lock is taken: copying and migrating the file needs
    // nothing from the live database, and every other command waits on it.
    let staged = crate::db::restore::stage(&src_path)?;
    let guard = state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))?;
    let restored = crate::db::restore::import(&guard, &staged)?;
    Ok(RestoreReport {
        host_count: restored.host_count,
        cleared_startup_commands: restored.cleared_startup_commands,
        orphaned_custom_profiles: restored.orphaned_custom_profiles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::hosts::HostInput;
    use crate::db::open_in_memory;

    #[test]
    fn snapshot_produces_openable_copy_with_data() {
        let conn = open_in_memory().unwrap();
        host_repo::create(
            &conn,
            HostInput {
                label: "web-01".into(),
                hostname: "10.0.0.1".into(),
                port: 22,
                username: "ops".into(),
                color: "#3b82f6".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("backup.db");
        snapshot_db(&conn, &dest).unwrap();

        let copy = rusqlite::Connection::open(&dest).unwrap();
        let hosts = host_repo::list_all(&copy).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "web-01");
    }

    #[test]
    fn snapshot_refuses_existing_target() {
        let conn = open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("backup.db");
        std::fs::write(&dest, b"do not clobber").unwrap();
        let err = snapshot_db(&conn, &dest).unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }
}
