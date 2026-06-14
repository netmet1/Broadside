//! Persistent OmniTerminal block log (D-061 follow-up). The aggregate view
//! appends every displayed block here and reloads them on mount, so the log
//! survives app restarts (it otherwise lived only in frontend memory).
//!
//! `host_id` resolves the host's live colour at render time; `label` is the
//! snapshot fallback. `lines` is the output stored as a JSON array.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Keep the log bounded — oldest blocks drop off the bottom.
const MAX_BLOCKS: i64 = 1000;

#[derive(Debug, Clone, Deserialize)]
pub struct OmniBlockInput {
    pub ts: String,
    pub host_id: Option<i64>,
    pub label: String,
    pub command: Option<String>,
    pub lines: Vec<String>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub interactivity: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredOmniBlock {
    pub id: i64,
    pub ts: String,
    pub host_id: Option<i64>,
    pub label: String,
    pub command: Option<String>,
    pub lines: Vec<String>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub interactivity: String,
}

/// Appends one displayed block, then prunes to the most recent MAX_BLOCKS.
pub fn add(conn: &Connection, b: &OmniBlockInput) -> AppResult<()> {
    let lines_json = serde_json::to_string(&b.lines).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO omni_blocks
           (ts, host_id, label, command, lines, exit_code, duration_ms, interactivity)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            b.ts,
            b.host_id,
            b.label,
            b.command,
            lines_json,
            b.exit_code,
            b.duration_ms,
            b.interactivity
        ],
    )?;
    conn.execute(
        "DELETE FROM omni_blocks WHERE id <= (
            SELECT id FROM omni_blocks ORDER BY id DESC LIMIT 1 OFFSET ?1
         )",
        params![MAX_BLOCKS],
    )?;
    Ok(())
}

/// The most recent `limit` blocks, oldest-first (so the UI appends them with
/// the newest at the bottom, matching live arrival order).
pub fn list(conn: &Connection, limit: usize) -> AppResult<Vec<StoredOmniBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, ts, host_id, label, command, lines, exit_code, duration_ms, interactivity
         FROM omni_blocks
         WHERE id IN (SELECT id FROM omni_blocks ORDER BY id DESC LIMIT ?1)
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        let lines_json: String = row.get(5)?;
        Ok(StoredOmniBlock {
            id: row.get(0)?,
            ts: row.get(1)?,
            host_id: row.get(2)?,
            label: row.get(3)?,
            command: row.get(4)?,
            lines: serde_json::from_str(&lines_json).unwrap_or_default(),
            exit_code: row.get(6)?,
            duration_ms: row.get(7)?,
            interactivity: row.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn clear(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM omni_blocks", [])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn block(label: &str, cmd: &str) -> OmniBlockInput {
        OmniBlockInput {
            ts: "2026-06-14T00:00:00Z".into(),
            host_id: Some(1),
            label: label.into(),
            command: Some(cmd.into()),
            lines: vec!["line one".into(), "line two".into()],
            exit_code: Some(0),
            duration_ms: Some(42),
            interactivity: "normal".into(),
        }
    }

    #[test]
    fn add_and_list_oldest_first() {
        let conn = open_in_memory().unwrap();
        add(&conn, &block("a", "uptime")).unwrap();
        add(&conn, &block("b", "df -h")).unwrap();
        let blocks = list(&conn, 50).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].command.as_deref(), Some("uptime"));
        assert_eq!(blocks[0].lines, vec!["line one", "line two"]);
        assert_eq!(blocks[1].command.as_deref(), Some("df -h"));
    }

    #[test]
    fn prunes_to_max() {
        let conn = open_in_memory().unwrap();
        for i in 0..(MAX_BLOCKS + 5) {
            add(&conn, &block(&format!("h{i}"), "c")).unwrap();
        }
        let blocks = list(&conn, (MAX_BLOCKS + 100) as usize).unwrap();
        assert_eq!(blocks.len() as i64, MAX_BLOCKS);
    }

    #[test]
    fn clear_empties() {
        let conn = open_in_memory().unwrap();
        add(&conn, &block("a", "c")).unwrap();
        clear(&conn).unwrap();
        assert!(list(&conn, 50).unwrap().is_empty());
    }
}
