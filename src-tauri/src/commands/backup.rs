//! Application backup (work-queue 2026-06-12): snapshot the SQLite database
//! (hosts, settings, host keys, command history) into a user-chosen folder,
//! optionally alongside a re-importable hosts CSV (reuses the export module).
//!
//! Credentials are deliberately NOT included; they live in Windows
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
    /// Launcher entries the restore refused to carry over. See
    /// [`restore_app_data`] for why none of them survive.
    pub dropped_terminals: usize,
    /// Trusted host keys the restore cleared, so the next connect to each host
    /// asks again.
    pub cleared_host_keys: usize,
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

/// Restores a backup `.db` over the live database using SQLite's online backup
/// API. This OVERWRITES all current data (hosts, settings, trusted host keys,
/// command history) with the snapshot's contents. Credentials are untouched:
/// they live in Windows Credential Manager, not the DB, so a restored host may
/// need its password re-entered (same as after the rename).
///
/// The online backup API copies into the live `main` database while we hold the
/// connection lock, so there is no file swap and no Windows file-lock problem
/// with the open connection, and no app restart is required.
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
    // up to the current schema before the app reads from it again. Ahead of the
    // sweep below, which needs the tables to exist whatever version the file is.
    crate::db::bootstrap(&guard)?;

    // SECURITY: everything above this line trusted a file the operator was
    // handed. A `.db` looks like data, carries no mark of the web, and gets none
    // of the friction an `.exe` would, so "restore the team's backup" is a
    // plausible thing to be talked into. Most of what it brings back is data at
    // the point of use: hosts, settings (the operator's own guard rules
    // included), history. Two tables are not.
    //
    // `custom_terminals` names a program to spawn. The module that owns it
    // trusts a stored row at launch precisely because it could not have been
    // stored without passing its `validate` (see db/custom_terminals.rs), and
    // this command is the writer that makes that untrue. No validation can put
    // it back, either: a hostile row is shaped exactly like a legitimate one,
    // since `powershell.exe` with arguments is what several real entries are, so
    // a row reading "PowerShell 7" that quietly carries `-w hidden -c <payload>`
    // passes every check the form applies. The honest answer is that launcher
    // entries do not survive a restore. Re-adding them is one visit to a form,
    // for a list most operators never populate at all, and it puts the decision
    // to run a program back in front of the person whose machine it is.
    //
    // `host_keys` is the record of which key the operator agreed to trust for
    // which host. Carried over from a file somebody else made, it pre-trusts
    // that person's keys, and the TOFU and key-mismatch dialogs then never fire
    // for those hosts again: the one warning that would say "this is not the
    // machine you think it is" has been answered in advance by the file. Cleared
    // instead, so the first connect asks. That is one dialog per host, once,
    // which is the question those dialogs exist to ask.
    let dropped_terminals = guard.execute("DELETE FROM custom_terminals", [])?;
    let cleared_host_keys = guard.execute("DELETE FROM host_keys", [])?;

    let host_count = host_repo::list_all(&guard)?.len();
    Ok(RestoreReport {
        host_count,
        dropped_terminals,
        cleared_host_keys,
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

    /// The two tables a restore must not carry over, because in each of them a
    /// row is a decision the operator never made: a program to spawn, and a host
    /// key already agreed to. A backup `.db` is a file somebody can be talked
    /// into opening, so what it can plant has to stop at data.
    #[test]
    fn a_restored_file_cannot_plant_a_launcher_entry_or_a_trusted_key() {
        // A snapshot carrying both, plus an ordinary host to prove the sweep is
        // narrow and the restore still does its job.
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
        // Shaped exactly like a legitimate entry, which is the point: every check
        // the form applies passes, so the sweep cannot be a validation.
        src.execute(
            "INSERT INTO custom_terminals
                 (label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES ('PowerShell 7',
                     'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                     '[\"-nop\",\"-w\",\"hidden\",\"-c\",\"whoami\"]',
                     'powershell', 0, 'then', 'then')",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO host_keys
                 (hostname, port, key_type, public_key, fingerprint_sha256, first_seen, last_seen)
             VALUES ('10.0.0.9', 22, 'ssh-ed25519', 'AAAA…', 'SHA256:not-the-real-host', 'then', 'then')",
            [],
        )
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let snap = dir.path().join("backup.db");
        snapshot_db(&src, &snap).unwrap();

        let mut live = open_in_memory().unwrap();
        let from = rusqlite::Connection::open(&snap).unwrap();
        {
            let backup = rusqlite::backup::Backup::new(&from, &mut live).unwrap();
            backup
                .run_to_completion(64, std::time::Duration::from_millis(0), None)
                .unwrap();
        }
        crate::db::bootstrap(&live).unwrap();

        // The sweep, as `restore_app_data` runs it.
        let dropped = live.execute("DELETE FROM custom_terminals", []).unwrap();
        let cleared = live.execute("DELETE FROM host_keys", []).unwrap();
        assert_eq!(dropped, 1, "the launcher entry is not carried over");
        assert_eq!(cleared, 1, "the trusted key is not carried over");

        assert!(
            crate::db::custom_terminals::list(&live).unwrap().is_empty(),
            "nothing the file named is left to launch"
        );
        let keys: i64 = live
            .query_row("SELECT COUNT(*) FROM host_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(keys, 0, "the next connect asks about the host itself");

        // And the part a backup is actually for came through untouched.
        let hosts = host_repo::list_all(&live).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "from-backup");
    }
}
