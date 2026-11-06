//! How many other copies of Broadside are running on this data folder, so a
//! second launch can say so before it loads anything (the warning itself is
//! the frontend's InstanceGuard).
//!
//! Each running copy holds an exclusive lock on its own file in
//! `<app data>/instances/`. The operating system drops a lock when its process
//! ends, however it ends, so a file nobody holds belongs to a copy that has
//! gone (crashed, killed, power cut) and is removed as it is found. Counting by
//! lock rather than by process name keeps a test build, which has its own data
//! folder, out of the installed app's count, and works the same on Windows and
//! macOS.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const DIR: &str = "instances";
const EXT: &str = "lock";

/// This copy's place in the count. The file is held, not read: dropping it
/// (at exit) releases the lock, which is what tells later launches it is gone.
pub struct InstanceState {
    _lock: Option<File>,
    others: usize,
}

impl InstanceState {
    /// Counts the copies already running, then registers this one. Never
    /// fails the launch: if the folder cannot be used, the count is 0 and the
    /// warning simply does not appear.
    pub fn register(app_data_dir: &Path) -> Self {
        let dir = app_data_dir.join(DIR);
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("[instances] cannot create {}: {e}", dir.display());
            return Self { _lock: None, others: 0 };
        }
        let others = count_live(&dir);
        let lock = match claim(&dir) {
            Ok(file) => Some(file),
            Err(e) => {
                eprintln!("[instances] cannot register: {e}");
                None
            }
        };
        Self { _lock: lock, others }
    }

    /// Copies that were already running when this one started.
    pub fn others(&self) -> usize {
        self.others
    }
}

/// Counts the lock files someone still holds, removing the ones nobody does.
fn count_live(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut live = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(EXT) {
            continue;
        }
        let Ok(file) = OpenOptions::new().read(true).write(true).open(&path) else {
            continue;
        };
        match file.try_lock() {
            Ok(()) => {
                // Nobody holds it: that copy has ended. Close before removing,
                // since Windows will not remove a file this process has open.
                drop(file);
                let _ = fs::remove_file(&path);
            }
            Err(TryLockError::WouldBlock) => live += 1,
            Err(TryLockError::Error(_)) => {}
        }
    }
    live
}

/// Creates and locks this copy's file. It is locked under a name the count
/// skips and only then renamed into view, so a copy counting at the same
/// moment can never find it unlocked and take it for one that has ended.
fn claim(dir: &Path) -> std::io::Result<File> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stem = format!("{}-{nanos}", std::process::id());
    let pending = dir.join(format!("{stem}.pending"));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&pending)?;
    file.try_lock().map_err(std::io::Error::from)?;
    fs::rename(&pending, dir.join(format!("{stem}.{EXT}")))?;
    Ok(file)
}

/// How many other copies of Broadside were running on this data folder when
/// this one started. Read once, at launch, by the startup warning.
#[tauri::command]
pub fn other_instance_count(state: tauri::State<'_, InstanceState>) -> usize {
    state.others()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_held_locks_and_clears_stale_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let first = InstanceState::register(tmp.path());
        assert_eq!(first.others(), 0);

        let second = InstanceState::register(tmp.path());
        assert_eq!(second.others(), 1);

        // A copy that ended without cleaning up: its file is there, unheld.
        let stale = tmp.path().join(DIR).join(format!("1-1.{EXT}"));
        File::create(&stale).unwrap();
        let third = InstanceState::register(tmp.path());
        assert_eq!(third.others(), 2);
        assert!(!stale.exists(), "an unheld lock file is removed");

        drop(second);
        let fourth = InstanceState::register(tmp.path());
        assert_eq!(fourth.others(), 2, "first and third are still running");
        drop((first, third, fourth));
    }
}
