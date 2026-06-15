use tauri::State;

use crate::errlog::ErrLogState;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn error_log_tail(
    max_lines: usize,
    errlog: State<'_, ErrLogState>,
) -> AppResult<Vec<String>> {
    errlog.tail(max_lines.clamp(1, 10_000))
}

#[tauri::command]
pub fn clear_error_log(errlog: State<'_, ErrLogState>) -> AppResult<usize> {
    errlog.clear()
}

/// Copies the error log to `dest` for forensics (LG4). Returns bytes written.
#[tauri::command]
pub fn export_error_log(dest: String, errlog: State<'_, ErrLogState>) -> AppResult<u64> {
    let src = errlog.path();
    if !src.exists() {
        return Err(AppError::InvalidInput("no error log to export yet".into()));
    }
    Ok(std::fs::copy(&src, &dest)?)
}

/// Reads an arbitrary log file's lines (for loading an exported error log into
/// the session viewer — LG5). Frontend parses the JSONL.
#[tauri::command]
pub fn read_log_lines(path: String) -> AppResult<Vec<String>> {
    let content = std::fs::read_to_string(&path)?;
    Ok(content.lines().map(|s| s.to_string()).collect())
}
