//! Bulk host import commands (D-025/D-047): preview parses + validates the
//! file against current DB state; apply inserts the rows the user confirmed.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use super::ssh::with_db;
use crate::db::hosts::{self as host_repo, HostInput};
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::import::{self, RowPreview};

#[tauri::command]
pub fn preview_import(path: String, state: State<'_, DbState>) -> AppResult<Vec<RowPreview>> {
    let rows = import::parse_file(Path::new(&path))?;
    let existing: HashSet<String> = with_db(&state, |conn| {
        Ok(host_repo::list_all(conn)?
            .into_iter()
            .map(|h| h.label)
            .collect())
    })?;
    Ok(import::validate_rows(&existing, rows))
}

#[derive(Debug, Serialize)]
pub struct SkippedRow {
    pub label: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct ImportOutcome {
    pub imported: usize,
    pub skipped: Vec<SkippedRow>,
}

/// Inserts the confirmed rows. `#auto` colors must already be resolved by
/// the frontend (palette logic lives there). Per-row failures (e.g. a label
/// created between preview and apply) are reported, not fatal — valid rows
/// still import (D-025).
#[tauri::command]
pub fn import_hosts(
    rows: Vec<HostInput>,
    state: State<'_, DbState>,
) -> AppResult<ImportOutcome> {
    with_db(&state, |conn| {
        let mut imported = 0;
        let mut skipped = Vec::new();
        for input in rows {
            let label = input.label.clone();
            match host_repo::create(conn, input) {
                Ok(_) => imported += 1,
                Err(AppError::InvalidInput(reason)) => {
                    skipped.push(SkippedRow { label, reason })
                }
                Err(e) => return Err(e),
            }
        }
        Ok(ImportOutcome { imported, skipped })
    })
}
