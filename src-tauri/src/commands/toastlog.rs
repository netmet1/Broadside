use tauri::State;

use crate::error::{AppError, AppResult};
use crate::toastlog::{ToastLogState, KEEP};

/// Records one toast as it is shown. The frontend ignores a failure: history
/// is a convenience and must never get in the way of the toast itself.
#[tauri::command]
pub fn toast_log_append(
    kind: String,
    message: String,
    description: Option<String>,
    toastlog: State<'_, ToastLogState>,
) -> AppResult<()> {
    toastlog.append(&kind, &message, description.as_deref())
}

#[tauri::command]
pub fn toast_log_tail(
    max_lines: usize,
    toastlog: State<'_, ToastLogState>,
) -> AppResult<Vec<String>> {
    toastlog.tail(max_lines.clamp(1, KEEP))
}

#[tauri::command]
pub fn clear_toast_log(toastlog: State<'_, ToastLogState>) -> AppResult<bool> {
    toastlog.clear()
}

/// Copies the toast history to `dest`. Returns bytes written.
#[tauri::command]
pub fn export_toast_log(dest: String, toastlog: State<'_, ToastLogState>) -> AppResult<u64> {
    let src = toastlog.path();
    if !src.exists() {
        return Err(AppError::InvalidInput("no toast history to export yet".into()));
    }
    Ok(std::fs::copy(&src, &dest)?)
}
