//! Session templates (migration 22): a saved arrangement of terminal sessions
//! that can be opened again in one action.
//!
//! A template is an **ordered list**, plus, optionally, how its grid shares the
//! pane (migration 27). There is no tabs-versus-grid, no column count and no
//! per-tile size in characters: the grid's shape falls out of the number of
//! sessions exactly as the Terminals tab already works it out, so a template
//! can never argue with the operator's own Grid settings. The saved sizes are
//! fractions of whatever pane it opens in ([`TemplateLayout`]), so the same
//! file opened on two machines still looks right on both.
//!
//! **Why the database and not localStorage**, where the neighbouring launcher
//! preferences live: a template is listed in the Hosts table, carries a
//! startup flag the app reads before anything is on screen, and has export and
//! import. All three of those are shaped like a row rather than a view
//! preference. The saved shell *profiles* stay in localStorage precisely
//! because they are none of those things.
//!
//! An item can name a host, a local shell (detected or custom) or a saved shell
//! profile. Only the host reference is portable, which is why it carries the
//! four fields an import can match on; a shell id and a profile id mean nothing
//! on another machine, so they travel with a label and arrive as a placeholder
//! when they do not resolve.
//!
//! **No secrets are ever stored here.** A host item is a reference, not a
//! credential; the credential store owns those, as everywhere else.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// What a template may be asked to do when Broadside starts.
///
/// `Launch` opens the tabs and stops there: every pane sits on its Reconnect
/// button, which is the same state a session that ended leaves behind. `Connect`
/// goes on to open the shells, which means SSH connections made before anybody
/// has looked at the screen, and that is the one the editor guards.
pub const STARTUP_OFF: &str = "off";
pub const STARTUP_LAUNCH: &str = "launch";
pub const STARTUP_CONNECT: &str = "connect";

const STARTUPS: [&str; 3] = [STARTUP_OFF, STARTUP_LAUNCH, STARTUP_CONNECT];

/// The most sessions one template may hold.
///
/// Not a judgement about what is sensible, which is the editor's job and is a
/// warning rather than a wall. This is the ceiling that stops a hand-edited or
/// hostile file asking the app to open ten thousand shells at startup, which is
/// the one moment nobody is watching.
pub const MAX_ITEMS: usize = 64;

/// How a template refers to a host it cannot carry: the four fields an import
/// on another machine can match on.
///
/// Deliberately not the host id, which names a row in one database and nothing
/// anywhere else. Deliberately not the whole host either: colour, notes, tags
/// and credentials are the receiving machine's business, and a template that
/// carried them would be a host importer wearing a different hat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRef {
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
}

/// One session in a template, in the order it opens.
///
/// `rename_all_fields` is the load-bearing half of the attribute below.
/// `rename_all` on an enum renames the *variants*, never the fields inside
/// them, so without the second one `profile_id` and `shell_id` would stay
/// snake_case on the wire while the frontend sends `profileId` and `shellId`,
/// and every save carrying one of those items would be refused by the argument
/// parser before the command was ever entered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TemplateItem {
    /// A saved SSH host. `host_id` is null for a reference that did not resolve
    /// on this machine, which is a placeholder the operator points at a real
    /// host rather than a reason to refuse the file.
    #[serde(rename = "host")]
    Host {
        // Absent rather than null when there is no id, so an exported file
        // never carries a field whose only possible value is "not here".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_id: Option<i64>,
        #[serde(rename = "ref")]
        reference: HostRef,
    },
    /// A local shell by launcher id (`powershell`, `pwsh`, `cmd`,
    /// `wsl:<distro>`, `custom:<n>`). The label travels with it so a shell this
    /// machine does not have still has a name on screen.
    #[serde(rename = "shell")]
    Shell { shell_id: String, label: String },
    /// A saved local-shell launch profile. Profiles live in localStorage, so
    /// this resolves per machine exactly like a shell id does.
    #[serde(rename = "profile")]
    Profile { profile_id: String, label: String },
}

/// The most rows, or columns, a saved layout may describe. Far past any grid
/// [`MAX_ITEMS`] sessions can make; a ceiling for a hand-edited file.
pub const MAX_LAYOUT_TRACKS: usize = 16;

/// How a template's grid shares the pane, as the Terminals tab had it when the
/// template was saved. Fractions, never pixels, so the arrangement fits any
/// window.
///
/// - `heights`: each row's height in lines of the terminal font, top to
///   bottom.
/// - `widths`: one per session, in order: its width as a fraction of the
///   grid's, or 0 for a session that shares what its row has left.
/// - `rows` and `cols`: relative row sizes (a CSS `fr`) and two column sizes,
///   from a layout saved before rows and sessions had sizes of their own.
///   Still read, so such a template keeps its sizes; written empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateLayout {
    #[serde(default)]
    pub rows: Vec<f64>,
    #[serde(default)]
    pub cols: Vec<f64>,
    #[serde(default)]
    pub widths: Vec<f64>,
    #[serde(default)]
    pub heights: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: i64,
    pub name: String,
    /// `#rrggbb`, or empty for "no colour", the way a shell profile does it.
    pub color: String,
    pub items: Vec<TemplateItem>,
    pub startup: String,
    pub layout: Option<TemplateLayout>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateInput {
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub items: Vec<TemplateItem>,
    #[serde(default = "startup_off")]
    pub startup: String,
    #[serde(default)]
    pub layout: Option<TemplateLayout>,
}

fn startup_off() -> String {
    STARTUP_OFF.to_string()
}

const SELECT_COLS: &str =
    "id, name, color, items_json, startup, created_at, updated_at, layout_json";

fn from_row(row: &Row) -> rusqlite::Result<Template> {
    let items_json: String = row.get(3)?;
    let layout_json: String = row.get(7)?;
    Ok(Template {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        // A blob that will not parse costs the arrangement, never the row: the
        // template still lists, still has its name, and can be rebuilt. Failing
        // the whole read would take every other template down with it.
        items: serde_json::from_str(&items_json).unwrap_or_default(),
        startup: row.get(4)?,
        // The same for the sizes, and a set that is not valid (from a restored
        // file, say) is dropped the same way: the grid shares the pane evenly.
        layout: parse_layout(&layout_json),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn parse_layout(json: &str) -> Option<TemplateLayout> {
    if json.is_empty() {
        return None;
    }
    serde_json::from_str::<TemplateLayout>(json)
        .ok()
        .filter(|l| validate_layout(l).is_ok())
}

fn layout_json(layout: &Option<TemplateLayout>) -> AppResult<String> {
    Ok(match layout {
        Some(l) => serde_json::to_string(l)?,
        None => String::new(),
    })
}

/// Every size a positive, finite number of sane magnitude, and a sane number
/// of them. The sizes become CSS on the Terminals tab, so a value that is not
/// a plain number never gets that far.
pub fn validate_layout(layout: &TemplateLayout) -> AppResult<()> {
    for (what, sizes) in [
        ("rows", &layout.rows),
        ("columns", &layout.cols),
        ("row heights", &layout.heights),
    ] {
        if sizes.len() > MAX_LAYOUT_TRACKS {
            return Err(AppError::InvalidInput(format!(
                "a layout has at most {MAX_LAYOUT_TRACKS} {what}"
            )));
        }
        if sizes.iter().any(|s| !s.is_finite() || *s <= 0.0 || *s > 1000.0) {
            return Err(AppError::InvalidInput(format!(
                "a layout's {what} must be sizes between 0 and 1000"
            )));
        }
    }
    if layout.widths.len() > MAX_ITEMS {
        return Err(AppError::InvalidInput(format!(
            "a layout has at most {MAX_ITEMS} widths"
        )));
    }
    if layout
        .widths
        .iter()
        .any(|w| !w.is_finite() || *w < 0.0 || *w > 1.0)
    {
        return Err(AppError::InvalidInput(
            "a layout's widths must be fractions between 0 and 1".into(),
        ));
    }
    if layout.rows.is_empty()
        && layout.cols.is_empty()
        && layout.widths.is_empty()
        && layout.heights.is_empty()
    {
        return Err(AppError::InvalidInput("a layout cannot be empty".into()));
    }
    Ok(())
}

fn validate(input: &TemplateInput) -> AppResult<()> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("name is required".into()));
    }
    // The name becomes a row in a table and a line in a menu; a control
    // character in it corrupts both.
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(
            "name can't contain control characters".into(),
        ));
    }
    if !input.color.is_empty() && !is_hex_color(&input.color) {
        return Err(AppError::InvalidInput(
            "colour must be #rrggbb, or empty for none".into(),
        ));
    }
    if !STARTUPS.contains(&input.startup.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "unknown startup setting: {}",
            input.startup
        )));
    }
    if input.items.len() > MAX_ITEMS {
        return Err(AppError::InvalidInput(format!(
            "a template holds at most {MAX_ITEMS} sessions"
        )));
    }
    for item in &input.items {
        validate_item(item)?;
    }
    if let Some(layout) = &input.layout {
        validate_layout(layout)?;
    }
    Ok(())
}

pub(crate) fn validate_item(item: &TemplateItem) -> AppResult<()> {
    match item {
        TemplateItem::Host { reference, .. } => {
            if reference.hostname.trim().is_empty() {
                return Err(AppError::InvalidInput(
                    "a host reference needs a hostname".into(),
                ));
            }
        }
        TemplateItem::Shell { shell_id, .. } => {
            if shell_id.trim().is_empty() {
                return Err(AppError::InvalidInput("a shell item needs an id".into()));
            }
        }
        TemplateItem::Profile { profile_id, .. } => {
            if profile_id.trim().is_empty() {
                return Err(AppError::InvalidInput("a profile item needs an id".into()));
            }
        }
    }
    Ok(())
}

pub fn is_hex_color(s: &str) -> bool {
    s.len() == 7
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// In the operator's own order (migration 26), dragged on the Hosts tab's
/// Templates side. It is also the order several ticked templates open in, so it
/// is the order the list has to show. The name breaks a tie.
pub fn list(conn: &Connection) -> AppResult<Vec<Template>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM templates ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Template> {
    let sql = format!("SELECT {SELECT_COLS} FROM templates WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or_else(|| AppError::InvalidInput(format!("no such template: {id}")))
}

/// The one template that opens at startup, if any. Read before the first page
/// is drawn, so it is a single indexed row lookup rather than a list and a
/// filter.
pub fn startup_template(conn: &Connection) -> AppResult<Option<Template>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM templates WHERE startup <> '{STARTUP_OFF}' ORDER BY id ASC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_row([], from_row).optional()?)
}

pub fn create(conn: &mut Connection, input: &TemplateInput) -> AppResult<Template> {
    create_after(conn, input, None)
}

/// Creates a template. With `after`, it goes directly below that one (a
/// duplicate turns up where the operator was looking); otherwise, or when that
/// one has gone, at the end.
pub fn create_after(
    conn: &mut Connection,
    input: &TemplateInput,
    after: Option<i64>,
) -> AppResult<Template> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    let items_json = serde_json::to_string(&input.items)?;
    let layout_json = layout_json(&input.layout)?;
    let tx = conn.transaction()?;
    let name = unique_name(&tx, input.name.trim(), None)?;
    clear_other_startups(&tx, input, None)?;
    let anchor: Option<i64> = match after {
        Some(a) => tx
            .query_row(
                "SELECT sort_order FROM templates WHERE id = ?1",
                params![a],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    let position: i64 = match anchor {
        Some(order) => {
            tx.execute(
                "UPDATE templates SET sort_order = sort_order + 1 WHERE sort_order > ?1",
                params![order],
            )?;
            order + 1
        }
        None => tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM templates",
            [],
            |r| r.get(0),
        )?,
    };
    tx.execute(
        "INSERT INTO templates (name, color, items_json, startup, created_at, updated_at, sort_order, layout_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![name, input.color, items_json, input.startup, now, now, position, layout_json],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    get(conn, id)
}

pub fn update(conn: &mut Connection, id: i64, input: &TemplateInput) -> AppResult<Template> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    let items_json = serde_json::to_string(&input.items)?;
    let layout_json = layout_json(&input.layout)?;
    let tx = conn.transaction()?;
    let name = unique_name(&tx, input.name.trim(), Some(id))?;
    clear_other_startups(&tx, input, Some(id))?;
    let changed = tx.execute(
        "UPDATE templates
            SET name = ?1, color = ?2, items_json = ?3, startup = ?4, updated_at = ?5,
                layout_json = ?7
          WHERE id = ?6",
        params![name, input.color, items_json, input.startup, now, id, layout_json],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput(format!("no such template: {id}")));
    }
    tx.commit()?;
    get(conn, id)
}

/// The name this template will actually be saved under.
///
/// Two templates called the same thing are two rows nobody can tell apart: the
/// Hosts list, the editor's own menu and the "which one opens at startup"
/// question are all answered by reading a name off a screen. So a name already
/// in use is taken as the base of a new one rather than refused, and the save
/// goes through with a number on the end. The saved row is read back and put
/// into the editor, so the operator sees the name they actually got.
///
/// Done here rather than in the editor because the editor is one way in among
/// several: an import, a second window and a restored backup all arrive at the
/// same two functions, and a rule enforced on one screen is not a rule. It runs
/// inside the write's own transaction, so two saves racing cannot both find the
/// same name free.
///
/// A trailing number is treated as one of these suffixes and replaced, so
/// saving "Morning check 02" a second time gives "Morning check 03" rather than
/// "Morning check 02 02". A number that is part of the name ("Server2") is not
/// a suffix and survives.
fn unique_name(
    tx: &rusqlite::Transaction<'_>,
    desired: &str,
    keep: Option<i64>,
) -> AppResult<String> {
    unique_name_in(tx, NamedTable::Templates, desired, keep)
}

/// The tables whose rows are told apart by name and numbered the same way. A
/// closed set, so the table name put into the SQL below is never anything a
/// caller passed in.
#[derive(Clone, Copy)]
pub(crate) enum NamedTable {
    Templates,
    Snapshots,
}

impl NamedTable {
    fn table(self) -> &'static str {
        match self {
            NamedTable::Templates => "templates",
            NamedTable::Snapshots => "snapshots",
        }
    }
}

/// [`unique_name`]'s rule, for any of the [`NamedTable`]s: a snapshot is
/// listed by name beside the templates, and the same reasoning holds for it.
pub(crate) fn unique_name_in(
    tx: &rusqlite::Transaction<'_>,
    table: NamedTable,
    desired: &str,
    keep: Option<i64>,
) -> AppResult<String> {
    if !name_taken(tx, table, desired, keep)? {
        return Ok(desired.to_string());
    }
    let stem = match desired.rsplit_once(' ') {
        Some((head, tail))
            if !head.trim().is_empty()
                && !tail.is_empty()
                && tail.chars().all(|c| c.is_ascii_digit()) =>
        {
            head.trim_end()
        }
        _ => desired,
    };
    for n in 2..=999u32 {
        let candidate = format!("{stem} {n:02}");
        if !name_taken(tx, table, &candidate, keep)? {
            return Ok(candidate);
        }
    }
    Err(AppError::InvalidInput(format!(
        "there are already too many {} called \"{stem}\"; give this one a different name",
        table.table()
    )))
}

/// Is some *other* row already called this? NOCASE, because two names that
/// differ only in capitals are two names only the database can tell apart.
fn name_taken(
    tx: &rusqlite::Transaction<'_>,
    table: NamedTable,
    name: &str,
    keep: Option<i64>,
) -> AppResult<bool> {
    // `id IS NOT ?2` rather than `<>`: with no id to keep the bind is NULL, and
    // `id <> NULL` is NULL for every row, which would match nothing at all.
    let sql = format!(
        "SELECT 1 FROM {} WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2 LIMIT 1",
        table.table()
    );
    Ok(tx
        .query_row(&sql, params![name, keep], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Exactly one template may open at startup, and that is enforced here rather
/// than in the editor.
///
/// The editor is one screen among several and a second window, an import or a
/// hand-edited database would each be a way round it. Doing it in the same
/// transaction as the write means there is never an instant where two rows
/// claim the launch, which is the state the startup read has no good answer for.
fn clear_other_startups(
    tx: &rusqlite::Transaction<'_>,
    input: &TemplateInput,
    keep: Option<i64>,
) -> AppResult<()> {
    if input.startup == STARTUP_OFF {
        return Ok(());
    }
    tx.execute(
        "UPDATE templates SET startup = ?1 WHERE id IS NOT ?2",
        params![STARTUP_OFF, keep],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM templates WHERE id = ?1", params![id])?)
}

/// Rewrites the order after a drag: `ids` first, in the order given, then any
/// template the list did not mention, in its existing order. Tolerant of a
/// stale list, like the host and profile versions. Dense integers from 0.
pub fn reorder(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let current: Vec<i64> = list(&tx)?.into_iter().map(|t| t.id).collect();
    let mut order: Vec<i64> = Vec::with_capacity(current.len());
    for id in ids {
        if current.contains(id) && !order.contains(id) {
            order.push(*id);
        }
    }
    for id in &current {
        if !order.contains(id) {
            order.push(*id);
        }
    }
    for (i, id) in order.iter().enumerate() {
        tx.execute(
            "UPDATE templates SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Turns every host reference in `items` into a live one where this database
/// has a match, and leaves the rest as placeholders.
///
/// Matching is on endpoint first (hostname, port and username), which is what
/// actually identifies a machine, and on label only as a fallback, because two
/// people naming the same box differently is ordinary and a label is the thing
/// most likely to have been edited. A reference that matches nothing keeps its
/// fields and arrives with no id, which is what the editor draws as a
/// placeholder box.
///
/// Never creates or edits a host. Importing an arrangement is not importing
/// machines, and a file that could quietly add hosts would be a very different
/// thing to open.
pub fn resolve_items(conn: &Connection, items: &mut [TemplateItem]) -> AppResult<()> {
    let hosts = crate::db::hosts::list_all(conn)?;
    for item in items.iter_mut() {
        let TemplateItem::Host { host_id, reference } = item else {
            continue;
        };
        let matched = hosts
            .iter()
            .find(|h| {
                h.hostname.eq_ignore_ascii_case(&reference.hostname)
                    && h.port == reference.port
                    && h.username == reference.username
            })
            .or_else(|| {
                hosts
                    .iter()
                    .find(|h| h.label.eq_ignore_ascii_case(&reference.label))
            });
        *host_id = matched.map(|h| h.id);
    }
    Ok(())
}

/// Re-reads each host item's reference from the database, so an export carries
/// what the host is *now* rather than what it was called when it was dropped
/// into the template months ago. Items whose host has since been deleted keep
/// the stored snapshot, which is the only description of them left.
pub fn refresh_refs(conn: &Connection, items: &mut [TemplateItem]) -> AppResult<()> {
    for item in items.iter_mut() {
        let TemplateItem::Host { host_id, reference } = item else {
            continue;
        };
        let Some(id) = *host_id else { continue };
        if let Ok(h) = crate::db::hosts::get(conn, id) {
            *reference = HostRef {
                label: h.label,
                hostname: h.hostname,
                port: h.port,
                username: h.username,
            };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::hosts::{self, HostInput};
    use crate::db::open_in_memory;

    fn host_item(label: &str, hostname: &str) -> TemplateItem {
        TemplateItem::Host {
            host_id: None,
            reference: HostRef {
                label: label.into(),
                hostname: hostname.into(),
                port: 22,
                username: "joe".into(),
            },
        }
    }

    fn input(name: &str) -> TemplateInput {
        TemplateInput {
            name: name.into(),
            color: "#112233".into(),
            items: vec![
                host_item("web01", "10.0.0.5"),
                TemplateItem::Shell {
                    shell_id: "pwsh".into(),
                    label: "PowerShell 7".into(),
                },
            ],
            startup: STARTUP_OFF.into(),
            layout: None,
        }
    }

    #[test]
    fn a_layout_round_trips_and_a_bad_one_is_refused() {
        let mut conn = open_in_memory().unwrap();
        let mut with = input("sized");
        with.layout = Some(TemplateLayout {
            rows: vec![],
            cols: vec![],
            widths: vec![0.85, 0.0, 0.0],
            heights: vec![30.0, 12.5],
        });
        let t = create(&mut conn, &with).unwrap();
        assert_eq!(get(&conn, t.id).unwrap().layout, with.layout);

        // Saving without one clears it.
        let t = update(&mut conn, t.id, &input("sized")).unwrap();
        assert_eq!(t.layout, None);

        let layout = |rows: Vec<f64>, cols: Vec<f64>, widths: Vec<f64>| TemplateLayout {
            rows,
            cols,
            widths,
            heights: vec![],
        };
        for bad in [
            layout(vec![], vec![], vec![]),
            layout(vec![1.0, -1.0], vec![1.0], vec![]),
            layout(vec![1.0], vec![f64::INFINITY], vec![]),
            layout(vec![1.0; MAX_LAYOUT_TRACKS + 1], vec![1.0], vec![]),
            layout(vec![1.0], vec![], vec![1.5]),
            layout(vec![1.0], vec![], vec![-0.1]),
            layout(vec![1.0], vec![], vec![f64::NAN]),
            layout(vec![1.0], vec![], vec![0.5; MAX_ITEMS + 1]),
            TemplateLayout { heights: vec![0.0], ..layout(vec![], vec![], vec![]) },
            TemplateLayout { heights: vec![2000.0], ..layout(vec![], vec![], vec![]) },
            TemplateLayout {
                heights: vec![20.0; MAX_LAYOUT_TRACKS + 1],
                ..layout(vec![], vec![], vec![])
            },
        ] {
            let mut i = input("bad");
            i.layout = Some(bad);
            assert!(create(&mut conn, &i).is_err());
        }
    }

    #[test]
    fn a_stored_layout_that_is_not_valid_reads_as_none() {
        let mut conn = open_in_memory().unwrap();
        let t = create(&mut conn, &input("tampered")).unwrap();
        conn.execute(
            "UPDATE templates SET layout_json = ?1 WHERE id = ?2",
            params![r#"{"rows":[1e9],"cols":[1]}"#, t.id],
        )
        .unwrap();
        assert_eq!(get(&conn, t.id).unwrap().layout, None);
        conn.execute(
            "UPDATE templates SET layout_json = 'not json' WHERE id = ?1",
            params![t.id],
        )
        .unwrap();
        assert_eq!(get(&conn, t.id).unwrap().layout, None);
    }

    #[test]
    fn a_layout_saved_before_widths_still_reads() {
        let mut conn = open_in_memory().unwrap();
        let t = create(&mut conn, &input("older")).unwrap();
        conn.execute(
            "UPDATE templates SET layout_json = ?1 WHERE id = ?2",
            params![r#"{"rows":[1.4,0.6],"cols":[0.8,1.2]}"#, t.id],
        )
        .unwrap();
        assert_eq!(
            get(&conn, t.id).unwrap().layout,
            Some(TemplateLayout {
                rows: vec![1.4, 0.6],
                cols: vec![0.8, 1.2],
                widths: vec![],
                heights: vec![],
            })
        );
    }

    #[test]
    fn templates_keep_the_order_they_are_given() {
        let mut conn = open_in_memory().unwrap();
        let z = create(&mut conn, &input("Zulu")).unwrap();
        let a = create(&mut conn, &input("alpha")).unwrap();
        let names = |conn: &Connection| -> Vec<String> {
            list(conn).unwrap().into_iter().map(|t| t.name).collect()
        };
        assert_eq!(names(&conn), ["Zulu", "alpha"]);

        // A duplicate lands directly under its source, not at the end.
        create_after(&mut conn, &input("Zulu"), Some(z.id)).unwrap();
        assert_eq!(names(&conn), ["Zulu", "Zulu 02", "alpha"]);
        // Under one that has gone, it falls back to the end.
        create_after(&mut conn, &input("orphan"), Some(9999)).unwrap();
        assert_eq!(names(&conn), ["Zulu", "Zulu 02", "alpha", "orphan"]);

        reorder(&conn, &[a.id]).unwrap();
        assert_eq!(names(&conn), ["alpha", "Zulu", "Zulu 02", "orphan"]);
    }

    #[test]
    fn create_get_round_trip() {
        let mut conn = open_in_memory().unwrap();
        let made = create(&mut conn, &input("Morning check")).unwrap();
        let got = get(&conn, made.id).unwrap();
        assert_eq!(got.name, "Morning check");
        assert_eq!(got.items.len(), 2);
        assert_eq!(got.startup, STARTUP_OFF);
        assert_eq!(got.created_at, got.updated_at);
    }

    #[test]
    fn a_second_template_with_the_same_name_is_numbered() {
        let mut conn = open_in_memory().unwrap();
        let a = create(&mut conn, &input("Morning check")).unwrap();
        let b = create(&mut conn, &input("Morning check")).unwrap();
        let c = create(&mut conn, &input("Morning check")).unwrap();
        assert_eq!(a.name, "Morning check");
        assert_eq!(b.name, "Morning check 02");
        assert_eq!(c.name, "Morning check 03");
    }

    #[test]
    fn the_number_replaces_the_one_already_on_the_end() {
        // Saving "Morning check 02" again is the same collision one step along,
        // so it continues the run rather than stacking another suffix on it.
        let mut conn = open_in_memory().unwrap();
        create(&mut conn, &input("Morning check")).unwrap();
        create(&mut conn, &input("Morning check")).unwrap();
        let next = create(&mut conn, &input("Morning check 02")).unwrap();
        assert_eq!(next.name, "Morning check 03");
    }

    #[test]
    fn a_number_inside_the_name_is_not_a_suffix() {
        let mut conn = open_in_memory().unwrap();
        create(&mut conn, &input("Server2")).unwrap();
        let second = create(&mut conn, &input("Server2")).unwrap();
        assert_eq!(second.name, "Server2 02");
    }

    #[test]
    fn capitals_do_not_make_a_name_different() {
        let mut conn = open_in_memory().unwrap();
        create(&mut conn, &input("Morning check")).unwrap();
        let second = create(&mut conn, &input("MORNING CHECK")).unwrap();
        assert_eq!(second.name, "MORNING CHECK 02");
    }

    #[test]
    fn saving_a_template_keeps_its_own_name() {
        // The row being written is exempt from the collision check, or every
        // save of an unchanged name would number it one higher.
        let mut conn = open_in_memory().unwrap();
        let made = create(&mut conn, &input("Morning check")).unwrap();
        let saved = update(&mut conn, made.id, &input("Morning check")).unwrap();
        assert_eq!(saved.name, "Morning check");
        let again = update(&mut conn, made.id, &input("Morning check")).unwrap();
        assert_eq!(again.name, "Morning check");
    }

    #[test]
    fn renaming_onto_another_template_is_numbered_too() {
        let mut conn = open_in_memory().unwrap();
        create(&mut conn, &input("Morning check")).unwrap();
        let other = create(&mut conn, &input("Evening check")).unwrap();
        let renamed = update(&mut conn, other.id, &input("Morning check")).unwrap();
        assert_eq!(renamed.name, "Morning check 02");
    }

    #[test]
    fn the_order_of_the_items_is_the_template() {
        // The whole content of a template is a sequence, so a round trip that
        // reordered it would be a round trip that lost it.
        let mut conn = open_in_memory().unwrap();
        let mut i = input("ordered");
        i.items = vec![
            host_item("c", "10.0.0.3"),
            host_item("a", "10.0.0.1"),
            host_item("b", "10.0.0.2"),
        ];
        let made = create(&mut conn, &i).unwrap();
        let names: Vec<String> = get(&conn, made.id)
            .unwrap()
            .items
            .into_iter()
            .map(|it| match it {
                TemplateItem::Host { reference, .. } => reference.label,
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(names, vec!["c", "a", "b"]);
    }

    #[test]
    fn only_one_template_can_open_at_startup() {
        let mut conn = open_in_memory().unwrap();
        let mut first = input("first");
        first.startup = STARTUP_CONNECT.into();
        let a = create(&mut conn, &first).unwrap();
        assert_eq!(startup_template(&conn).unwrap().unwrap().id, a.id);

        let mut second = input("second");
        second.startup = STARTUP_LAUNCH.into();
        let b = create(&mut conn, &second).unwrap();

        assert_eq!(get(&conn, a.id).unwrap().startup, STARTUP_OFF);
        assert_eq!(get(&conn, b.id).unwrap().startup, STARTUP_LAUNCH);
        assert_eq!(startup_template(&conn).unwrap().unwrap().id, b.id);
    }

    #[test]
    fn updating_the_startup_template_does_not_clear_itself() {
        // The clear runs in the same transaction as the write, so the row being
        // written has to be exempt from it or saving the startup template would
        // turn its own setting off.
        let mut conn = open_in_memory().unwrap();
        let mut i = input("only one");
        i.startup = STARTUP_LAUNCH.into();
        let made = create(&mut conn, &i).unwrap();
        i.startup = STARTUP_CONNECT.into();
        let saved = update(&mut conn, made.id, &i).unwrap();
        assert_eq!(saved.startup, STARTUP_CONNECT);
        assert_eq!(startup_template(&conn).unwrap().unwrap().id, made.id);
    }

    #[test]
    fn turning_startup_off_leaves_nothing_to_open() {
        let mut conn = open_in_memory().unwrap();
        let mut i = input("was launching");
        i.startup = STARTUP_LAUNCH.into();
        let made = create(&mut conn, &i).unwrap();
        i.startup = STARTUP_OFF.into();
        update(&mut conn, made.id, &i).unwrap();
        assert!(startup_template(&conn).unwrap().is_none());
    }

    #[test]
    fn name_is_required_and_trimmed() {
        let mut conn = open_in_memory().unwrap();
        let mut bad = input("   ");
        assert!(create(&mut conn, &bad).is_err());
        bad.name = "  padded  ".into();
        assert_eq!(create(&mut conn, &bad).unwrap().name, "padded");
    }

    #[test]
    fn a_bad_colour_or_startup_is_refused() {
        let mut conn = open_in_memory().unwrap();
        let mut bad = input("wrong colour");
        bad.color = "red".into();
        assert!(create(&mut conn, &bad).is_err());

        let mut bad = input("wrong startup");
        bad.startup = "whenever".into();
        assert!(create(&mut conn, &bad).is_err());
    }

    #[test]
    fn an_empty_colour_means_no_colour() {
        let mut conn = open_in_memory().unwrap();
        let mut i = input("plain");
        i.color = String::new();
        assert_eq!(create(&mut conn, &i).unwrap().color, "");
    }

    #[test]
    fn a_template_longer_than_the_ceiling_is_refused() {
        let mut conn = open_in_memory().unwrap();
        let mut i = input("too many");
        i.items = (0..MAX_ITEMS + 1)
            .map(|n| host_item(&format!("h{n}"), &format!("10.0.0.{n}")))
            .collect();
        assert!(create(&mut conn, &i).is_err());
    }

    #[test]
    fn the_same_host_may_appear_more_than_once() {
        // Two tabs on one machine is an ordinary way to work (a tail in one,
        // the work in the other), so a template holds it without complaint.
        let mut conn = open_in_memory().unwrap();
        let mut i = input("twice");
        i.items = vec![host_item("web01", "10.0.0.5"), host_item("web01", "10.0.0.5")];
        assert_eq!(create(&mut conn, &i).unwrap().items.len(), 2);
    }

    #[test]
    fn delete_removes_the_row() {
        let mut conn = open_in_memory().unwrap();
        let made = create(&mut conn, &input("temp")).unwrap();
        assert_eq!(delete(&conn, made.id).unwrap(), 1);
        assert!(get(&conn, made.id).is_err());
        assert_eq!(delete(&conn, made.id).unwrap(), 0);
    }

    fn add_host(conn: &Connection, label: &str, hostname: &str, username: &str) -> i64 {
        hosts::create(
            conn,
            HostInput {
                label: label.into(),
                hostname: hostname.into(),
                port: 22,
                username: username.into(),
                color: "#aabbcc".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn a_reference_resolves_on_its_endpoint() {
        let conn = open_in_memory().unwrap();
        let id = add_host(&conn, "renamed since", "10.0.0.5", "joe");
        let mut items = vec![host_item("web01", "10.0.0.5")];
        resolve_items(&conn, &mut items).unwrap();
        match &items[0] {
            TemplateItem::Host { host_id, .. } => assert_eq!(*host_id, Some(id)),
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_reference_falls_back_to_the_label() {
        // The machine moved to a new address but is still the same host on this
        // side. The label is the weaker match, so it is only consulted when the
        // endpoint finds nothing.
        let conn = open_in_memory().unwrap();
        let id = add_host(&conn, "web01", "192.168.9.9", "joe");
        let mut items = vec![host_item("web01", "10.0.0.5")];
        resolve_items(&conn, &mut items).unwrap();
        match &items[0] {
            TemplateItem::Host { host_id, .. } => assert_eq!(*host_id, Some(id)),
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_reference_that_matches_nothing_stays_a_placeholder() {
        let conn = open_in_memory().unwrap();
        add_host(&conn, "somewhere else", "10.9.9.9", "root");
        let mut items = vec![host_item("web01", "10.0.0.5")];
        resolve_items(&conn, &mut items).unwrap();
        match &items[0] {
            TemplateItem::Host { host_id, reference } => {
                assert_eq!(*host_id, None);
                // The description survives, or there would be nothing on screen
                // to say what the box is waiting for.
                assert_eq!(reference.label, "web01");
                assert_eq!(reference.hostname, "10.0.0.5");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn an_export_carries_what_the_host_is_called_now() {
        let conn = open_in_memory().unwrap();
        let id = add_host(&conn, "web01", "10.0.0.5", "joe");
        hosts::update(
            &conn,
            id,
            HostInput {
                label: "web01-prod".into(),
                hostname: "10.0.0.6".into(),
                port: 2222,
                username: "ops".into(),
                color: "#aabbcc".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap();
        let mut items = vec![TemplateItem::Host {
            host_id: Some(id),
            reference: HostRef {
                label: "web01".into(),
                hostname: "10.0.0.5".into(),
                port: 22,
                username: "joe".into(),
            },
        }];
        refresh_refs(&conn, &mut items).unwrap();
        match &items[0] {
            TemplateItem::Host { reference, .. } => {
                assert_eq!(reference.label, "web01-prod");
                assert_eq!(reference.hostname, "10.0.0.6");
                assert_eq!(reference.port, 2222);
                assert_eq!(reference.username, "ops");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_deleted_host_keeps_the_snapshot_it_was_saved_with() {
        // Refreshing has nothing to read, and the stored reference is the only
        // description of that machine left. Blanking it would turn a repairable
        // placeholder into an unnamed one.
        let conn = open_in_memory().unwrap();
        let id = add_host(&conn, "gone", "10.0.0.7", "joe");
        hosts::delete(&conn, id).unwrap();
        let mut items = vec![TemplateItem::Host {
            host_id: Some(id),
            reference: HostRef {
                label: "gone".into(),
                hostname: "10.0.0.7".into(),
                port: 22,
                username: "joe".into(),
            },
        }];
        refresh_refs(&conn, &mut items).unwrap();
        match &items[0] {
            TemplateItem::Host { reference, .. } => assert_eq!(reference.label, "gone"),
            _ => unreachable!(),
        }
    }

    #[test]
    fn shells_and_profiles_are_left_alone_by_resolution() {
        // They are per-machine by nature and have no database row to match, so
        // both passes must walk straight past them rather than mangling them.
        let conn = open_in_memory().unwrap();
        let mut items = vec![
            TemplateItem::Shell {
                shell_id: "wsl:Ubuntu".into(),
                label: "Ubuntu".into(),
            },
            TemplateItem::Profile {
                profile_id: "abc".into(),
                label: "Broadside dev".into(),
            },
        ];
        let before = items.clone();
        resolve_items(&conn, &mut items).unwrap();
        refresh_refs(&conn, &mut items).unwrap();
        assert_eq!(items, before);
    }

    #[test]
    fn an_item_parses_from_the_json_the_frontend_actually_sends() {
        // Every other test here builds the enum in Rust, which is why the
        // camelCase field names went unnoticed until a save was pressed: a
        // Rust-built value never crosses the wire. This one is the wire. The
        // literal below is what `src/pages/templates/items.ts` produces, so if
        // the two shapes drift again this fails in `cargo test` rather than in
        // a toast.
        let json = r#"[
            {"kind":"host","hostId":7,"ref":{"label":"web01","hostname":"10.0.0.5","port":22,"username":"joe"}},
            {"kind":"host","ref":{"label":"web02","hostname":"10.0.0.6","port":22,"username":"joe"}},
            {"kind":"shell","shellId":"cmd","label":"Command Prompt"},
            {"kind":"profile","profileId":"p-1","label":"Broadside dev"}
        ]"#;
        let items: Vec<TemplateItem> = serde_json::from_str(json).unwrap();
        assert_eq!(items.len(), 4);
        match &items[0] {
            TemplateItem::Host { host_id, reference } => {
                // The id is the half that is easy to lose silently: it is
                // optional, so a name it does not recognise costs the link to
                // the host rather than raising anything.
                assert_eq!(*host_id, Some(7));
                assert_eq!(reference.hostname, "10.0.0.5");
            }
            _ => unreachable!(),
        }
        assert!(matches!(&items[1], TemplateItem::Host { host_id: None, .. }));
        match &items[2] {
            TemplateItem::Shell { shell_id, label } => {
                assert_eq!(shell_id, "cmd");
                assert_eq!(label, "Command Prompt");
            }
            _ => unreachable!(),
        }
        match &items[3] {
            TemplateItem::Profile { profile_id, label } => {
                assert_eq!(profile_id, "p-1");
                assert_eq!(label, "Broadside dev");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn an_item_serialises_back_into_the_shape_the_frontend_reads() {
        // The same boundary in the other direction: `list_templates` hands
        // these straight to the editor, so a snake_case field here is a box
        // that draws as an unresolved placeholder for no visible reason.
        let items = vec![
            TemplateItem::Host {
                host_id: Some(7),
                reference: HostRef {
                    label: "web01".into(),
                    hostname: "10.0.0.5".into(),
                    port: 22,
                    username: "joe".into(),
                },
            },
            TemplateItem::Shell {
                shell_id: "cmd".into(),
                label: "Command Prompt".into(),
            },
            TemplateItem::Profile {
                profile_id: "p-1".into(),
                label: "Broadside dev".into(),
            },
        ];
        let text = serde_json::to_string(&items).unwrap();
        assert!(text.contains("\"hostId\":7"), "{text}");
        assert!(text.contains("\"shellId\":\"cmd\""), "{text}");
        assert!(text.contains("\"profileId\":\"p-1\""), "{text}");
        assert!(!text.contains("_id"), "{text}");
    }
}
