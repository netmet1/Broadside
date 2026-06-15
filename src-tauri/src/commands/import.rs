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
    let (labels, endpoints): (HashSet<String>, HashSet<String>) = with_db(&state, |conn| {
        let all = host_repo::list_all(conn)?;
        let labels = all.iter().map(|h| h.label.clone()).collect();
        // A duplicate is the same (hostname, port, username) endpoint — the
        // same connection can't be imported twice, but differing port or user
        // is a distinct host (H5).
        let endpoints = all
            .iter()
            .map(|h| import::endpoint_key(&h.hostname, h.port, &h.username))
            .collect();
        Ok((labels, endpoints))
    })?;
    Ok(import::validate_rows_with_endpoints(&labels, &endpoints, rows))
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
