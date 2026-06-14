//! Persistent PTY-broadcast dispatch history (D-059). Mirrors
//! `broadcast_history` but records dispatch outcomes (sent / failed) rather
//! than command output — PTY output lives in the terminal tabs.
//!
//! One row per session-target; rows of a run share run_id/ts/command.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::AppResult;

const MAX_RUNS: i64 = 200;

/// One session-target's dispatch outcome, as stored/replayed.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DispatchInput {
    /// Host id for live colour resolution (D-061 sub-4); None for old clients.
    #[serde(default)]
    pub host_id: Option<i64>,
    pub label: String,
    pub color: String,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredDispatch {
    pub host_id: Option<i64>,
    pub label: String,
    pub color: String,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredPtyRun {
    pub run_id: String,
    pub ts: String,
    pub command: String,
    pub results: Vec<StoredDispatch>,
}

/// Appends one dispatch run, then prunes to the most recent MAX_RUNS runs.
pub fn add_run(
    conn: &Connection,
    run_id: &str,
    ts: &str,
    command: &str,
    results: &[DispatchInput],
) -> AppResult<()> {
    for r in results {
        conn.execute(
            "INSERT INTO pty_dispatch_results
               (run_id, ts, command, host_id, label, color, ok, message)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![run_id, ts, command, r.host_id, r.label, r.color, r.ok as i64, r.message],
        )?;
    }
    conn.execute(
        "DELETE FROM pty_dispatch_results WHERE run_id NOT IN (
            SELECT run_id FROM pty_dispatch_results
            GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?1
         )",
        params![MAX_RUNS],
    )?;
    Ok(())
}

/// Most recent `max_runs` runs, oldest-first.
pub fn list(conn: &Connection, max_runs: usize) -> AppResult<Vec<StoredPtyRun>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, ts, command, host_id, label, color, ok, message
         FROM pty_dispatch_results
         WHERE run_id IN (
            SELECT run_id FROM pty_dispatch_results
            GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?1
         )
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![max_runs as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, i64>(6)? != 0,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;

    let mut runs: Vec<StoredPtyRun> = Vec::new();
    for r in rows {
        let (run_id, ts, command, host_id, label, color, ok, message) = r?;
        let d = StoredDispatch {
            host_id,
            label,
            color,
            ok,
            message,
        };
        match runs.last_mut() {
            Some(last) if last.run_id == run_id => last.results.push(d),
            _ => runs.push(StoredPtyRun {
                run_id,
                ts,
                command,
                results: vec![d],
            }),
        }
    }
    Ok(runs)
}

pub fn clear(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM pty_dispatch_results", [])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn ok(label: &str) -> DispatchInput {
        DispatchInput {
            host_id: Some(1),
            label: label.into(),
            color: "#3b82f6".into(),
            ok: true,
            message: None,
        }
    }

    #[test]
    fn add_and_list_groups_oldest_first() {
        let conn = open_in_memory().unwrap();
        add_run(&conn, "r1", "t1", "uptime", &[ok("a"), ok("b")]).unwrap();
        add_run(
            &conn,
            "r2",
            "t2",
            "ls",
            &[DispatchInput {
                host_id: Some(2),
                label: "c".into(),
                color: "#f00".into(),
                ok: false,
                message: Some("not connected".into()),
            }],
        )
        .unwrap();
        let runs = list(&conn, 50).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, "r1");
        assert_eq!(runs[0].results.len(), 2);
        assert_eq!(runs[1].results[0].ok, false);
        assert_eq!(runs[1].results[0].message.as_deref(), Some("not connected"));
    }

    #[test]
    fn prunes_to_max_runs() {
        let conn = open_in_memory().unwrap();
        for i in 0..(MAX_RUNS + 3) {
            add_run(&conn, &format!("r{i}"), "t", "c", &[ok("a")]).unwrap();
        }
        let runs = list(&conn, (MAX_RUNS + 100) as usize).unwrap();
        assert_eq!(runs.len() as i64, MAX_RUNS);
        assert_eq!(runs[0].run_id, "r3");
    }

    #[test]
    fn clear_empties() {
        let conn = open_in_memory().unwrap();
        add_run(&conn, "r1", "t", "c", &[ok("a")]).unwrap();
        clear(&conn).unwrap();
        assert!(list(&conn, 50).unwrap().is_empty());
    }
}
