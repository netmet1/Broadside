//! Persistent broadcast RESULT history (D-059). The Broadcast page appends
//! every run's per-host results here and reloads them on startup, so the
//! output log survives app restarts instead of showing only the last run.
//!
//! One row per host-result; rows of the same run share run_id/ts/command.
//! `result` holds the ExecResult as JSON text so the frontend renders a
//! reloaded block identically to a live one.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::AppResult;

/// Keep the table bounded — cap by number of RUNS (not rows) so a run is never
/// split. Older runs drop off the bottom.
const MAX_RUNS: i64 = 200;

/// One host's result as stored/replayed. `result` is the raw ExecResult JSON.
#[derive(Debug, Clone)]
pub struct HostResultInput {
    pub host_id: i64,
    pub label: String,
    pub color: String,
    pub result_json: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredHostResult {
    pub host_id: i64,
    pub label: String,
    pub color: String,
    /// The ExecResult, reparsed so it serializes back as a proper object.
    pub result: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredRun {
    pub run_id: String,
    pub ts: String,
    pub command: String,
    pub results: Vec<StoredHostResult>,
}

/// Appends one run's results, then prunes to the most recent MAX_RUNS runs.
pub fn add_run(
    conn: &Connection,
    run_id: &str,
    ts: &str,
    command: &str,
    results: &[HostResultInput],
) -> AppResult<()> {
    for r in results {
        conn.execute(
            "INSERT INTO broadcast_results
               (run_id, ts, command, host_id, label, color, result)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![run_id, ts, command, r.host_id, r.label, r.color, r.result_json],
        )?;
    }
    conn.execute(
        "DELETE FROM broadcast_results WHERE run_id NOT IN (
            SELECT run_id FROM broadcast_results
            GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?1
         )",
        params![MAX_RUNS],
    )?;
    Ok(())
}

/// Most recent `max_runs` runs, oldest-first (so the UI appends them with the
/// newest run at the bottom, matching live order).
pub fn list(conn: &Connection, max_runs: usize) -> AppResult<Vec<StoredRun>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, ts, command, host_id, label, color, result
         FROM broadcast_results
         WHERE run_id IN (
            SELECT run_id FROM broadcast_results
            GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?1
         )
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![max_runs as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;

    // Rows of a run are contiguous (inserted together, ordered by id) so a
    // simple run-break grouping preserves chronological order.
    let mut runs: Vec<StoredRun> = Vec::new();
    for r in rows {
        let (run_id, ts, command, host_id, label, color, result_json) = r?;
        let result: serde_json::Value =
            serde_json::from_str(&result_json).unwrap_or(serde_json::Value::Null);
        let host = StoredHostResult {
            host_id,
            label,
            color,
            result,
        };
        match runs.last_mut() {
            Some(last) if last.run_id == run_id => last.results.push(host),
            _ => runs.push(StoredRun {
                run_id,
                ts,
                command,
                results: vec![host],
            }),
        }
    }
    Ok(runs)
}

pub fn clear(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM broadcast_results", [])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn res(host_id: i64, label: &str) -> HostResultInput {
        HostResultInput {
            host_id,
            label: label.into(),
            color: "#3b82f6".into(),
            result_json: r#"{"status":"completed","exit_code":0,"stdout":"hi","stderr":"","duration_ms":5,"timed_out":false}"#.into(),
        }
    }

    #[test]
    fn add_and_list_groups_by_run_oldest_first() {
        let conn = open_in_memory().unwrap();
        add_run(&conn, "run-1", "t1", "uptime", &[res(1, "a"), res(2, "b")]).unwrap();
        add_run(&conn, "run-2", "t2", "df -h", &[res(1, "a")]).unwrap();

        let runs = list(&conn, 50).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, "run-1");
        assert_eq!(runs[0].command, "uptime");
        assert_eq!(runs[0].results.len(), 2);
        assert_eq!(runs[1].run_id, "run-2");
        // result reparsed into an object, not a string
        assert_eq!(runs[0].results[0].result["status"], "completed");
    }

    #[test]
    fn prunes_to_max_runs() {
        let conn = open_in_memory().unwrap();
        for i in 0..(MAX_RUNS + 5) {
            add_run(&conn, &format!("run-{i}"), "t", "cmd", &[res(1, "a")]).unwrap();
        }
        let runs = list(&conn, (MAX_RUNS + 100) as usize).unwrap();
        assert_eq!(runs.len() as i64, MAX_RUNS);
        // The oldest 5 runs were pruned; run-5 is now the oldest kept.
        assert_eq!(runs[0].run_id, "run-5");
    }

    #[test]
    fn clear_empties() {
        let conn = open_in_memory().unwrap();
        add_run(&conn, "run-1", "t", "cmd", &[res(1, "a")]).unwrap();
        clear(&conn).unwrap();
        assert!(list(&conn, 50).unwrap().is_empty());
    }
}
