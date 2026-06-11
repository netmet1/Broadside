use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    Ok(stmt.query_row(params![key], |row| row.get(0)).optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_bool(conn: &Connection, key: &str, default: bool) -> AppResult<bool> {
    Ok(match get(conn, key)?.as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn get_missing_returns_none() {
        let conn = open_in_memory().unwrap();
        assert_eq!(get(&conn, "nope").unwrap(), None);
    }

    #[test]
    fn set_and_get_round_trip() {
        let conn = open_in_memory().unwrap();
        set(&conn, "k", "v1").unwrap();
        assert_eq!(get(&conn, "k").unwrap().as_deref(), Some("v1"));
        set(&conn, "k", "v2").unwrap();
        assert_eq!(get(&conn, "k").unwrap().as_deref(), Some("v2"));
    }

    #[test]
    fn get_bool_defaults_and_parses() {
        let conn = open_in_memory().unwrap();
        assert!(get_bool(&conn, "audit_enabled", true).unwrap());
        set(&conn, "audit_enabled", "false").unwrap();
        assert!(!get_bool(&conn, "audit_enabled", true).unwrap());
        set(&conn, "audit_enabled", "true").unwrap();
        assert!(get_bool(&conn, "audit_enabled", false).unwrap());
    }
}
