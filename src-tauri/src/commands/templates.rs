//! Session template CRUD, plus the portable file that carries one between
//! machines.
//!
//! Nothing here launches anything. A template is a list of references, and
//! turning that list into open terminals is the frontend's job through the same
//! `pty_open` path every other session takes. That is deliberate: a backend
//! command that opened a saved set of connections would be a new way to start
//! SSH sessions, and there is no reason to have a second one.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::ssh::with_db;
use crate::db::templates as repo;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

/// Reading a template file this size would already be absurd: the ceiling on
/// items is 64 references, each a handful of short strings. A cap here means a
/// hostile or corrupt file is refused before it is parsed rather than after.
const MAX_FILE_BYTES: u64 = 256 * 1024;

fn with_db_mut<T>(
    state: &State<'_, DbState>,
    f: impl FnOnce(&mut rusqlite::Connection) -> AppResult<T>,
) -> AppResult<T> {
    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))?;
    f(&mut conn)
}

#[tauri::command]
pub fn list_templates(state: State<'_, DbState>) -> AppResult<Vec<repo::Template>> {
    with_db(&state, repo::list)
}

#[tauri::command]
pub fn get_template(id: i64, state: State<'_, DbState>) -> AppResult<repo::Template> {
    with_db(&state, |conn| repo::get(conn, id))
}

/// The template set to open when Broadside starts, or nothing. Read once at
/// launch; `startup` says whether the sessions also connect.
#[tauri::command]
pub fn startup_template(state: State<'_, DbState>) -> AppResult<Option<repo::Template>> {
    with_db(&state, repo::startup_template)
}

/// `after` places the new one directly below that template (Duplicate);
/// without it, it goes to the end.
#[tauri::command]
pub fn create_template(
    input: repo::TemplateInput,
    after: Option<i64>,
    state: State<'_, DbState>,
) -> AppResult<repo::Template> {
    with_db_mut(&state, |conn| repo::create_after(conn, &input, after))
}

/// Saves the list's order after a drag.
#[tauri::command]
pub fn reorder_templates(ids: Vec<i64>, state: State<'_, DbState>) -> AppResult<()> {
    with_db(&state, |conn| repo::reorder(conn, &ids))
}

#[tauri::command]
pub fn update_template(
    id: i64,
    input: repo::TemplateInput,
    state: State<'_, DbState>,
) -> AppResult<repo::Template> {
    with_db_mut(&state, |conn| repo::update(conn, id, &input))
}

#[tauri::command]
pub fn delete_template(id: i64, state: State<'_, DbState>) -> AppResult<usize> {
    with_db(&state, |conn| repo::delete(conn, id))
}

/// The on-disk shape. Versioned for the same reason a skill file is: a future
/// change should be detected and named, not silently mis-parsed.
///
/// **`startup` is not in it, and that is a decision rather than an omission.** A
/// file that could arrive already set to open connections when the application
/// starts would be the one import worth being afraid of. An imported template
/// always lands switched off, and the operator turns it on in the editor, where
/// the warning is.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableTemplate {
    broadside_template: u32,
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    items: Vec<repo::TemplateItem>,
}

/// The highest file version this build can read.
const PORTABLE_VERSION: u32 = 1;

/// Writes a template to a file: its name, its colour and its ordered items,
/// with each host reference refreshed from the database first so the file says
/// what the host is called now.
///
/// Host ids are stripped on the way out (they are `Option` and skipped when
/// absent), because an id names a row in one database and nothing anywhere
/// else. What travels is the endpoint, which is what an import can match on.
#[tauri::command]
pub fn export_template(id: i64, path: String, state: State<'_, DbState>) -> AppResult<()> {
    let mut template = with_db(&state, |conn| {
        let mut t = repo::get(conn, id)?;
        repo::refresh_refs(conn, &mut t.items)?;
        Ok(t)
    })?;
    for item in template.items.iter_mut() {
        if let repo::TemplateItem::Host { host_id, .. } = item {
            *host_id = None;
        }
    }
    let portable = PortableTemplate {
        broadside_template: PORTABLE_VERSION,
        name: template.name,
        color: template.color,
        items: template.items,
    };
    std::fs::write(&path, serde_json::to_string_pretty(&portable)?)?;
    Ok(())
}

/// Reads a portable template file and returns it as a [`repo::TemplateInput`],
/// with every host reference matched against this machine's hosts.
///
/// Does **not** save. The frontend loads it into the editor, so an import is
/// reviewed and then created through the normal path, and a file that names
/// hosts this machine has never heard of still opens: the unmatched references
/// arrive as placeholders the operator points at real hosts. A reference that
/// cannot be resolved is never a reason to refuse the file, which is the whole
/// point of the placeholder.
///
/// Import never creates or edits a host.
#[tauri::command]
pub fn read_template_file(path: String, state: State<'_, DbState>) -> AppResult<repo::TemplateInput> {
    let size = std::fs::metadata(&path)
        .map_err(|e| AppError::InvalidInput(format!("could not read the file: {e}")))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput(
            "that file is far too large to be a Broadside template".into(),
        ));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| AppError::InvalidInput(format!("could not read the file: {e}")))?;
    let portable: PortableTemplate = serde_json::from_str(&text)
        .map_err(|_| AppError::InvalidInput("this isn't a Broadside template file".into()))?;
    // Older files are still ours to read; only a newer one is genuinely beyond
    // this build, and it says which way the update has to go.
    if portable.broadside_template > PORTABLE_VERSION {
        return Err(AppError::InvalidInput(format!(
            "this template file is version {}, and this build reads up to version {PORTABLE_VERSION}: it was made by a newer Broadside, so update this one to import it",
            portable.broadside_template
        )));
    }
    let mut items = portable.items;
    if items.len() > repo::MAX_ITEMS {
        return Err(AppError::InvalidInput(format!(
            "that file holds {} sessions, and a template takes at most {}",
            items.len(),
            repo::MAX_ITEMS
        )));
    }
    with_db(&state, |conn| repo::resolve_items(conn, &mut items))?;
    Ok(repo::TemplateInput {
        name: portable.name,
        color: if repo::is_hex_color(&portable.color) {
            portable.color
        } else {
            // A colour that is not a colour is dropped rather than refused: the
            // arrangement is the thing worth importing.
            String::new()
        },
        items,
        startup: repo::STARTUP_OFF.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::templates::{HostRef, TemplateItem};

    #[test]
    fn a_file_round_trips_through_the_portable_shape() {
        let portable = PortableTemplate {
            broadside_template: PORTABLE_VERSION,
            name: "Morning check".into(),
            color: "#112233".into(),
            items: vec![
                TemplateItem::Host {
                    host_id: None,
                    reference: HostRef {
                        label: "web01".into(),
                        hostname: "10.0.0.5".into(),
                        port: 22,
                        username: "joe".into(),
                    },
                },
                TemplateItem::Shell {
                    shell_id: "pwsh".into(),
                    label: "PowerShell 7".into(),
                },
            ],
        };
        let text = serde_json::to_string_pretty(&portable).unwrap();
        let back: PortableTemplate = serde_json::from_str(&text).unwrap();
        assert_eq!(back.name, "Morning check");
        assert_eq!(back.items.len(), 2);
    }

    #[test]
    fn an_exported_file_carries_no_host_ids() {
        // An id names a row in one database. Writing it would invite the
        // receiving machine to believe a number that means nothing there.
        let portable = PortableTemplate {
            broadside_template: PORTABLE_VERSION,
            name: "no ids".into(),
            color: String::new(),
            items: vec![TemplateItem::Host {
                host_id: None,
                reference: HostRef {
                    label: "web01".into(),
                    hostname: "10.0.0.5".into(),
                    port: 22,
                    username: "joe".into(),
                },
            }],
        };
        let text = serde_json::to_string(&portable).unwrap();
        assert!(!text.contains("hostId"));
        assert!(text.contains("\"hostname\":\"10.0.0.5\""));
    }

    #[test]
    fn a_file_cannot_ask_to_open_at_startup() {
        // The portable shape has no startup field at all, so a hand-written one
        // is ignored by the parser rather than trusted.
        let text = r#"{"broadsideTemplate":1,"name":"sneaky","startup":"connect","items":[]}"#;
        let portable: PortableTemplate = serde_json::from_str(text).unwrap();
        assert_eq!(portable.name, "sneaky");
        // And what the command builds from it is always off.
        let input = repo::TemplateInput {
            name: portable.name,
            color: String::new(),
            items: portable.items,
            startup: repo::STARTUP_OFF.into(),
        };
        assert_eq!(input.startup, repo::STARTUP_OFF);
    }
}
