//! Local filesystem browsing for the SFTP Commander's left pane.
//!
//! The webview has no direct filesystem access (no JS `plugin-fs`), so the local
//! side is listed here in Rust with `std::fs`, returning the same entry shape as
//! the remote (SFTP) side so the two panes render identically.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::ssh::sftp::TransferStats;

/// One local directory entry. `kind` is `"dir" | "file"` (symlinks report as
/// whatever they resolve to via `metadata`).
#[derive(Debug, Clone, Serialize)]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    /// Modification time, epoch seconds.
    pub mtime: Option<i64>,
}

/// dir → 0, file → 1, so listings show folders first.
fn kind_rank(kind: &str) -> u8 {
    if kind == "dir" {
        0
    } else {
        1
    }
}

/// The user's home directory (browser starting point).
#[tauri::command]
pub fn local_home_dir() -> AppResult<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".to_string());
    Ok(home)
}

/// Lists a local directory, folders first then files, each alphabetical.
/// Unreadable individual entries are skipped; an unreadable directory errors.
#[tauri::command]
pub fn local_list_dir(path: String) -> AppResult<Vec<LocalEntry>> {
    let mut entries: Vec<LocalEntry> = Vec::new();
    for dent in fs::read_dir(&path)? {
        let dent = match dent {
            Ok(d) => d,
            Err(_) => continue,
        };
        let meta = match dent.metadata() {
            Ok(m) => m,
            Err(_) => continue, // permission-denied / broken link — skip the row
        };
        let is_dir = meta.is_dir();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        entries.push(LocalEntry {
            name: dent.file_name().to_string_lossy().to_string(),
            path: dent.path().to_string_lossy().to_string(),
            kind: if is_dir { "dir" } else { "file" }.to_string(),
            size: if is_dir { None } else { Some(meta.len()) },
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Creates a local directory.
#[tauri::command]
pub fn local_mkdir(path: String) -> AppResult<()> {
    fs::create_dir(&path)?;
    Ok(())
}

/// Pre-flight: counts files + total bytes under a local directory (drives the
/// large-folder warning before a recursive put). Symlinks are skipped.
#[tauri::command]
pub fn local_scan_dir(path: String) -> AppResult<TransferStats> {
    let mut stats = TransferStats::default();
    let mut stack = vec![PathBuf::from(&path)];
    while let Some(dir) = stack.pop() {
        let read_dir = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // unreadable subtree — skip
        };
        for e in read_dir.filter_map(Result::ok) {
            let ft = match e.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(e.path());
            } else {
                stats.files += 1;
                stats.bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(stats)
}

/// Moves a local file or folder to the Recycle Bin (recoverable), rather than
/// deleting it permanently.
#[tauri::command]
pub fn local_delete(path: String) -> AppResult<()> {
    trash::delete(&path)
        .map_err(|e| AppError::LocalFs(format!("recycle {path}: {e}")))?;
    Ok(())
}

/// Existing drive roots (`C:\`, `D:\`, …) — shown when navigating up past a
/// drive root on Windows.
#[tauri::command]
pub fn local_list_drives() -> AppResult<Vec<String>> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if Path::new(&root).exists() {
            drives.push(root);
        }
    }
    Ok(drives)
}
