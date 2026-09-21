//! Saved local-shell launch profiles (migration 23): a named shell, a working
//! directory, an optional startup command and a tab colour, launched from the
//! Terminals "+" menu.
//!
//! **Why this is in the database and not localStorage**, where profiles lived
//! until build 69: Settings > Reset everything clears localStorage, and on
//! 2026-08-30 it took every saved profile with it. A profile is something the
//! operator typed and would miss, which makes it content, and content lives
//! here. `commands::settings::reset_app_settings` deletes a named set of
//! preference keys and never a table, and a backup is a snapshot of this file,
//! so profiles are now safe from the reset and backed up for the first time.
//!
//! **`startup_command` is executable.** It is typed into the shell when the
//! profile is launched, with no guard in between. Nothing here tries to judge
//! it, because a harmful command is shaped exactly like a useful one. What
//! keeps it honest is that every writer puts the operator in front of it: the
//! form, an import preview that shows it in full, and a restore that clears it
//! (see `commands::backup::harden_restored_db`). Control characters are refused
//! in every field so that nothing can hide text from that preview.
//!
//! The id is text (a uuid the frontend makes), not an autoincrement integer,
//! because saved templates already name a profile by that string.
//!
//! **No secrets are ever stored here.**

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MAX_ID: usize = 64;
const MAX_LABEL: usize = 200;
const MAX_SHELL_ID: usize = 300;
const MAX_CWD: usize = 1024;
const MAX_STARTUP: usize = 4096;

/// The largest file an import will read. A real export of a few hundred
/// profiles is tens of kilobytes.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// The most profiles one import may add.
const MAX_IMPORT: usize = 500;

/// The `kind` an export file carries, so a later build can add other kinds
/// (preferences) to the same format without mistaking one for the other.
pub const FILE_KIND: &str = "broadside-shell-profiles";
pub const FILE_VERSION: u32 = 1;

/// What an imported `custom:` profile points at when this machine has no custom
/// terminal of the same name. Custom terminal ids start at 1, so this never
/// names a real one, and the launcher strikes the profile through like any
/// other profile whose shell is missing.
pub const UNMATCHED_CUSTOM: &str = "custom:none";

/// Settings key recording that the one-time copy out of localStorage has run.
pub const KEY_LEGACY_IMPORTED: &str = "shell_profiles_legacy_imported";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub shell_id: String,
    pub cwd: String,
    pub startup_command: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfileInput {
    pub label: String,
    pub shell_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub startup_command: String,
    #[serde(default)]
    pub color: String,
}

/// A profile to insert under an id the caller chose.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewShellProfile {
    pub id: String,
    #[serde(flatten)]
    pub input: ShellProfileInput,
}

/// How the one-time copy out of localStorage went.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LegacyImport {
    pub imported: usize,
    /// Rows refused by validation. They stay in localStorage, which the copy
    /// never deletes.
    pub skipped: usize,
}

const SELECT_COLS: &str =
    "id, label, shell_id, cwd, startup_command, color, sort_order, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<ShellProfile> {
    Ok(ShellProfile {
        id: row.get(0)?,
        label: row.get(1)?,
        shell_id: row.get(2)?,
        cwd: row.get(3)?,
        startup_command: row.get(4)?,
        color: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > MAX_ID
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::InvalidInput("bad profile id".into()));
    }
    Ok(())
}

fn text_field(name: &str, value: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::InvalidInput(format!(
            "{name} is longer than {max} characters"
        )));
    }
    // A newline in a startup command would run a second command; an escape
    // sequence could hide text from the import preview; either in a label
    // corrupts a menu. None of them can be typed into the form.
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(format!(
            "{name} can't contain control characters"
        )));
    }
    Ok(())
}

/// Checks and trims a profile. Enforced on every write, including both kinds of
/// import, so a stored row is always one the form could have produced.
fn normalize(input: &ShellProfileInput) -> AppResult<ShellProfileInput> {
    let out = ShellProfileInput {
        label: input.label.trim().to_string(),
        shell_id: input.shell_id.trim().to_string(),
        cwd: input.cwd.trim().to_string(),
        startup_command: input.startup_command.trim().to_string(),
        color: input.color.trim().to_string(),
    };
    if out.label.is_empty() {
        return Err(AppError::InvalidInput("name is required".into()));
    }
    if out.shell_id.is_empty() {
        return Err(AppError::InvalidInput("shell is required".into()));
    }
    text_field("name", &out.label, MAX_LABEL)?;
    text_field("shell", &out.shell_id, MAX_SHELL_ID)?;
    text_field("working directory", &out.cwd, MAX_CWD)?;
    text_field("startup command", &out.startup_command, MAX_STARTUP)?;
    let color_ok = out.color.is_empty()
        || (out.color.len() == 7
            && out.color.starts_with('#')
            && out.color[1..].chars().all(|c| c.is_ascii_hexdigit()));
    if !color_ok {
        return Err(AppError::InvalidInput(
            "colour must be empty or #rrggbb".into(),
        ));
    }
    Ok(out)
}

pub fn list(conn: &Connection) -> AppResult<Vec<ShellProfile>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM shell_profiles
          ORDER BY sort_order ASC, created_at ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<ShellProfile> {
    let sql = format!("SELECT {SELECT_COLS} FROM shell_profiles WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or_else(|| AppError::InvalidInput("that profile no longer exists".into()))
}

fn insert_row(
    conn: &Connection,
    id: &str,
    input: &ShellProfileInput,
    sort_order: i64,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO shell_profiles
             (id, label, shell_id, cwd, startup_command, color, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            input.label,
            input.shell_id,
            input.cwd,
            input.startup_command,
            input.color,
            sort_order,
            now
        ],
    )?;
    Ok(())
}

fn next_sort_order(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM shell_profiles",
        [],
        |r| r.get(0),
    )?)
}

/// Creates a profile. With `after`, it goes directly below that profile (a
/// duplicate turns up where the operator was looking); otherwise at the end.
pub fn create(
    conn: &Connection,
    id: &str,
    input: &ShellProfileInput,
    after: Option<&str>,
) -> AppResult<ShellProfile> {
    validate_id(id)?;
    let input = normalize(input)?;
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let anchor: Option<i64> = match after {
        Some(a) => tx
            .query_row(
                "SELECT sort_order FROM shell_profiles WHERE id = ?1",
                params![a],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    let position = match anchor {
        Some(order) => {
            tx.execute(
                "UPDATE shell_profiles SET sort_order = sort_order + 1 WHERE sort_order > ?1",
                params![order],
            )?;
            order + 1
        }
        None => next_sort_order(&tx)?,
    };
    insert_row(&tx, id, &input, position, &now)?;
    tx.commit()?;
    get(conn, id)
}

pub fn update(conn: &Connection, id: &str, input: &ShellProfileInput) -> AppResult<ShellProfile> {
    let input = normalize(input)?;
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "UPDATE shell_profiles
            SET label = ?1, shell_id = ?2, cwd = ?3, startup_command = ?4, color = ?5,
                updated_at = ?6
          WHERE id = ?7",
        params![
            input.label,
            input.shell_id,
            input.cwd,
            input.startup_command,
            input.color,
            now,
            id
        ],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput("that profile no longer exists".into()));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM shell_profiles WHERE id = ?1", params![id])?)
}

/// Points every profile that names a custom terminal at [`UNMATCHED_CUSTOM`],
/// and says how many were changed.
///
/// For the restore, which deletes every custom terminal: see the call site in
/// `commands/backup.rs` for why a dangling `custom:<id>` cannot be left behind.
pub fn orphan_custom_shells(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE shell_profiles SET shell_id = ?1          WHERE shell_id LIKE 'custom:%' AND shell_id <> ?1",
        params![UNMATCHED_CUSTOM],
    )?)
}

/// Rewrites the order: `ids` first, in the order given, then any profile the
/// list did not mention, in its existing order. Tolerant of a stale list (a
/// profile deleted or added elsewhere in the meantime) rather than refusing the
/// drag the operator just made. Dense integers from 0.
pub fn reorder(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let current: Vec<String> = list(&tx)?.into_iter().map(|p| p.id).collect();
    let mut order: Vec<&String> = Vec::with_capacity(current.len());
    for id in ids {
        if current.contains(id) && !order.contains(&id) {
            order.push(id);
        }
    }
    for id in &current {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    for (i, id) in order.iter().enumerate() {
        tx.execute(
            "UPDATE shell_profiles SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The one-time copy of the profiles build 68 and earlier kept in localStorage.
///
/// Runs at most once per database: it records [`KEY_LEGACY_IMPORTED`], and it
/// does nothing if the table already holds anything, so a second window, a
/// reload or a stale copy of localStorage can never duplicate the list. Ids and
/// order are kept, because saved templates name a profile by its id. A row that
/// fails validation is skipped and counted rather than failing the rest: the
/// localStorage value is never deleted, so a skipped row is not lost.
pub fn import_legacy(conn: &Connection, rows: &[NewShellProfile]) -> AppResult<LegacyImport> {
    let tx = conn.unchecked_transaction()?;
    let done = crate::db::settings::get_bool(&tx, KEY_LEGACY_IMPORTED, false)?;
    let existing: i64 = tx.query_row("SELECT COUNT(*) FROM shell_profiles", [], |r| r.get(0))?;
    let mut result = LegacyImport { imported: 0, skipped: 0 };
    if !done && existing == 0 {
        let now = Utc::now().to_rfc3339();
        let mut order = 0i64;
        for row in rows {
            let ok = validate_id(&row.id).and_then(|_| normalize(&row.input));
            let taken = tx
                .query_row(
                    "SELECT 1 FROM shell_profiles WHERE id = ?1",
                    params![row.id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            match ok {
                Ok(input) if !taken => {
                    insert_row(&tx, &row.id, &input, order, &now)?;
                    order += 1;
                    result.imported += 1;
                }
                _ => result.skipped += 1,
            }
        }
    }
    crate::db::settings::set(&tx, KEY_LEGACY_IMPORTED, "true")?;
    tx.commit()?;
    Ok(result)
}

/// Adds profiles from an import, after the ones already saved, in the order
/// given. All or nothing: every row is checked before any is written.
pub fn import_many(conn: &Connection, rows: &[NewShellProfile]) -> AppResult<usize> {
    if rows.len() > MAX_IMPORT {
        return Err(AppError::InvalidInput(format!(
            "an import can add at most {MAX_IMPORT} profiles"
        )));
    }
    let mut checked = Vec::with_capacity(rows.len());
    for row in rows {
        validate_id(&row.id)?;
        checked.push((row.id.as_str(), normalize(&row.input)?));
    }
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let mut order = next_sort_order(&tx)?;
    for (id, input) in &checked {
        insert_row(&tx, id, input, order, &now)?;
        order += 1;
    }
    tx.commit()?;
    Ok(checked.len())
}

// --- Export and import files -------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileFile {
    kind: String,
    version: u32,
    profiles: Vec<FileProfile>,
}

/// One profile as it travels. No id and no timestamps: an import always makes
/// new rows, and the order is the array's.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileProfile {
    label: String,
    shell_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    startup_command: String,
    #[serde(default)]
    color: String,
    /// For a `custom:<id>` shell, that custom terminal's name. Ids are per
    /// machine, so an import matches by this name instead, and never trusts the
    /// number: id 1 on the other machine is whatever id 1 is here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_terminal: Option<String>,
}

/// Every profile as an export file, in launcher order, and how many there are.
/// The caller writes it, outside the database lock.
pub fn export_json(conn: &Connection) -> AppResult<(String, usize)> {
    let profiles = list(conn)?;
    let customs = crate::db::custom_terminals::list(conn)?;
    let file = ProfileFile {
        kind: FILE_KIND.into(),
        version: FILE_VERSION,
        profiles: profiles
            .iter()
            .map(|p| FileProfile {
                label: p.label.clone(),
                shell_id: p.shell_id.clone(),
                cwd: p.cwd.clone(),
                startup_command: p.startup_command.clone(),
                color: p.color.clone(),
                custom_terminal: p
                    .shell_id
                    .strip_prefix("custom:")
                    .and_then(|raw| raw.parse::<i64>().ok())
                    .and_then(|id| customs.iter().find(|t| t.id == id))
                    .map(|t| t.label.clone()),
            })
            .collect(),
    };
    Ok((serde_json::to_string_pretty(&file)?, profiles.len()))
}

/// Reads an import file's text, refusing anything too large to be an export.
/// Needs no database, so the command runs it before taking the lock.
pub fn read_file_text(path: &str) -> AppResult<String> {
    let size = std::fs::metadata(path)
        .map_err(|e| AppError::InvalidInput(format!("could not read the file: {e}")))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(
            "this file is too large to be a profile export".into(),
        ));
    }
    std::fs::read_to_string(path)
        .map_err(|e| AppError::InvalidInput(format!("could not read the file: {e}")))
}

/// Parses an export file for the import preview. Writes nothing.
///
/// The whole file is refused if any profile in it is invalid, naming which one,
/// the way a broken skill file is: a half-imported list is harder to reason
/// about than a clear "fix profile 3". A `custom:` shell is re-pointed at this
/// machine's custom terminal of the same name, or at [`UNMATCHED_CUSTOM`].
pub fn parse_file(conn: &Connection, text: &str) -> AppResult<Vec<ShellProfileInput>> {
    let file: ProfileFile = serde_json::from_str(text).map_err(|_| {
        AppError::InvalidInput("this isn't a Broadside shell profile file".into())
    })?;
    if file.kind != FILE_KIND {
        return Err(AppError::InvalidInput(
            "this isn't a Broadside shell profile file".into(),
        ));
    }
    if file.version > FILE_VERSION {
        return Err(AppError::InvalidInput(format!(
            "this profile file is version {}, and this build reads up to version {FILE_VERSION}: it was made by a newer Broadside, so update this one to import it",
            file.version
        )));
    }
    if file.profiles.len() > MAX_IMPORT {
        return Err(AppError::InvalidInput(format!(
            "this file holds {} profiles, and an import can add at most {MAX_IMPORT}",
            file.profiles.len()
        )));
    }
    let customs = crate::db::custom_terminals::list(conn)?;
    let mut out = Vec::with_capacity(file.profiles.len());
    for (i, p) in file.profiles.into_iter().enumerate() {
        let shell_id = if p.shell_id.trim().starts_with("custom:") {
            p.custom_terminal
                .as_deref()
                .map(str::trim)
                .and_then(|name| {
                    customs
                        .iter()
                        .find(|t| t.label.trim().eq_ignore_ascii_case(name))
                })
                .map(|t| format!("custom:{}", t.id))
                .unwrap_or_else(|| UNMATCHED_CUSTOM.to_string())
        } else {
            p.shell_id
        };
        let input = ShellProfileInput {
            label: p.label,
            shell_id,
            cwd: p.cwd,
            startup_command: p.startup_command,
            color: p.color,
        };
        let input = normalize(&input).map_err(|e| {
            AppError::InvalidInput(format!("profile {} in the file: {e}", i + 1))
        })?;
        out.push(input);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::bootstrap(&c).unwrap();
        c
    }

    fn input(label: &str) -> ShellProfileInput {
        ShellProfileInput {
            label: label.into(),
            shell_id: "pwsh".into(),
            cwd: r"C:\src".into(),
            startup_command: "claude".into(),
            color: String::new(),
        }
    }

    fn labels(c: &Connection) -> Vec<String> {
        list(c).unwrap().into_iter().map(|p| p.label).collect()
    }

    #[test]
    fn round_trips_and_trims() {
        let c = conn();
        let mut i = input("  Dev  ");
        i.color = "#3b82f6".into();
        let made = create(&c, "a-1", &i, None).unwrap();
        assert_eq!(made.label, "Dev");
        assert_eq!(made.color, "#3b82f6");
        assert_eq!(get(&c, "a-1").unwrap(), made);
        let mut j = input("Dev 2");
        j.startup_command = String::new();
        let changed = update(&c, "a-1", &j).unwrap();
        assert_eq!(changed.label, "Dev 2");
        assert_eq!(changed.startup_command, "");
        assert_eq!(delete(&c, "a-1").unwrap(), 1);
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn refuses_what_the_form_could_not_produce() {
        let c = conn();
        assert!(create(&c, "x", &input("   "), None).is_err());
        let mut i = input("X");
        i.startup_command = "echo hi\nrm -rf ~".into();
        let err = create(&c, "x", &i, None).unwrap_err().to_string();
        assert!(err.contains("control characters"), "got: {err}");
        let mut i = input("X");
        i.startup_command = "echo \u{1b}[8mhidden".into();
        assert!(create(&c, "x", &i, None).is_err());
        let mut i = input("X");
        i.color = "red".into();
        assert!(create(&c, "x", &i, None).is_err());
        assert!(create(&c, "bad id!", &input("X"), None).is_err());
        let mut i = input("X");
        i.startup_command = "a".repeat(MAX_STARTUP + 1);
        assert!(create(&c, "x", &i, None).is_err());
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn create_after_lands_directly_below() {
        let c = conn();
        create(&c, "a", &input("A"), None).unwrap();
        create(&c, "b", &input("B"), None).unwrap();
        create(&c, "c", &input("C"), None).unwrap();
        create(&c, "a2", &input("A (copy)"), Some("a")).unwrap();
        assert_eq!(labels(&c), ["A", "A (copy)", "B", "C"]);
        // An anchor that has gone puts it at the end rather than failing.
        create(&c, "z", &input("Z"), Some("gone")).unwrap();
        assert_eq!(labels(&c).last().unwrap(), "Z");
    }

    #[test]
    fn reorder_puts_the_rest_after_and_ignores_strangers() {
        let c = conn();
        for id in ["a", "b", "c", "d"] {
            create(&c, id, &input(&id.to_uppercase()), None).unwrap();
        }
        reorder(&c, &["c".into(), "gone".into(), "a".into(), "c".into()]).unwrap();
        assert_eq!(labels(&c), ["C", "A", "B", "D"]);
        let orders: Vec<i64> = list(&c).unwrap().iter().map(|p| p.sort_order).collect();
        assert_eq!(orders, [0, 1, 2, 3]);
    }

    fn legacy(id: &str, label: &str) -> NewShellProfile {
        NewShellProfile { id: id.into(), input: input(label) }
    }

    #[test]
    fn legacy_import_keeps_ids_and_order_and_runs_once() {
        let c = conn();
        let mut bad = legacy("bad", "Bad");
        bad.input.color = "nope".into();
        let rows = vec![legacy("u-2", "Second"), bad, legacy("u-1", "First"), legacy("u-1", "Dup")];
        let r = import_legacy(&c, &rows).unwrap();
        assert_eq!(r, LegacyImport { imported: 2, skipped: 2 });
        assert_eq!(labels(&c), ["Second", "First"]);
        assert_eq!(get(&c, "u-1").unwrap().label, "First");
        // Delete everything, then run it again: the flag stops it re-filling.
        delete(&c, "u-1").unwrap();
        delete(&c, "u-2").unwrap();
        let again = import_legacy(&c, &rows).unwrap();
        assert_eq!(again, LegacyImport { imported: 0, skipped: 0 });
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn legacy_import_never_touches_a_table_that_has_rows() {
        let c = conn();
        create(&c, "mine", &input("Mine"), None).unwrap();
        let r = import_legacy(&c, &[legacy("old", "Old")]).unwrap();
        assert_eq!(r.imported, 0);
        assert_eq!(labels(&c), ["Mine"]);
    }

    #[test]
    fn legacy_import_takes_a_real_localstorage_blob() {
        // The shape build 68 wrote, including a profile saved before colours
        // existed (no `color` key at all), as the frontend passes it on.
        // r## because the colour's `"#` would end an r# string.
        let blob = r##"[
            {"id":"6f1c2a9e-0000-4000-8000-000000000001","label":"Broadside dev","shellId":"pwsh","cwd":"C:\\Users\\me\\Broadside","startupCommand":"claude"},
            {"id":"6f1c2a9e-0000-4000-8000-000000000002","label":"Old distro","shellId":"wsl:Ubuntu-18.04","cwd":"","startupCommand":"","color":"#ef4444"}
        ]"##;
        let rows: Vec<NewShellProfile> = serde_json::from_str(blob).unwrap();
        let c = conn();
        let r = import_legacy(&c, &rows).unwrap();
        assert_eq!(r, LegacyImport { imported: 2, skipped: 0 });
        let got = list(&c).unwrap();
        assert_eq!(got[0].color, "");
        assert_eq!(got[1].shell_id, "wsl:Ubuntu-18.04");
    }

    #[test]
    fn import_many_is_all_or_nothing_and_appends() {
        let c = conn();
        create(&c, "a", &input("A"), None).unwrap();
        let mut bad = legacy("n2", "Bad");
        bad.input.label = String::new();
        assert!(import_many(&c, &[legacy("n1", "New"), bad]).is_err());
        assert_eq!(labels(&c), ["A"]);
        assert_eq!(import_many(&c, &[legacy("n1", "New"), legacy("n2", "Newer")]).unwrap(), 2);
        assert_eq!(labels(&c), ["A", "New", "Newer"]);
    }

    #[test]
    fn export_then_read_round_trips_in_order() {
        let c = conn();
        let mut b = input("B");
        b.color = "#10b981".into();
        create(&c, "a", &input("A"), None).unwrap();
        create(&c, "b", &b, None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let path = path.to_string_lossy().into_owned();
        let (json, count) = export_json(&c).unwrap();
        assert_eq!(count, 2);
        std::fs::write(&path, json).unwrap();
        let back = parse_file(&c, &read_file_text(&path).unwrap()).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0], input("A"));
        assert_eq!(back[1], b);
    }

    #[test]
    fn read_refuses_other_files_and_names_the_bad_row() {
        let c = conn();
        assert!(parse_file(&c, r#"{"hello":true}"#).is_err());
        assert!(parse_file(&c, r#"{"kind":"broadside-skill","version":1,"profiles":[]}"#).is_err());
        let newer = parse_file(&c, r#"{"kind":"broadside-shell-profiles","version":99,"profiles":[]}"#)
            .unwrap_err()
            .to_string();
        assert!(newer.contains("newer Broadside"), "got: {newer}");
        let bad = parse_file(
            &c,
            r#"{"kind":"broadside-shell-profiles","version":1,"profiles":[
                {"label":"Fine","shellId":"cmd"},
                {"label":"Sneaky","shellId":"cmd","startupCommand":"dir\r\ndel /q *"}
            ]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(bad.contains("profile 2"), "got: {bad}");
    }

    #[test]
    fn a_custom_shell_is_matched_by_name_never_by_id() {
        let c = conn();
        // Id 1 on this machine is "PowerShell 7"; the file's custom:1 was
        // Git Bash on another machine, so it must not be pointed at id 1.
        c.execute(
            "INSERT INTO custom_terminals (label, exe_path, args_json, family, sort_order, created_at, updated_at)
             VALUES ('PowerShell 7', 'C:\\pwsh.exe', '[]', 'powershell', 0, 'now', 'now'),
                    ('Git Bash', 'C:\\bash.exe', '[]', 'posix', 1, 'now', 'now')",
            [],
        )
        .unwrap();
        let got = parse_file(
            &c,
            r#"{"kind":"broadside-shell-profiles","version":1,"profiles":[
                {"label":"Bash","shellId":"custom:1","customTerminal":"git bash"},
                {"label":"Gone","shellId":"custom:1","customTerminal":"MSYS2"},
                {"label":"No name","shellId":"custom:1"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(got[0].shell_id, "custom:2");
        assert_eq!(got[1].shell_id, UNMATCHED_CUSTOM);
        assert_eq!(got[2].shell_id, UNMATCHED_CUSTOM);
    }
}
