use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub mod host_keys;
pub mod hosts;
pub mod settings;

pub struct DbState(pub Mutex<Connection>);

pub fn init(app: &AppHandle) -> AppResult<DbState> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::State(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("omniterminal.db");
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
];

fn bootstrap(conn: &Connection) -> AppResult<()> {
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
