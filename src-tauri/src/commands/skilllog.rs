//! Reading and clearing the skill log. Mirrors [`super::errlog`]: the viewer
//! asks for a tail of raw JSONL lines and does its own parsing, because the
//! rendering (prose or JSON) is a setting the frontend already holds.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::skilllog::SkillLogState;

#[tauri::command]
pub fn skill_log_tail(
    max_lines: usize,
    skilllog: State<'_, SkillLogState>,
) -> AppResult<Vec<String>> {
    skilllog.tail(max_lines.clamp(1, 10_000))
}

#[tauri::command]
pub fn clear_skill_log(skilllog: State<'_, SkillLogState>) -> AppResult<usize> {
    skilllog.clear()
}

/// Copies the skill log to `dest`. Returns bytes written.
///
/// The raw file, not the rendering: an export is for something else to read,
/// and the something else wants the structure. The Export button says so.
#[tauri::command]
pub fn export_skill_log(
    dest: String,
    skilllog: State<'_, SkillLogState>,
) -> AppResult<u64> {
    let src = skilllog.path();
    if !src.exists() {
        return Err(AppError::InvalidInput("no skill log to export yet".into()));
    }
    Ok(std::fs::copy(&src, &dest)?)
}
