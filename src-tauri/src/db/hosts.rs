use chrono::Utc;
use rusqlite::{ffi, params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

fn map_label_unique(label: &str, e: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(ref se, Some(ref msg)) = e {
        if se.extended_code == ffi::SQLITE_CONSTRAINT_UNIQUE
            && msg.contains("hosts.label")
        {
            return AppError::InvalidInput(format!(
                r#"A host with label "{}" already exists"#,
                label
            ));
        }
    }
    AppError::Db(e)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: i64,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub color: String,
    pub linux_flavor: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub auth_method: Option<String>,
    pub key_path: Option<String>,
    pub has_sudo_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HostInput {
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub color: String,
    pub linux_flavor: Option<String>,
    pub notes: Option<String>,
}

fn from_row(row: &Row) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get(0)?,
        label: row.get(1)?,
        hostname: row.get(2)?,
        port: row.get::<_, i64>(3)? as u16,
        username: row.get(4)?,
        color: row.get(5)?,
        linux_flavor: row.get(6)?,
        notes: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        auth_method: row.get(10)?,
        key_path: row.get(11)?,
        has_sudo_password: row.get::<_, i64>(12)? != 0,
    })
}

const SELECT_COLS: &str =
    "id, label, hostname, port, username, color, linux_flavor, notes, created_at, updated_at, auth_method, key_path, has_sudo_password";

fn validate(input: &HostInput) -> AppResult<()> {
    if input.label.trim().is_empty() {
        return Err(AppError::InvalidInput("label is required".into()));
    }
    if input.hostname.trim().is_empty() {
        return Err(AppError::InvalidInput("hostname is required".into()));
    }
    if input.username.trim().is_empty() {
        return Err(AppError::InvalidInput("username is required".into()));
    }
    if input.port == 0 {
        return Err(AppError::InvalidInput("port must be 1-65535".into()));
    }
    if !is_hex_color(&input.color) {
        return Err(AppError::InvalidInput(
            "color must be a hex string like #aabbcc".into(),
        ));
    }
    Ok(())
}

fn is_hex_color(s: &str) -> bool {
    if !s.starts_with('#') {
        return false;
    }
    let rest = &s[1..];
    matches!(rest.len(), 3 | 6) && rest.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<Host>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM hosts ORDER BY label COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Host> {
    let sql = format!("SELECT {SELECT_COLS} FROM hosts WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or(AppError::HostNotFound(id))
}

pub fn set_auth_method(
    conn: &Connection,
    id: i64,
    auth_method: Option<&str>,
    key_path: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE hosts SET auth_method = ?1, key_path = ?2, updated_at = ?3 WHERE id = ?4",
        params![auth_method, key_path, now, id],
    )?;
    if affected == 0 {
        return Err(AppError::HostNotFound(id));
    }
    Ok(())
}

pub fn set_has_sudo_password(conn: &Connection, id: i64, value: bool) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE hosts SET has_sudo_password = ?1, updated_at = ?2 WHERE id = ?3",
        params![value as i64, now, id],
    )?;
    if affected == 0 {
        return Err(AppError::HostNotFound(id));
    }
    Ok(())
}

pub fn create(conn: &Connection, input: HostInput) -> AppResult<Host> {
    validate(&input)?;
    let now = Utc::now().to_rfc3339();
    let label = input.label.trim();
    conn.execute(
        "INSERT INTO hosts (label, hostname, port, username, color, linux_flavor, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            label,
            input.hostname.trim(),
            input.port as i64,
            input.username.trim(),
            input.color,
            input.linux_flavor,
            input.notes,
            now,
        ],
    )
    .map_err(|e| map_label_unique(label, e))?;
    let id = conn.last_insert_rowid();
    get(conn, id)
}

pub fn update(conn: &Connection, id: i64, input: HostInput) -> AppResult<Host> {
    validate(&input)?;
    let now = Utc::now().to_rfc3339();
    let label = input.label.trim();
    let affected = conn
        .execute(
            "UPDATE hosts
            SET label = ?1, hostname = ?2, port = ?3, username = ?4, color = ?5,
                linux_flavor = ?6, notes = ?7, updated_at = ?8
          WHERE id = ?9",
            params![
                label,
                input.hostname.trim(),
                input.port as i64,
                input.username.trim(),
                input.color,
                input.linux_flavor,
                input.notes,
                now,
                id,
            ],
        )
        .map_err(|e| map_label_unique(label, e))?;
    if affected == 0 {
        return Err(AppError::HostNotFound(id));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    let affected = conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::HostNotFound(id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn sample() -> HostInput {
        HostInput {
            label: "web-01".into(),
            hostname: "web01.example.com".into(),
            port: 22,
            username: "root".into(),
            color: "#3366ff".into(),
            linux_flavor: Some("ubuntu".into()),
            notes: None,
        }
    }

    #[test]
    fn create_and_list_round_trip() {
        let conn = open_in_memory().unwrap();
        let created = create(&conn, sample()).unwrap();
        assert_eq!(created.label, "web-01");
        assert_eq!(created.port, 22);
        assert!(created.id > 0);

        let all = list_all(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
    }

    #[test]
    fn get_returns_host() {
        let conn = open_in_memory().unwrap();
        let created = create(&conn, sample()).unwrap();
        let fetched = get(&conn, created.id).unwrap();
        assert_eq!(fetched.label, created.label);
    }

    #[test]
    fn get_missing_returns_not_found() {
        let conn = open_in_memory().unwrap();
        let err = get(&conn, 9999).unwrap_err();
        assert!(matches!(err, AppError::HostNotFound(9999)));
    }

    #[test]
    fn update_changes_fields() {
        let conn = open_in_memory().unwrap();
        let created = create(&conn, sample()).unwrap();
        let mut input = sample();
        input.label = "web-01-renamed".into();
        input.port = 2222;
        let updated = update(&conn, created.id, input).unwrap();
        assert_eq!(updated.label, "web-01-renamed");
        assert_eq!(updated.port, 2222);
        assert!(updated.updated_at >= created.created_at);
    }

    #[test]
    fn update_missing_returns_not_found() {
        let conn = open_in_memory().unwrap();
        let err = update(&conn, 9999, sample()).unwrap_err();
        assert!(matches!(err, AppError::HostNotFound(9999)));
    }

    #[test]
    fn delete_removes_row() {
        let conn = open_in_memory().unwrap();
        let created = create(&conn, sample()).unwrap();
        delete(&conn, created.id).unwrap();
        let all = list_all(&conn).unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn delete_missing_returns_not_found() {
        let conn = open_in_memory().unwrap();
        let err = delete(&conn, 9999).unwrap_err();
        assert!(matches!(err, AppError::HostNotFound(9999)));
    }

    #[test]
    fn duplicate_label_rejected_with_friendly_message() {
        let conn = open_in_memory().unwrap();
        create(&conn, sample()).unwrap();
        let err = create(&conn, sample()).unwrap_err();
        match err {
            AppError::InvalidInput(msg) => {
                assert!(msg.contains("already exists"), "got: {msg}");
                assert!(msg.contains("web-01"), "got: {msg}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn rename_to_existing_label_rejected_with_friendly_message() {
        let conn = open_in_memory().unwrap();
        let a = create(&conn, sample()).unwrap();
        let mut other = sample();
        other.label = "web-02".into();
        let b = create(&conn, other).unwrap();
        let _ = a;
        // Try to rename b to a's label
        let mut conflict = sample();
        conflict.label = "web-01".into();
        let err = update(&conn, b.id, conflict).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(ref m) if m.contains("web-01")));
    }

    #[test]
    fn empty_label_rejected() {
        let conn = open_in_memory().unwrap();
        let mut input = sample();
        input.label = "   ".into();
        let err = create(&conn, input).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn empty_hostname_rejected() {
        let conn = open_in_memory().unwrap();
        let mut input = sample();
        input.hostname = "".into();
        let err = create(&conn, input).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn zero_port_rejected() {
        let conn = open_in_memory().unwrap();
        let mut input = sample();
        input.port = 0;
        let err = create(&conn, input).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn invalid_color_rejected() {
        let conn = open_in_memory().unwrap();
        let mut input = sample();
        input.color = "not-a-color".into();
        let err = create(&conn, input).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn short_hex_color_accepted() {
        let conn = open_in_memory().unwrap();
        let mut input = sample();
        input.color = "#abc".into();
        create(&conn, input).unwrap();
    }

    #[test]
    fn list_sorts_by_label_case_insensitive() {
        let conn = open_in_memory().unwrap();
        let mut a = sample();
        a.label = "Zeta".into();
        let mut b = sample();
        b.label = "alpha".into();
        let mut c = sample();
        c.label = "Mu".into();
        create(&conn, a).unwrap();
        create(&conn, b).unwrap();
        create(&conn, c).unwrap();
        let all = list_all(&conn).unwrap();
        let labels: Vec<_> = all.iter().map(|h| h.label.clone()).collect();
        assert_eq!(labels, vec!["alpha", "Mu", "Zeta"]);
    }
}
