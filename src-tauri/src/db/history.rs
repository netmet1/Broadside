use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::error::AppResult;

/// Keep the table bounded — operators don't need infinite history and the
/// viewer tails anyway.
const MAX_ROWS: i64 = 5000;

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub command: String,
    pub host_count: i64,
    pub ts: String,
}

fn from_row(row: &Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        command: row.get(1)?,
        host_count: row.get(2)?,
        ts: row.get(3)?,
    })
}

/// Records a broadcast command. Consecutive duplicates collapse (re-running
/// the same command updates its timestamp instead of stacking rows).
pub fn add(conn: &Connection, command: &str, host_count: usize) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let last: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, command FROM command_history ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((id, last_cmd)) = last {
        if last_cmd == command {
            conn.execute(
                "UPDATE command_history SET ts = ?1, host_count = ?2 WHERE id = ?3",
                params![now, host_count as i64, id],
            )?;
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO command_history (command, host_count, ts) VALUES (?1, ?2, ?3)",
        params![command, host_count as i64, now],
    )?;
    conn.execute(
        "DELETE FROM command_history WHERE id <= (
            SELECT id FROM command_history ORDER BY id DESC LIMIT 1 OFFSET ?1
         )",
        params![MAX_ROWS],
    )?;
    Ok(())
}

/// Newest first.
pub fn recent(conn: &Connection, limit: usize) -> AppResult<Vec<HistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, command, host_count, ts FROM command_history
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn clear(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM command_history", [])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn add_and_recent_round_trip() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", 3).unwrap();
        add(&conn, "df -h", 5).unwrap();
        let entries = recent(&conn, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "df -h");
        assert_eq!(entries[0].host_count, 5);
        assert_eq!(entries[1].command, "uptime");
    }

    #[test]
    fn consecutive_duplicates_collapse() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", 3).unwrap();
        add(&conn, "uptime", 4).unwrap();
        let entries = recent(&conn, 10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host_count, 4);
    }

    #[test]
    fn non_consecutive_duplicates_kept() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", 1).unwrap();
        add(&conn, "df -h", 1).unwrap();
        add(&conn, "uptime", 1).unwrap();
        assert_eq!(recent(&conn, 10).unwrap().len(), 3);
    }

    #[test]
    fn clear_empties() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", 1).unwrap();
        clear(&conn).unwrap();
        assert!(recent(&conn, 10).unwrap().is_empty());
    }
}
