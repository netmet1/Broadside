use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub mod broadcast_history;
pub mod history;
pub mod host_keys;
pub mod hosts;
pub mod omni_history;
pub mod pty_history;
pub mod settings;
pub mod skills;

pub struct DbState(pub Mutex<Connection>);

pub fn init(app: &AppHandle) -> AppResult<DbState> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::State(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("broadside.db");
    let conn = Connection::open(&db_path)?;
    bootstrap(&conn)?;
    Ok(DbState(Mutex::new(conn)))
}

pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    bootstrap(&conn)?;
    Ok(conn)
}

/// Sequential migrations driven by PRAGMA user_version. Each entry runs at
/// most once per database; user_version records how many have been applied.
/// Append only — never reorder or edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    // 1: initial hosts table
    "CREATE TABLE IF NOT EXISTS hosts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        label         TEXT NOT NULL UNIQUE,
        hostname      TEXT NOT NULL,
        port          INTEGER NOT NULL DEFAULT 22,
        username      TEXT NOT NULL,
        color         TEXT NOT NULL,
        linux_flavor  TEXT,
        notes         TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );",
    // 2: credential metadata on hosts (PR#2). Guarded for databases that
    // predate the migration runner and already ran add_column_if_missing.
    "SELECT 1;",
    // 3: trusted server keys, keyed by network endpoint (TOFU, D-033)
    "CREATE TABLE IF NOT EXISTS host_keys (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname            TEXT NOT NULL,
        port                INTEGER NOT NULL,
        key_type            TEXT NOT NULL,
        public_key          TEXT NOT NULL,
        fingerprint_sha256  TEXT NOT NULL,
        first_seen          TEXT NOT NULL,
        last_seen           TEXT NOT NULL,
        UNIQUE (hostname, port, key_type)
    );",
    // 4: sudo password presence flag (PR#4, D-026). The secret itself lives
    // in the credential store; this flag only drives UI affordances.
    "ALTER TABLE hosts ADD COLUMN has_sudo_password INTEGER NOT NULL DEFAULT 0;",
    // 5: app settings key-value store (PR#7; first consumer: audit_enabled)
    "CREATE TABLE IF NOT EXISTS settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );",
    // 6: broadcast command history (PR#8; D-015 search surface)
    "CREATE TABLE IF NOT EXISTS command_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        command     TEXT NOT NULL,
        host_count  INTEGER NOT NULL,
        ts          TEXT NOT NULL
    );",
    // 7: persistent broadcast RESULT history (2026-06-13 work queue, D-059).
    // One row per host-result; rows of a run share run_id/ts/command. `result`
    // is the ExecResult serialized as JSON so the frontend renders it the same
    // as a live result block.
    "CREATE TABLE IF NOT EXISTS broadcast_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL,
        ts        TEXT NOT NULL,
        command   TEXT NOT NULL,
        host_id   INTEGER NOT NULL,
        label     TEXT NOT NULL,
        color     TEXT NOT NULL,
        result    TEXT NOT NULL
    );",
    // 8: persistent PTY-broadcast DISPATCH history (D-059). Records which
    // command was typed into which sessions and whether the write dispatched;
    // the actual output lives in the terminal tabs, not here.
    "CREATE TABLE IF NOT EXISTS pty_dispatch_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL,
        ts        TEXT NOT NULL,
        command   TEXT NOT NULL,
        label     TEXT NOT NULL,
        color     TEXT NOT NULL,
        ok        INTEGER NOT NULL,
        message   TEXT
    );",
    // 9: command_history host references + source (D-061 sub-4). hosts_json is
    // a JSON array of {id, label}; id is null for sources that don't track it
    // yet (PTY broadcast until a later PR). source is one of
    // "broadcast" | "ptybroadcast" | "multiterminal". Rows predating this stay
    // NULL on both and render by host_count only.
    "ALTER TABLE command_history ADD COLUMN hosts_json TEXT;
     ALTER TABLE command_history ADD COLUMN source TEXT;",
    // 10: PTY-broadcast dispatch host_id (D-061 sub-4) so its results tint by
    // the host's *live* colour, like broadcast_results already does. Nullable —
    // rows predating this fall back to the stored colour snapshot.
    "ALTER TABLE pty_dispatch_results ADD COLUMN host_id INTEGER;",
    // 11: persistent MultiTerminal block log (D-061 follow-up) so the aggregate
    // view survives restarts (it otherwise lived only in frontend memory). One
    // row per displayed block; host_id resolves the live colour, label is the
    // snapshot fallback, lines is a JSON array.
    "CREATE TABLE IF NOT EXISTS omni_blocks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            TEXT NOT NULL,
        host_id       INTEGER,
        label         TEXT NOT NULL,
        command       TEXT,
        lines         TEXT NOT NULL,
        exit_code     INTEGER,
        duration_ms   INTEGER,
        interactivity TEXT NOT NULL
    );",
    // 12: host grouping tag (user request) — optional free-text label for
    // grouping/sorting hosts in the table; autocompleted in the form from tags
    // already in use. Surfaces before linux_flavor in the UI.
    "ALTER TABLE hosts ADD COLUMN tag TEXT;",
    // 13: skills. Reusable multi-step operations driven over a live PTY per
    // host (skills-feature-plan, Phase 1). `config_json` is the kind-specific
    // blob (steps + declared params); it can hold command text, so it shares
    // the at-rest exposure class of command_history (D-011). No secrets ever
    // live here; the credential store owns those.
    "CREATE TABLE IF NOT EXISTS skills (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        icon         TEXT,
        kind         TEXT NOT NULL,
        config_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );",
    // 14: the host's detected login shell (X4). Written by the backend after a
    // successful connect, never by the host form, so the Hosts table can warn
    // that a non-POSIX shell (fish, csh) gets no command-block tracking and
    // can't run skills. NULL means "not probed yet", not "unsupported".
    "ALTER TABLE hosts ADD COLUMN login_shell TEXT;",
];

pub(crate) fn bootstrap(conn: &Connection) -> AppResult<()> {
    let version: i64 =
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        let target = (idx + 1) as i64;
        if version < target {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", target)?;
        }
    }
    // Idempotent column adds predating the migration runner (PR#2 databases
    // have these columns but user_version 0, fresh databases need them).
    add_column_if_missing(conn, "hosts", "auth_method", "TEXT")?;
    add_column_if_missing(conn, "hosts", "key_path", "TEXT")?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    type_def: &str,
) -> AppResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {type_def}"),
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brings a fresh connection up to `version` the way a shipped database
    /// would have got there, so an upgrade can be exercised from that point.
    fn database_at_version(version: usize) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(version) {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", version as i64)
            .unwrap();
        conn
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_existing_database_gains_skills_without_losing_data() {
        // The upgrade path every real installation takes. The unit tests all
        // start from a fresh schema, so this is the only place the *migration*
        // (rather than the final shape) is exercised.
        let conn = database_at_version(12);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        // The new table works…
        skills::create(
            &conn,
            &skills::SkillInput {
                name: "after upgrade".into(),
                description: String::new(),
                icon: None,
                kind: skills::KIND_SEQUENCE.into(),
                config_json: "{}".into(),
            },
        )
        .unwrap();
        assert_eq!(skills::list(&conn).unwrap().len(), 1);
        // …and the row that was already there is untouched.
        let label: String = conn
            .query_row("SELECT label FROM hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(label, "web01");
    }

    #[test]
    fn an_existing_database_gains_login_shell_without_losing_hosts() {
        // Migration 14 (X4). Same shape as the skills upgrade above: the column
        // lands on a database that already has host rows, and they survive.
        let conn = database_at_version(13);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let host = &hosts::list_all(&conn).unwrap()[0];
        assert_eq!(host.label, "web01");
        // Not probed yet: absent, which must not read as "unsupported".
        assert_eq!(host.login_shell, None);

        hosts::set_login_shell(&conn, host.id, "fish").unwrap();
        let host = hosts::get(&conn, host.id).unwrap();
        assert_eq!(host.login_shell.as_deref(), Some("fish"));
    }

    #[test]
    fn bootstrap_is_idempotent() {
        // Every launch runs it; a second pass must not re-run a migration.
        let conn = open_in_memory().unwrap();
        let version = user_version(&conn);
        bootstrap(&conn).unwrap();
        bootstrap(&conn).unwrap();
        assert_eq!(user_version(&conn), version);
    }

    #[test]
    fn a_fresh_database_lands_on_the_latest_version() {
        let conn = open_in_memory().unwrap();
        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
    }
}
