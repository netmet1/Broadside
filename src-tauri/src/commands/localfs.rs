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
            Err(_) => continue, // permission-denied / broken link, skip the row
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

/// Renames a local file or folder where it stands and returns its new path.
///
/// `new_name` is a bare name, not a path, so a rename can only ever change the
/// name: it cannot move anything to another folder. An existing file or folder
/// of that name is never replaced (Windows' own rename replaces a file without
/// asking). A change of case alone is allowed, since on Windows that is the
/// same entry.
#[tauri::command]
pub fn local_rename(path: String, new_name: String) -> AppResult<String> {
    let from = Path::new(&path);
    let target = local_rename_target(from, &new_name)?;
    if target.as_path() == from {
        return Ok(path);
    }
    let old_name = from
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let case_only = old_name.to_lowercase() == new_name.to_lowercase();
    if !case_only && fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::LocalFs(format!("{new_name} already exists here")));
    }
    fs::rename(from, &target)
        .map_err(|e| AppError::LocalFs(format!("rename {old_name}: {e}")))?;
    Ok(target.to_string_lossy().to_string())
}

/// Where a rename of `from` to `new_name` lands: the same folder, the new name.
fn local_rename_target(from: &Path, new_name: &str) -> AppResult<PathBuf> {
    check_local_name(new_name).map_err(AppError::InvalidInput)?;
    match (from.parent(), from.file_name()) {
        (Some(parent), Some(_)) => Ok(parent.join(new_name)),
        // A drive root has no name to change.
        _ => Err(AppError::InvalidInput(format!(
            "{} can't be renamed",
            from.display()
        ))),
    }
}

/// The names Windows will not take, as a message for the operator. The rename
/// dialog checks the same rules so it can say so before anything is sent.
fn check_local_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a name can't be empty".into());
    }
    if name == "." || name == ".." {
        return Err(format!("{name} is not a name a file can have"));
    }
    if name
        .chars()
        .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err(r#"a name can't contain any of \ / : * ? " < > |"#.into());
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err("a name can't end with a space or a dot".into());
    }
    if name.chars().count() > 255 {
        return Err("that name is longer than Windows allows".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("{stem} is a name Windows keeps for itself"));
    }
    Ok(())
}

/// Pre-flight: counts files + total bytes under a local directory (drives the
/// large-folder warning before a recursive put). Symlinks are skipped.
///
/// Async, with the walk on a blocking thread: a sync command runs on the main
/// thread, and a big tree would hold every other IPC call (transfer progress
/// included) until it finished.
#[tauri::command]
pub async fn local_scan_dir(path: String) -> AppResult<TransferStats> {
    tauri::async_runtime::spawn_blocking(move || scan_local(&path))
        .await
        .map_err(|e| AppError::LocalFs(format!("scan did not finish: {e}")))
}

fn scan_local(path: &str) -> TransferStats {
    let mut stats = TransferStats::default();
    let mut stack = vec![PathBuf::from(path)];
    while let Some(dir) = stack.pop() {
        let read_dir = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // unreadable subtree, skip
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
    stats
}

/// Moves a local file or folder to the Recycle Bin (recoverable), rather than
/// deleting it permanently.
#[tauri::command]
pub fn local_delete(path: String) -> AppResult<()> {
    trash::delete(&path)
        .map_err(|e| AppError::LocalFs(format!("recycle {path}: {e}")))?;
    Ok(())
}

/// Existing drive roots (`C:\`, `D:\`, …), shown when navigating up past a
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_pass() {
        for ok in ["report.txt", "My Folder", ".bashrc", "a.b.c", "COM10", "console.log"] {
            assert!(check_local_name(ok).is_ok(), "{ok} should pass");
        }
    }

    #[test]
    fn names_windows_refuses_are_refused() {
        for bad in [
            "", ".", "..", "a/b", r"a\b", "C:x", "what?", "star*", "pipe|", "q\"", "<x>",
            "trailing.", "trailing ", "tab\there", "CON", "con.txt", "Nul", "COM1", "lpt9.log",
        ] {
            assert!(check_local_name(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_rename_stays_in_its_folder() {
        let from = Path::new(r"C:\Users\me\old.txt");
        let to = local_rename_target(from, "new.txt").unwrap();
        assert_eq!(to, Path::new(r"C:\Users\me\new.txt"));
        // A name that tries to climb or wander never becomes a path.
        assert!(local_rename_target(from, r"..\evil.txt").is_err());
        assert!(local_rename_target(from, "sub/evil.txt").is_err());
        assert!(local_rename_target(from, "..").is_err());
    }

    #[test]
    fn a_drive_root_cannot_be_renamed() {
        assert!(local_rename_target(Path::new(r"C:\"), "D").is_err());
    }

    #[test]
    fn rename_refuses_to_replace_and_allows_a_case_change() {
        let dir = std::env::temp_dir().join(format!(
            "broadside-rename-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let refused = local_rename(a.to_string_lossy().into(), "b.txt".into());
        assert!(refused.is_err(), "must not replace b.txt");
        assert_eq!(fs::read(&b).unwrap(), b"b");

        let upper = local_rename(a.to_string_lossy().into(), "A.txt".into()).unwrap();
        assert!(upper.ends_with("A.txt"));

        let moved = local_rename(upper, "c.txt".into()).unwrap();
        assert_eq!(fs::read(&moved).unwrap(), b"a");
        fs::remove_dir_all(&dir).unwrap();
    }
}
