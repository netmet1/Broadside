//! Rolling audit log (D-011): always-on-by-default JSONL in the app data
//! dir, 50MB cap with one rotation generation, toggleable.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use serde::Serialize;

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "audit.jsonl";
const ROTATED_NAME: &str = "audit.jsonl.1";
const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// One auditable action. Serialized as `{"ts": …, "kind": …, …fields}`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditEvent {
    /// A broadcast was dispatched. Destructive confirmations enrich this
    /// record per D-014 (`matched_rules` + `confirmed`).
    BroadcastSend {
        command: String,
        host_labels: Vec<String>,
        timeout_secs: u64,
        matched_rules: Vec<String>,
        confirmed: bool,
    },
    /// A host key was trusted (first contact or explicit trust-after-mismatch,
    /// recorded per D-034).
    KeyTrusted {
        hostname: String,
        port: u16,
        key_type: String,
        fingerprint_sha256: String,
    },
    PtyOpened {
        host_label: String,
        hostname: String,
        port: u16,
    },
    SessionSaved {
        path: String,
        encrypted: bool,
        lines: usize,
    },
}

#[derive(Serialize)]
struct AuditRecord<'a> {
    ts: String,
    #[serde(flatten)]
    event: &'a AuditEvent,
}

pub struct AuditState {
    dir: PathBuf,
    enabled: AtomicBool,
    max_bytes: u64,
    /// Serializes append+rotate across concurrent commands.
    write_lock: Mutex<()>,
}

impl AuditState {
    pub fn new(dir: PathBuf, enabled: bool) -> Self {
        Self {
            dir,
            enabled: AtomicBool::new(enabled),
            max_bytes: DEFAULT_MAX_BYTES,
            write_lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn with_max_bytes(dir: PathBuf, enabled: bool, max_bytes: u64) -> Self {
        Self {
            dir,
            enabled: AtomicBool::new(enabled),
            max_bytes,
            write_lock: Mutex::new(()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// Appends one event. A disabled log is a silent no-op; write errors are
    /// returned but callers may choose to ignore them (auditing must never
    /// break the operation being audited).
    pub fn append(&self, event: &AuditEvent) -> AppResult<()> {
        if !self.is_enabled() {
            return Ok(());
        }
        let record = AuditRecord {
            ts: Utc::now().to_rfc3339(),
            event,
        };
        let mut line = serde_json::to_string(&record)?;
        line.push('\n');

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AppError::State("audit lock poisoned".into()))?;
        fs::create_dir_all(&self.dir)?;
        let path = self.path();
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() + line.len() as u64 > self.max_bytes {
                // One rotation generation: current → .1 (replacing any old .1).
                let _ = fs::remove_file(self.dir.join(ROTATED_NAME));
                fs::rename(&path, self.dir.join(ROTATED_NAME))?;
            }
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Last `max_lines` lines of the current log file (viewer tail). The
    /// rotated generation is not included — it exists for postmortems, not
    /// the live view.
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

    pub fn size_bytes(&self) -> u64 {
        fs::metadata(self.path()).map(|m| m.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn event(n: usize) -> AuditEvent {
        AuditEvent::BroadcastSend {
            command: format!("uptime # {n}"),
            host_labels: vec!["web01".into()],
            timeout_secs: 30,
            matched_rules: vec![],
            confirmed: false,
        }
    }

    #[test]
    fn append_writes_jsonl_with_ts_and_kind() {
        let dir = TempDir::new().unwrap();
        let audit = AuditState::new(dir.path().into(), true);
        audit.append(&event(1)).unwrap();
        let lines = audit.tail(10).unwrap();
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["kind"], "broadcast_send");
        assert!(v["ts"].as_str().unwrap().contains('T'));
        assert_eq!(v["command"], "uptime # 1");
    }

    #[test]
    fn disabled_log_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let audit = AuditState::new(dir.path().into(), false);
        audit.append(&event(1)).unwrap();
        assert!(audit.tail(10).unwrap().is_empty());
        assert_eq!(audit.size_bytes(), 0);
    }

    #[test]
    fn rotation_replaces_old_generation() {
        let dir = TempDir::new().unwrap();
        // Cap small enough that every append rotates once a line exists.
        let audit = AuditState::with_max_bytes(dir.path().into(), true, 200);
        for n in 0..10 {
            audit.append(&event(n)).unwrap();
        }
        assert!(dir.path().join(ROTATED_NAME).exists());
        // Current file stays under the cap.
        assert!(audit.size_bytes() <= 200);
    }

    #[test]
    fn tail_returns_last_n() {
        let dir = TempDir::new().unwrap();
        let audit = AuditState::new(dir.path().into(), true);
        for n in 0..20 {
            audit.append(&event(n)).unwrap();
        }
        let lines = audit.tail(5).unwrap();
        assert_eq!(lines.len(), 5);
        assert!(lines[4].contains("# 19"));
        assert!(lines[0].contains("# 15"));
    }

    #[test]
    fn toggle_round_trip() {
        let dir = TempDir::new().unwrap();
        let audit = AuditState::new(dir.path().into(), true);
        audit.set_enabled(false);
        audit.append(&event(1)).unwrap();
        assert!(audit.tail(10).unwrap().is_empty());
        audit.set_enabled(true);
        audit.append(&event(2)).unwrap();
        assert_eq!(audit.tail(10).unwrap().len(), 1);
    }
}
