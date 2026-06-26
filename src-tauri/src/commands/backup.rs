//! Application backup (work-queue 2026-06-12): snapshot the SQLite database
//! (hosts, settings, host keys, command history) into a user-chosen folder,
//! optionally alongside a re-importable hosts CSV (reuses the export module).
//!
//! Credentials are deliberately NOT included — they live in Windows
//! Credential Manager / the age-encrypted store (D-008), and copying secrets
//! into ad-hoc backup folders would undo that protection.

use std::path::{Path, PathBuf};

use chrono::Local;
use rusqlite::OptionalExtension;
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
}

/// Online snapshot of the live database via `VACUUM INTO` — safe while the
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

/// Restores a backup `.db` over the live database using SQLite's online backup
/// API. This OVERWRITES all current data (hosts, settings, trusted host keys,
/// command history) with the snapshot's contents. Credentials are untouched —
/// they live in Windows Credential Manager, not the DB, so a restored host may
/// need its password re-entered (same as after the rename).
///
/// The online backup API copies into the live `main` database while we hold the
/// connection lock, so there is no file swap and no Windows file-lock problem
/// with the open connection — and no app restart is required.
#[tauri::command]
pub fn restore_app_data(path: String, state: State<'_, DbState>) -> AppResult<RestoreReport> {
    let src_path = PathBuf::from(&path);
    if !src_path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "not a file: {}",
            src_path.display()
        )));
    }

    // Open the chosen file read-only and sanity-check it looks like a Broadside
    // backup before we overwrite anything live.
    let src = rusqlite::Connection::open_with_flags(
        &src_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| AppError::InvalidInput(format!("can't open backup file: {e}")))?;
    let looks_like_backup = src
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hosts'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !looks_like_backup {
        return Err(AppError::InvalidInput(
            "this file is not a Broadside backup (no hosts table found)".into(),
        ));
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))?;

    // Copy the snapshot's `main` database over the live one. The block scopes
    // the backup's mutable borrow of `guard` so we can read from it afterwards.
    {
        let backup = rusqlite::backup::Backup::new(&src, &mut *guard)?;
        backup.run_to_completion(64, std::time::Duration::from_millis(0), None)?;
    }

    // A backup taken by an older build may predate recent migrations; bring it
    // up to the current schema before the app reads from it again.
    crate::db::bootstrap(&guard)?;

    let host_count = host_repo::list_all(&guard)?.len();
    Ok(RestoreReport { host_count })
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

    /// Exercises the online-backup restore the command relies on: a snapshot's
    /// data replaces whatever the destination connection currently holds.
    #[test]
    fn restore_overwrites_live_data_from_snapshot() {
        // Source: one host "from-backup", snapshotted to a file.
        let src = open_in_memory().unwrap();
        host_repo::create(
            &src,
            HostInput {
                label: "from-backup".into(),
                hostname: "10.0.0.9".into(),
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
        let snap = dir.path().join("backup.db");
        snapshot_db(&src, &snap).unwrap();

        // Destination ("live"): different host that should be replaced.
        let mut live = open_in_memory().unwrap();
        host_repo::create(
            &live,
            HostInput {
                label: "current".into(),
                hostname: "192.168.1.1".into(),
                port: 22,
                username: "root".into(),
                color: "#ef4444".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap();

        // Restore the snapshot over the live DB (mirrors restore_app_data).
        let from = rusqlite::Connection::open(&snap).unwrap();
        {
            let backup = rusqlite::backup::Backup::new(&from, &mut live).unwrap();
            backup
                .run_to_completion(64, std::time::Duration::from_millis(0), None)
                .unwrap();
        }

        let hosts = host_repo::list_all(&live).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "from-backup");
    }
}
