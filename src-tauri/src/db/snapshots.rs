//! Workspace snapshots (migration 28): every open workspace at one moment,
//! saved under a name so the whole set can be opened again (prompts135).
//!
//! A snapshot is the template idea one level up. A template is one
//! arrangement of sessions; a snapshot is several of them, each with the
//! workspace's own name, colour and grid sizes, plus which one was on screen.
//! There is no editor: a snapshot is taken from what is open, and taken again
//! to change it.
//!
//! The sessions are [`TemplateItem`]s, the same references a template holds,
//! so everything said about those holds here: a host item is a reference that
//! meets the host-key check when it connects, never a credential, and **no
//! secrets are ever stored here**.
//!
//! Nothing here connects anything. Opening a snapshot is the frontend's job,
//! through the same path a template takes, and whether its sessions connect
//! straight away is a setting on that side (held back past a few workspaces
//! unless the operator says otherwise).

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::templates::{
    unique_name_in, validate_layout, NamedTable, TemplateItem, TemplateLayout,
};
use crate::error::{AppError, AppResult};

/// The most workspaces one snapshot may hold. Far past what anyone keeps open;
/// a ceiling for a restored or hand-edited row.
pub const MAX_WORKSPACES: usize = 32;
/// The most sessions one of its workspaces may hold: a template's own ceiling.
pub const MAX_ITEMS: usize = super::templates::MAX_ITEMS;

/// One workspace as it was when the snapshot was taken.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotWorkspace {
    pub name: String,
    /// `#rrggbb`, or empty for none.
    #[serde(default)]
    pub color: String,
    /// Named by the operator or a template, rather than "Workspace N".
    #[serde(default)]
    pub named: bool,
    /// How its grid shared the pane, or none for an even split.
    #[serde(default)]
    pub layout: Option<TemplateLayout>,
    /// Whether it was showing its tabs one at a time or as a grid. Each
    /// workspace has its own. None in a snapshot taken before there was a
    /// choice per workspace, which opens the way a new workspace would.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<WorkspaceView>,
    /// Its tabs, in the tab strip's order.
    #[serde(default)]
    pub items: Vec<TemplateItem>,
}

/// The Terminals tab's two layouts, `"tabs"` and `"grid"` in the JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceView {
    Tabs,
    Grid,
}

/// What a snapshot holds, stored as one JSON column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotData {
    /// Which workspace was on screen, as an index into `workspaces`.
    #[serde(default)]
    pub active: usize,
    #[serde(default)]
    pub workspaces: Vec<SnapshotWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: i64,
    pub name: String,
    pub active: usize,
    pub workspaces: Vec<SnapshotWorkspace>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInput {
    pub name: String,
    #[serde(default)]
    pub active: usize,
    #[serde(default)]
    pub workspaces: Vec<SnapshotWorkspace>,
}

const SELECT_COLS: &str = "id, name, data_json, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<Snapshot> {
    let data_json: String = row.get(2)?;
    // Data that will not parse, or is not valid (from a restored file, say),
    // costs the contents, never the row: it still lists under its name and can
    // be deleted or taken again.
    let data = serde_json::from_str::<SnapshotData>(&data_json)
        .ok()
        .filter(|d| validate_data(d).is_ok())
        .unwrap_or(SnapshotData { active: 0, workspaces: Vec::new() });
    Ok(Snapshot {
        id: row.get(0)?,
        name: row.get(1)?,
        active: data.active,
        workspaces: data.workspaces,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn validate_name(name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("name is required".into()));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(
            "name can't contain control characters".into(),
        ));
    }
    if name.chars().count() > 200 {
        return Err(AppError::InvalidInput("that name is too long".into()));
    }
    Ok(())
}

fn validate_data(data: &SnapshotData) -> AppResult<()> {
    if data.workspaces.is_empty() {
        return Err(AppError::InvalidInput(
            "a snapshot needs at least one workspace with tabs in it".into(),
        ));
    }
    if data.workspaces.len() > MAX_WORKSPACES {
        return Err(AppError::InvalidInput(format!(
            "a snapshot holds at most {MAX_WORKSPACES} workspaces"
        )));
    }
    if data.active >= data.workspaces.len() {
        return Err(AppError::InvalidInput(
            "the workspace on screen is not one of the snapshot's".into(),
        ));
    }
    for ws in &data.workspaces {
        if ws.name.trim().is_empty() || ws.name.chars().any(|c| c.is_control()) {
            return Err(AppError::InvalidInput(
                "every workspace in a snapshot needs a plain name".into(),
            ));
        }
        if !ws.color.is_empty() && !super::templates::is_hex_color(&ws.color) {
            return Err(AppError::InvalidInput(
                "colour must be #rrggbb, or empty for none".into(),
            ));
        }
        if ws.items.is_empty() || ws.items.len() > MAX_ITEMS {
            return Err(AppError::InvalidInput(format!(
                "each workspace in a snapshot holds 1 to {MAX_ITEMS} sessions"
            )));
        }
        for item in &ws.items {
            super::templates::validate_item(item)?;
        }
        if let Some(layout) = &ws.layout {
            validate_layout(layout)?;
        }
    }
    Ok(())
}

fn data_of(input: &SnapshotInput) -> SnapshotData {
    SnapshotData {
        active: input.active,
        workspaces: input.workspaces.clone(),
    }
}

/// Newest first: a snapshot is most often the one just taken.
pub fn list(conn: &Connection) -> AppResult<Vec<Snapshot>> {
    let sql = format!("SELECT {SELECT_COLS} FROM snapshots ORDER BY updated_at DESC, id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Snapshot> {
    let sql = format!("SELECT {SELECT_COLS} FROM snapshots WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or_else(|| AppError::InvalidInput(format!("no such snapshot: {id}")))
}

/// Saves a new snapshot. A name already in use is numbered ("Friday 02"), as a
/// template's is.
pub fn create(conn: &mut Connection, input: &SnapshotInput) -> AppResult<Snapshot> {
    validate_name(&input.name)?;
    let data = data_of(input);
    validate_data(&data)?;
    let data_json = serde_json::to_string(&data)?;
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    let name = unique_name_in(&tx, NamedTable::Snapshots, input.name.trim(), None)?;
    tx.execute(
        "INSERT INTO snapshots (name, data_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, data_json, now, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    get(conn, id)
}

/// Takes the snapshot again: its contents replaced with what is open now, under
/// the name given (numbered if another snapshot has it).
pub fn update(conn: &mut Connection, id: i64, input: &SnapshotInput) -> AppResult<Snapshot> {
    validate_name(&input.name)?;
    let data = data_of(input);
    validate_data(&data)?;
    let data_json = serde_json::to_string(&data)?;
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    let name = unique_name_in(&tx, NamedTable::Snapshots, input.name.trim(), Some(id))?;
    let changed = tx.execute(
        "UPDATE snapshots SET name = ?1, data_json = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, data_json, now, id],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput(format!("no such snapshot: {id}")));
    }
    tx.commit()?;
    get(conn, id)
}

/// A new name and nothing else. The contents and the time they were taken
/// stay as they were.
pub fn rename(conn: &mut Connection, id: i64, name: &str) -> AppResult<Snapshot> {
    validate_name(name)?;
    let tx = conn.transaction()?;
    let name = unique_name_in(&tx, NamedTable::Snapshots, name.trim(), Some(id))?;
    let changed = tx.execute(
        "UPDATE snapshots SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput(format!("no such snapshot: {id}")));
    }
    tx.commit()?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM snapshots WHERE id = ?1", params![id])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::templates::HostRef;

    fn shell(id: &str) -> TemplateItem {
        TemplateItem::Shell {
            shell_id: id.into(),
            label: id.into(),
        }
    }

    fn ws(name: &str, n: usize) -> SnapshotWorkspace {
        SnapshotWorkspace {
            name: name.into(),
            color: String::new(),
            named: true,
            layout: None,
            view: None,
            items: (0..n).map(|_| shell("pwsh")).collect(),
        }
    }

    fn input(name: &str, workspaces: Vec<SnapshotWorkspace>) -> SnapshotInput {
        SnapshotInput {
            name: name.into(),
            active: 0,
            workspaces,
        }
    }

    #[test]
    fn a_snapshot_round_trips() {
        let mut conn = open_in_memory().unwrap();
        let mut first = ws("Ops", 3);
        first.layout = Some(TemplateLayout {
            rows: vec![1.5, 0.5],
            cols: vec![],
            widths: vec![0.7, 0.0, 0.0],
            heights: vec![24.0, 10.0],
        });
        first.items.push(TemplateItem::Host {
            host_id: Some(7),
            reference: HostRef {
                label: "web01".into(),
                hostname: "10.0.0.5".into(),
                port: 22,
                username: "joe".into(),
            },
        });
        first.view = Some(WorkspaceView::Grid);
        let mut i = input("Friday", vec![first.clone(), ws("Logs", 1)]);
        i.active = 1;
        let s = create(&mut conn, &i).unwrap();
        let back = get(&conn, s.id).unwrap();
        assert_eq!(back.name, "Friday");
        assert_eq!(back.active, 1);
        assert_eq!(back.workspaces, vec![first, ws("Logs", 1)]);
    }

    #[test]
    fn names_are_numbered_and_rename_keeps_the_contents() {
        let mut conn = open_in_memory().unwrap();
        let a = create(&mut conn, &input("Friday", vec![ws("A", 1)])).unwrap();
        let b = create(&mut conn, &input("friday", vec![ws("B", 2)])).unwrap();
        assert_eq!(b.name, "friday 02");
        let r = rename(&mut conn, a.id, "Monday").unwrap();
        assert_eq!(r.name, "Monday");
        assert_eq!(r.workspaces, vec![ws("A", 1)]);
        // Templates may share a snapshot's name: they are different lists.
        assert_eq!(list(&conn).unwrap().len(), 2);
    }

    #[test]
    fn update_replaces_the_contents() {
        let mut conn = open_in_memory().unwrap();
        let s = create(&mut conn, &input("Friday", vec![ws("A", 1)])).unwrap();
        let u = update(&mut conn, s.id, &input("Friday", vec![ws("A", 2), ws("B", 1)])).unwrap();
        assert_eq!(u.workspaces.len(), 2);
        assert_eq!(u.name, "Friday");
        assert_eq!(delete(&conn, s.id).unwrap(), 1);
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn what_cannot_be_opened_is_refused() {
        let mut conn = open_in_memory().unwrap();
        let empty_ws = ws("Empty", 0);
        let mut bad_active = input("x", vec![ws("A", 1)]);
        bad_active.active = 1;
        let mut bad_layout = ws("A", 1);
        bad_layout.layout = Some(TemplateLayout { rows: vec![0.0], cols: vec![1.0], widths: vec![], heights: vec![] });
        let mut bad_colour = ws("A", 1);
        bad_colour.color = "red".into();
        for bad in [
            input("", vec![ws("A", 1)]),
            input("none", vec![]),
            input("x", vec![empty_ws]),
            bad_active,
            input("x", vec![bad_layout]),
            input("x", vec![bad_colour]),
            input("x", (0..=MAX_WORKSPACES).map(|i| ws(&format!("W{i}"), 1)).collect()),
        ] {
            assert!(create(&mut conn, &bad).is_err(), "accepted {:?}", bad.name);
        }
    }

    #[test]
    fn the_view_is_optional_and_lowercase_in_the_json() {
        let old: SnapshotWorkspace =
            serde_json::from_str(r#"{"name":"A","items":[]}"#).unwrap();
        assert_eq!(old.view, None);
        let mut w = ws("A", 0);
        assert!(!serde_json::to_string(&w).unwrap().contains("view"));
        w.view = Some(WorkspaceView::Tabs);
        assert!(serde_json::to_string(&w).unwrap().contains(r#""view":"tabs""#));
        let back: SnapshotWorkspace =
            serde_json::from_str(r#"{"name":"A","view":"grid","items":[]}"#).unwrap();
        assert_eq!(back.view, Some(WorkspaceView::Grid));
    }

    #[test]
    fn stored_contents_that_are_not_valid_read_as_empty() {
        let mut conn = open_in_memory().unwrap();
        let s = create(&mut conn, &input("Friday", vec![ws("A", 1)])).unwrap();
        conn.execute(
            "UPDATE snapshots SET data_json = 'not json' WHERE id = ?1",
            params![s.id],
        )
        .unwrap();
        let back = get(&conn, s.id).unwrap();
        assert_eq!(back.name, "Friday");
        assert!(back.workspaces.is_empty());
    }
}
