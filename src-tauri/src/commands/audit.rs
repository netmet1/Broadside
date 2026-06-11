use serde::Serialize;
use tauri::State;

use super::ssh::with_db;
use crate::audit::AuditState;
use crate::db::{settings, DbState};
use crate::error::AppResult;

#[derive(Serialize)]
pub struct AuditInfo {
    pub path: String,
    pub size_bytes: u64,
    pub enabled: bool,
}

#[tauri::command]
pub fn audit_info(audit: State<'_, AuditState>) -> AuditInfo {
    AuditInfo {
        path: audit.path().display().to_string(),
        size_bytes: audit.size_bytes(),
        enabled: audit.is_enabled(),
    }
}

#[tauri::command]
pub fn audit_tail(
    max_lines: usize,
    audit: State<'_, AuditState>,
) -> AppResult<Vec<String>> {
    audit.tail(max_lines.clamp(1, 10_000))
}

/// Toggles the rolling audit log (D-011) and persists the choice.
#[tauri::command]
pub fn set_audit_enabled(
    enabled: bool,
    audit: State<'_, AuditState>,
    db_state: State<'_, DbState>,
) -> AppResult<()> {
    with_db(&db_state, |conn| {
        settings::set(conn, "audit_enabled", if enabled { "true" } else { "false" })
    })?;
    audit.set_enabled(enabled);
    Ok(())
}
