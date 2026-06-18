use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Keep the table bounded — operators don't need infinite history and the
/// viewer tails anyway.
const MAX_ROWS: i64 = 5000;

/// A host a command targeted, recorded for colour-tinting in the history view
/// (D-061 sub-4). `id` resolves the host's *current* colour/label live at
/// render time; `label` is the snapshot fallback for when the host is gone.
/// `id` is `None` for sources that don't track it yet (PTY broadcast).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryHost {
    pub id: Option<i64>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub command: String,
    pub host_count: i64,
    pub ts: String,
    /// Target hosts for tinting (empty for rows predating D-061 sub-4).
    pub hosts: Vec<HistoryHost>,
    /// "broadcast" | "ptybroadcast" | "multiterminal" (None for old rows).
    pub source: Option<String>,
}

fn from_row(row: &Row) -> rusqlite::Result<HistoryEntry> {
    let hosts_json: Option<String> = row.get(4)?;
    let hosts = hosts_json
        .and_then(|j| serde_json::from_str::<Vec<HistoryHost>>(&j).ok())
        .unwrap_or_default();
    Ok(HistoryEntry {
        id: row.get(0)?,
        command: row.get(1)?,
        host_count: row.get(2)?,
        ts: row.get(3)?,
        hosts,
        source: row.get(5)?,
    })
}

/// Records a command run. `hosts` are the targets (for tinting) and `source`
/// is "broadcast" | "ptybroadcast" | "multiterminal". Consecutive duplicates of
/// the same command collapse (timestamp/targets/source updated, not stacked).
pub fn add(
    conn: &Connection,
    command: &str,
    hosts: &[HistoryHost],
    source: &str,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let hosts_json = serde_json::to_string(hosts).unwrap_or_else(|_| "[]".into());
    let host_count = hosts.len() as i64;
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
                "UPDATE command_history
                   SET ts = ?1, host_count = ?2, hosts_json = ?3, source = ?4
                 WHERE id = ?5",
                params![now, host_count, hosts_json, source, id],
            )?;
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO command_history (command, host_count, ts, hosts_json, source)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![command, host_count, now, hosts_json, source],
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
        "SELECT id, command, host_count, ts, hosts_json, source FROM command_history
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

    /// `n` hosts with ids 1..=n.
    fn hosts(n: i64) -> Vec<HistoryHost> {
        (1..=n)
            .map(|id| HistoryHost {
                id: Some(id),
                label: format!("host{id}"),
            })
            .collect()
    }

    #[test]
    fn add_and_recent_round_trip() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", &hosts(3), "broadcast").unwrap();
        add(&conn, "df -h", &hosts(5), "multiterminal").unwrap();
        let entries = recent(&conn, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "df -h");
        assert_eq!(entries[0].host_count, 5);
        assert_eq!(entries[0].hosts.len(), 5);
        assert_eq!(entries[0].source.as_deref(), Some("multiterminal"));
        assert_eq!(entries[0].hosts[0].label, "host1");
        assert_eq!(entries[1].command, "uptime");
    }

    #[test]
    fn host_id_optional_for_pty_source() {
        let conn = open_in_memory().unwrap();
        let h = vec![HistoryHost {
            id: None,
            label: "alpha".into(),
        }];
        add(&conn, "ls", &h, "ptybroadcast").unwrap();
        let entries = recent(&conn, 10).unwrap();
        assert_eq!(entries[0].hosts[0].id, None);
        assert_eq!(entries[0].hosts[0].label, "alpha");
        assert_eq!(entries[0].source.as_deref(), Some("ptybroadcast"));
    }

    #[test]
    fn consecutive_duplicates_collapse() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", &hosts(3), "broadcast").unwrap();
        add(&conn, "uptime", &hosts(4), "multiterminal").unwrap();
        let entries = recent(&conn, 10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host_count, 4);
        assert_eq!(entries[0].source.as_deref(), Some("multiterminal"));
    }

    #[test]
    fn non_consecutive_duplicates_kept() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", &hosts(1), "broadcast").unwrap();
        add(&conn, "df -h", &hosts(1), "broadcast").unwrap();
        add(&conn, "uptime", &hosts(1), "broadcast").unwrap();
        assert_eq!(recent(&conn, 10).unwrap().len(), 3);
    }

    #[test]
    fn clear_empties() {
        let conn = open_in_memory().unwrap();
        add(&conn, "uptime", &hosts(1), "broadcast").unwrap();
        clear(&conn).unwrap();
        assert!(recent(&conn, 10).unwrap().is_empty());
    }
}
