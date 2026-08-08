//! User-defined terminal applications (migration 16): Git Bash, MSYS2, Cygwin,
//! or anything else the operator would rather launch than the shells Broadside
//! detects on its own.
//!
//! **Why this is in the database and not a localStorage UI pref** (which is
//! where the neighbouring launcher prefs live): a row here names an executable
//! the app will spawn. Keeping the definition backend-side means the frontend
//! only ever sends an id, so an arbitrary executable path cannot cross the IPC
//! boundary and become a process. The path is validated once, here, at write
//! time; `crate::local::build_command` then resolves an id to a stored row.
//!
//! Arguments are stored as a JSON array and passed as argv. Nothing is ever
//! handed to a shell to re-parse, so there is no quoting to get wrong.
//!
//! **No secrets are ever stored here.**

use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Which shell language a custom terminal speaks. It decides the launcher icon
/// and, more importantly, which PTY Broadcast family the session joins, a
/// session belonging to no family would silently vanish from every broadcast
/// panel.
pub const FAMILY_POSIX: &str = "posix";
pub const FAMILY_POWERSHELL: &str = "powershell";
pub const FAMILY_CMD: &str = "cmd";

const FAMILIES: [&str; 3] = [FAMILY_POSIX, FAMILY_POWERSHELL, FAMILY_CMD];

/// Only `.exe` is accepted. `.bat` / `.cmd` are not executables in their own
/// right: launching one means handing a command line to `cmd.exe` to interpret,
/// which is exactly the shell re-parsing this design avoids. If those are ever
/// wanted they need their own deliberate design, not a widened extension list.
const ALLOWED_EXT: &str = "exe";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTerminal {
    pub id: i64,
    pub label: String,
    pub exe_path: String,
    /// Command-line arguments, in order. Passed as argv.
    pub args: Vec<String>,
    pub family: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTerminalInput {
    pub label: String,
    pub exe_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub family: String,
}

const SELECT_COLS: &str =
    "id, label, exe_path, args_json, family, sort_order, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<CustomTerminal> {
    let args_json: String = row.get(3)?;
    Ok(CustomTerminal {
        id: row.get(0)?,
        label: row.get(1)?,
        exe_path: row.get(2)?,
        // A row whose args blob somehow isn't an array degrades to no arguments
        // rather than making the terminal unlaunchable.
        args: serde_json::from_str(&args_json).unwrap_or_default(),
        family: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Everything that must hold before a row can name a process we will spawn.
/// Enforced on write only: a stored row is trusted at launch precisely because
/// it could not have been stored without passing this.
fn validate(input: &CustomTerminalInput) -> AppResult<()> {
    let label = input.label.trim();
    if label.is_empty() {
        return Err(AppError::InvalidInput("name is required".into()));
    }
    // The label becomes a tab title and a menu entry; control characters in it
    // would corrupt both.
    if label.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(
            "name can't contain control characters".into(),
        ));
    }

    let exe = input.exe_path.trim();
    if exe.is_empty() {
        return Err(AppError::InvalidInput("program is required".into()));
    }
    if exe.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(
            "program path can't contain control characters".into(),
        ));
    }
    let path = Path::new(exe);
    // Absolute only: a relative path would resolve against whatever working
    // directory the app happened to have, which is not a decision the operator
    // is making when they type a path.
    if !path.is_absolute() {
        return Err(AppError::InvalidInput(
            "program path must be a full path, e.g. C:\\Program Files\\Git\\bin\\bash.exe".into(),
        ));
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case(ALLOWED_EXT) => {}
        _ => {
            return Err(AppError::InvalidInput(
                "program must be an .exe".into(),
            ))
        }
    }
    // Checked at save time so a typo is caught while the operator is looking at
    // the form. It is deliberately NOT re-checked at launch: a program on a
    // drive that is temporarily absent should fail with the shell's own error,
    // not silently disappear from the launcher.
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "no such program: {exe}"
        )));
    }

    if !FAMILIES.contains(&input.family.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "unknown terminal family: {}",
            input.family
        )));
    }
    if input.args.iter().any(|a| a.contains('\0')) {
        return Err(AppError::InvalidInput(
            "arguments can't contain null bytes".into(),
        ));
    }
    Ok(())
}

pub fn list(conn: &Connection) -> AppResult<Vec<CustomTerminal>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM custom_terminals
          ORDER BY sort_order ASC, label COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<CustomTerminal> {
    let sql = format!("SELECT {SELECT_COLS} FROM custom_terminals WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row)
        .optional()?
        .ok_or_else(|| AppError::InvalidInput(format!("no such custom terminal: {id}")))
}

pub fn create(conn: &Connection, input: &CustomTerminalInput) -> AppResult<CustomTerminal> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    let args_json = serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO custom_terminals
             (label, exe_path, args_json, family, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4,
                 (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM custom_terminals), ?5, ?6)",
        params![
            input.label.trim(),
            input.exe_path.trim(),
            args_json,
            input.family,
            now,
            now
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(
    conn: &Connection,
    id: i64,
    input: &CustomTerminalInput,
) -> AppResult<CustomTerminal> {
    validate(input)?;
    let now = Utc::now().to_rfc3339();
    let args_json = serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".into());
    let changed = conn.execute(
        "UPDATE custom_terminals
            SET label = ?1, exe_path = ?2, args_json = ?3, family = ?4, updated_at = ?5
          WHERE id = ?6",
        params![
            input.label.trim(),
            input.exe_path.trim(),
            args_json,
            input.family,
            now,
            id
        ],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidInput(format!(
            "no such custom terminal: {id}"
        )));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<usize> {
    Ok(conn.execute(
        "DELETE FROM custom_terminals WHERE id = ?1",
        params![id],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::bootstrap(&c).unwrap();
        c
    }

    /// A real .exe to point at, so the is_file() check can pass in tests.
    fn a_real_exe() -> String {
        let mut p = std::env::current_exe().unwrap();
        // The test binary itself is an .exe on Windows; on other platforms give
        // it one so the extension check is exercised the same way.
        if p.extension().and_then(|e| e.to_str()) != Some("exe") {
            p.set_extension("exe");
            std::fs::write(&p, b"not really an exe").unwrap();
        }
        p.to_string_lossy().into_owned()
    }

    fn input(label: &str) -> CustomTerminalInput {
        CustomTerminalInput {
            label: label.into(),
            exe_path: a_real_exe(),
            args: vec!["--login".into(), "-i".into()],
            family: FAMILY_POSIX.into(),
        }
    }

    #[test]
    fn round_trips_a_terminal_with_its_args() {
        let c = conn();
        let made = create(&c, &input("Git Bash")).unwrap();
        assert_eq!(made.label, "Git Bash");
        assert_eq!(made.args, vec!["--login", "-i"]);
        let back = get(&c, made.id).unwrap();
        assert_eq!(back.args, made.args);
        assert_eq!(list(&c).unwrap().len(), 1);
        delete(&c, made.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn rejects_a_relative_path() {
        let c = conn();
        let mut i = input("Bad");
        i.exe_path = "bash.exe".into();
        let err = create(&c, &i).unwrap_err().to_string();
        assert!(err.contains("full path"), "got: {err}");
    }

    #[test]
    fn rejects_a_non_exe() {
        let c = conn();
        let mut i = input("Bad");
        let mut p = std::path::PathBuf::from(a_real_exe());
        p.set_extension("bat");
        std::fs::write(&p, b"echo hi").unwrap();
        i.exe_path = p.to_string_lossy().into_owned();
        let err = create(&c, &i).unwrap_err().to_string();
        assert!(err.contains(".exe"), "got: {err}");
    }

    #[test]
    fn rejects_a_path_that_does_not_exist() {
        let c = conn();
        let mut i = input("Bad");
        i.exe_path = r"C:\definitely\not\here\nope.exe".into();
        let err = create(&c, &i).unwrap_err().to_string();
        assert!(err.contains("no such program"), "got: {err}");
    }

    #[test]
    fn rejects_an_unknown_family_and_a_blank_label() {
        let c = conn();
        let mut i = input("X");
        i.family = "elvish".into();
        assert!(create(&c, &i).is_err());

        let mut i = input("   ");
        i.family = FAMILY_POSIX.into();
        assert!(create(&c, &i).is_err());
    }

    #[test]
    fn rejects_control_characters_in_the_label() {
        // The label becomes a tab title; a newline in it would corrupt the UI.
        let c = conn();
        let mut i = input("Git\nBash");
        i.family = FAMILY_POSIX.into();
        let err = create(&c, &i).unwrap_err().to_string();
        assert!(err.contains("control characters"), "got: {err}");
    }

    #[test]
    fn update_revalidates() {
        let c = conn();
        let made = create(&c, &input("Git Bash")).unwrap();
        let mut i = input("Git Bash");
        i.exe_path = "relative.exe".into();
        assert!(update(&c, made.id, &i).is_err());
        // The stored row is untouched by a rejected update.
        assert_eq!(get(&c, made.id).unwrap().exe_path, made.exe_path);
    }
}
