//! Rolling error log (D-055): connection/operation failures that surface as
//! toasts also persist here so they can be reviewed after the toast is gone.
//! Always on (no toggle — errors are low-volume), 10MB cap with one rotation
//! generation, clearable from the Logs viewer.
//!
//! Deliberately separate from the audit log: audit records what the operator
//! *did*; this records what *failed*. Events are not duplicated into audit.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use serde::Serialize;

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "errors.jsonl";
const ROTATED_NAME: &str = "errors.jsonl.1";
const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// One logged failure. Serialized as `{"ts": …, "source": …, …}`.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorEvent {
    /// Where the failure happened: `test_connection`, `broadcast`, `pty_open`.
    pub source: String,
    /// Host id for live colour-tinting in the viewer (LG2); None for old rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    pub message: String,
}

#[derive(Serialize)]
struct ErrorRecord<'a> {
    ts: String,
    #[serde(flatten)]
    event: &'a ErrorEvent,
}

pub struct ErrLogState {
    dir: PathBuf,
    max_bytes: u64,
    /// Serializes append/rotate/clear across concurrent commands.
    write_lock: Mutex<()>,
}

impl ErrLogState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            max_bytes: DEFAULT_MAX_BYTES,
            write_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// Appends one failure. Write errors are returned but callers ignore
    /// them — error logging must never break the operation that failed.
    pub fn append(&self, event: &ErrorEvent) -> AppResult<()> {
        let record = ErrorRecord {
            ts: Utc::now().to_rfc3339(),
            event,
        };
        let mut line = serde_json::to_string(&record)?;
        line.push('\n');

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AppError::State("error log lock poisoned".into()))?;
        fs::create_dir_all(&self.dir)?;
        let path = self.path();
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() + line.len() as u64 > self.max_bytes {
                let _ = fs::remove_file(self.dir.join(ROTATED_NAME));
                fs::rename(&path, self.dir.join(ROTATED_NAME))?;
            }
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Convenience used at the failure sites.
    pub fn log(
        &self,
        source: &str,
        host_id: Option<i64>,
        host_label: Option<&str>,
        message: &str,
    ) {
        let _ = self.append(&ErrorEvent {
            source: source.to_string(),
            host_id,
            host_label: host_label.map(|s| s.to_string()),
            message: message.to_string(),
        });
    }

    /// Last `max_lines` lines of the current file (viewer tail).
    pub fn tail(&self, max_lines: usize) -> AppResult<Vec<String>> {
        let path = self.path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&path)?;
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(max_lines);
        Ok(lines[start..].iter().map(|s| s.to_string()).collect())
    }

    /// Removes the current and rotated files. Returns the number of files
    /// actually deleted.
    pub fn clear(&self) -> AppResult<usize> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AppError::State("error log lock poisoned".into()))?;
        let mut removed = 0;
        for name in [FILE_NAME, ROTATED_NAME] {
            if fs::remove_file(self.dir.join(name)).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn append_writes_jsonl_with_ts_source_and_label() {
        let dir = TempDir::new().unwrap();
        let log = ErrLogState::new(dir.path().into());
        log.log(
            "test_connection",
            Some(1),
            Some("web-01"),
            "unreachable — timed out",
        );
        let lines = log.tail(10).unwrap();
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["source"], "test_connection");
        assert_eq!(v["host_label"], "web-01");
        assert!(v["ts"].as_str().unwrap().contains('T'));
        assert!(v["message"].as_str().unwrap().contains("unreachable"));
    }

    #[test]
    fn label_omitted_when_none() {
        let dir = TempDir::new().unwrap();
        let log = ErrLogState::new(dir.path().into());
        log.log("broadcast", None, None, "boom");
        let v: serde_json::Value =
            serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        assert!(v.get("host_label").is_none());
    }

    #[test]
    fn clear_removes_files_and_tail_is_empty() {
        let dir = TempDir::new().unwrap();
        let log = ErrLogState::new(dir.path().into());
        log.log("pty_open", Some(2), Some("db-01"), "auth failed");
        assert_eq!(log.tail(10).unwrap().len(), 1);
        assert_eq!(log.clear().unwrap(), 1);
        assert!(log.tail(10).unwrap().is_empty());
    }

    #[test]
    fn tail_returns_last_n() {
        let dir = TempDir::new().unwrap();
        let log = ErrLogState::new(dir.path().into());
        for n in 0..20 {
            log.log("broadcast", None, None, &format!("err {n}"));
        }
        let lines = log.tail(5).unwrap();
        assert_eq!(lines.len(), 5);
        assert!(lines[4].contains("err 19"));
        assert!(lines[0].contains("err 15"));
    }
}
