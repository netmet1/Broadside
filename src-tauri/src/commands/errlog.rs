use tauri::State;

use crate::errlog::ErrLogState;
use crate::error::AppResult;

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
