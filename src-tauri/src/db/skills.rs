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

#[derive(Debug, Clone, Deserialize)]
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

pub fn list(conn: &Connection) -> AppResult<Vec<Skill>> {
    let sql = format!("SELECT {SELECT_COLS} FROM skills ORDER BY name COLLATE NOCASE ASC");
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
    conn.execute(
        "INSERT INTO skills (name, description, icon, kind, config_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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

    #[test]
    fn list_sorts_by_name_case_insensitively() {
        let conn = open_in_memory().unwrap();
        create(&conn, &input("zebra")).unwrap();
        create(&conn, &input("Apple")).unwrap();
        create(&conn, &input("mango")).unwrap();
        let names: Vec<String> = list(&conn).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["Apple", "mango", "zebra"]);
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
