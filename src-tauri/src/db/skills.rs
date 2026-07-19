//! Skill definitions (migration 13). A skill is a reusable multi-step
//! operation driven over a live PTY on each selected host.
//!
//! `config_json` is an opaque blob here: the kind-specific shape (steps,
//! declared params) is owned by [`crate::ssh::skill_run`] and its TS mirror.
//! Storing it as text keeps the schema stable as the step vocabulary grows.
//! It can contain command text, so it shares the at-rest exposure class of
//! `command_history` (D-011). **No secrets are ever stored here.**

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// The two skill kinds. `Ai` is accepted by the store from Phase 1 so a
/// definition round-trips, but only `Sequence` has an engine until Phase 2.
pub const KIND_SEQUENCE: &str = "sequence";
pub const KIND_AI: &str = "ai";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub kind: String,
    pub config_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub icon: Option<String>,
    pub kind: String,
    pub config_json: String,
}

const SELECT_COLS: &str =
    "id, name, description, icon, kind, config_json, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        icon: row.get(3)?,
        kind: row.get(4)?,
        config_json: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn validate(input: &SkillInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput("name is required".into()));
    }
    if input.kind != KIND_SEQUENCE && input.kind != KIND_AI {
        return Err(AppError::InvalidInput(format!(
            "unknown skill kind: {}",
            input.kind
        )));
    }
    // Reject a config that isn't even JSON at the door: a malformed blob would
    // otherwise only fail at run time, long after the user pressed Save.
    if serde_json::from_str::<serde_json::Value>(&input.config_json).is_err() {
        return Err(AppError::InvalidInput("config is not valid JSON".into()));
    }
    Ok(())
}

/// The rail's order: whatever the operator arranged, name as the tie-break so
/// two skills that have never been moved still land somewhere predictable.
pub fn list(conn: &Connection) -> AppResult<Vec<Skill>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM skills
          ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Skill> {
    let sql = format!("SELECT {SELECT_COLS} FROM skills WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or_else(|| AppError::InvalidInput(format!("no such skill: {id}")))
}

pub fn create(conn: &Connection, input: &SkillInput) -> AppResult<Skill> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    // A new skill goes to the bottom of the rail rather than sorting itself
    // into the middle, so creating one doesn't shuffle the list you just
    // arranged.
    conn.execute(
        "INSERT INTO skills (name, description, icon, kind, config_json, created_at, updated_at,
                             sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                 (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM skills))",
        params![
            input.name.trim(),
            input.description,
            input.icon,
            input.kind,
            input.config_json,
            now,
            now
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: &SkillInput) -> AppResult<Skill> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "UPDATE skills
            SET name = ?1, description = ?2, icon = ?3, kind = ?4,
                config_json = ?5, updated_at = ?6
          WHERE id = ?7",
        params![
            input.name.trim(),
            input.description,
            input.icon,
            input.kind,
            input.config_json,
            now,
            id
        ],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput(format!("no such skill: {id}")));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?)
}

/// Writes the rail's order, `ids` being every skill top to bottom.
///
/// Takes the whole list rather than a swap: the caller already knows the order
/// it is showing, and rewriting all of it heals any duplicate or gap left by an
/// interrupted move or a migration backfill. Ids that no longer exist are
/// skipped, so a stale list from a rail that hasn't reloaded yet is harmless.
pub fn reorder(conn: &mut Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.transaction()?;
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE skills SET sort_order = ?1 WHERE id = ?2",
            params![position as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn input(name: &str) -> SkillInput {
        SkillInput {
            name: name.into(),
            description: "does a thing".into(),
            icon: Some("wrench".into()),
            kind: KIND_SEQUENCE.into(),
            config_json: r#"{"params":[],"startStepId":"s1","steps":[]}"#.into(),
        }
    }

    #[test]
    fn create_get_round_trip() {
        let conn = open_in_memory().unwrap();
        let made = create(&conn, &input("Restart validator")).unwrap();
        let got = get(&conn, made.id).unwrap();
        assert_eq!(got.name, "Restart validator");
        assert_eq!(got.kind, KIND_SEQUENCE);
        assert_eq!(got.icon.as_deref(), Some("wrench"));
        assert_eq!(got.created_at, got.updated_at);
    }

    fn names(conn: &Connection) -> Vec<String> {
        list(conn).unwrap().into_iter().map(|s| s.name).collect()
    }

    #[test]
    fn list_keeps_creation_order_until_something_is_moved() {
        // Each new skill lands at the bottom, so the rail doesn't reshuffle
        // itself the moment you add one.
        let conn = open_in_memory().unwrap();
        create(&conn, &input("zebra")).unwrap();
        create(&conn, &input("Apple")).unwrap();
        create(&conn, &input("mango")).unwrap();
        assert_eq!(names(&conn), vec!["zebra", "Apple", "mango"]);
    }

    #[test]
    fn reorder_writes_the_order_it_is_given() {
        let mut conn = open_in_memory().unwrap();
        let a = create(&conn, &input("first")).unwrap();
        let b = create(&conn, &input("second")).unwrap();
        let c = create(&conn, &input("third")).unwrap();

        reorder(&mut conn, &[c.id, a.id, b.id]).unwrap();
        assert_eq!(names(&conn), vec!["third", "first", "second"]);
    }

    #[test]
    fn reorder_ignores_ids_that_are_gone() {
        // The rail can hand over a list it read before another window deleted
        // something. That must reorder what's left, not fail the whole move.
        let mut conn = open_in_memory().unwrap();
        let a = create(&conn, &input("kept")).unwrap();
        let b = create(&conn, &input("also kept")).unwrap();

        reorder(&mut conn, &[999, b.id, a.id]).unwrap();
        assert_eq!(names(&conn), vec!["also kept", "kept"]);
    }

    #[test]
    fn name_breaks_a_tie_case_insensitively() {
        // Rows that have never been moved all sit at 0 (the pre-migration-15
        // state), and must still come out in a stable, readable order.
        let conn = open_in_memory().unwrap();
        create(&conn, &input("zebra")).unwrap();
        create(&conn, &input("Apple")).unwrap();
        create(&conn, &input("mango")).unwrap();
        conn.execute("UPDATE skills SET sort_order = 0", []).unwrap();
        assert_eq!(names(&conn), vec!["Apple", "mango", "zebra"]);
    }

    #[test]
    fn update_replaces_config_and_bumps_updated_at() {
        let conn = open_in_memory().unwrap();
        let made = create(&conn, &input("one")).unwrap();
        let mut next = input("one renamed");
        next.config_json = r#"{"params":[],"startStepId":"s2","steps":[]}"#.into();
        let updated = update(&conn, made.id, &next).unwrap();
        assert_eq!(updated.name, "one renamed");
        assert!(updated.config_json.contains("s2"));
        assert_eq!(updated.created_at, made.created_at);
    }

    #[test]
    fn update_unknown_id_is_an_error() {
        let conn = open_in_memory().unwrap();
        assert!(update(&conn, 999, &input("nope")).is_err());
    }

    #[test]
    fn delete_removes_the_row() {
        let conn = open_in_memory().unwrap();
        let made = create(&conn, &input("temp")).unwrap();
        assert_eq!(delete(&conn, made.id).unwrap(), 1);
        assert!(get(&conn, made.id).is_err());
        assert_eq!(delete(&conn, made.id).unwrap(), 0);
    }

    #[test]
    fn name_is_required_and_trimmed() {
        let conn = open_in_memory().unwrap();
        let mut bad = input("   ");
        assert!(create(&conn, &bad).is_err());
        bad.name = "  padded  ".into();
        assert_eq!(create(&conn, &bad).unwrap().name, "padded");
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let conn = open_in_memory().unwrap();
        let mut bad = input("weird");
        bad.kind = "telepathy".into();
        assert!(create(&conn, &bad).is_err());
    }

    #[test]
    fn malformed_config_is_rejected_at_save_time() {
        let conn = open_in_memory().unwrap();
        let mut bad = input("broken");
        bad.config_json = "{not json".into();
        assert!(create(&conn, &bad).is_err());
    }

    #[test]
    fn duplicate_names_are_allowed() {
        // Unlike hosts.label there is no UNIQUE constraint: two skills may
        // share a name (they're picked from a list, not addressed by name).
        let conn = open_in_memory().unwrap();
        create(&conn, &input("same")).unwrap();
        create(&conn, &input("same")).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 2);
    }
}
