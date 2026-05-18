use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub mod hosts;

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

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    bootstrap(&conn)?;
    Ok(conn)
}

fn bootstrap(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS hosts (
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
);
"#;
