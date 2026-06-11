use std::path::PathBuf;

use tauri::State;

use crate::audit::{AuditEvent, AuditState};
use crate::error::AppResult;
use crate::session::{self, OtlogLine};

#[tauri::command]
pub fn save_session(
    path: String,
    lines: Vec<OtlogLine>,
    passphrase: Option<String>,
    audit: State<'_, AuditState>,
) -> AppResult<()> {
    let path = PathBuf::from(path);
    let encrypted = passphrase.as_deref().is_some_and(|p| !p.is_empty());
    session::save(&path, &lines, passphrase.as_deref())?;
    let _ = audit.append(&AuditEvent::SessionSaved {
        path: path.display().to_string(),
        encrypted,
        lines: lines.len(),
    });
    Ok(())
}

#[tauri::command]
pub fn session_is_encrypted(path: String) -> AppResult<bool> {
    session::is_encrypted(&PathBuf::from(path))
}

#[tauri::command]
pub fn load_session(
    path: String,
    passphrase: Option<String>,
) -> AppResult<Vec<OtlogLine>> {
    session::load(&PathBuf::from(path), passphrase.as_deref())
}
