//! Toast history: every toast the app shows, kept so a message that came and
//! went too fast to read (or that fired just before a reload) can be read again
//! from the Logs page.
//!
//! A file beside the error log rather than a database table, for the same
//! reason the error log is one: a restore replaces the database wholesale, and
//! the toasts that restore itself raised are exactly the ones worth reading
//! back afterwards. Capped by count (the newest [`KEEP`]), not by size, because
//! the Logs page promises "the last 500 toasts".

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use serde::Serialize;

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "toasts.jsonl";
/// How many toasts are kept. Older ones fall off as new ones arrive.
pub const KEEP: usize = 500;
/// Longest message stored, in characters. A toast is a sentence or two; this
/// only stops a runaway string (a whole stack trace, say) growing the file.
const MAX_TEXT: usize = 2000;
/// The kinds sonner shows. Anything else is refused rather than stored.
const KINDS: [&str; 5] = ["success", "error", "warning", "info", "message"];

#[derive(Serialize)]
struct ToastRecord<'a> {
    ts: String,
    kind: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

pub struct ToastLogState {
    dir: PathBuf,
    /// Serializes append/trim/clear across concurrent commands.
    write_lock: Mutex<()>,
}

/// Trims to [`MAX_TEXT`] characters without splitting one.
fn cap(s: &str) -> String {
    match s.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

impl ToastLogState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            write_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        self.write_lock
            .lock()
            .map_err(|_| AppError::State("toast log lock poisoned".into()))
    }

    /// Appends one toast, dropping the oldest once there are [`KEEP`].
    pub fn append(&self, kind: &str, message: &str, description: Option<&str>) -> AppResult<()> {
        if !KINDS.contains(&kind) {
            return Err(AppError::InvalidInput(format!("unknown toast kind: {kind}")));
        }
        let message = message.trim();
        if message.is_empty() {
            return Err(AppError::InvalidInput("empty toast".into()));
        }
        let record = ToastRecord {
            ts: Utc::now().to_rfc3339(),
            kind,
            message: cap(message),
            description: description
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(cap),
        };
        let line = serde_json::to_string(&record)?;

        let _guard = self.lock()?;
        fs::create_dir_all(&self.dir)?;
        let path = self.path();
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let count = existing.lines().count();
        if count >= KEEP {
            // Rewrite with room for this one. A few hundred short lines, so
            // reading the file per toast costs nothing a person could notice.
            let kept: Vec<&str> = existing.lines().skip(count + 1 - KEEP).collect();
            let mut body = kept.join("\n");
            body.push('\n');
            body.push_str(&line);
            body.push('\n');
            fs::write(&path, body)?;
        } else {
            let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
            file.write_all(format!("{line}\n").as_bytes())?;
        }
        Ok(())
    }

    /// Last `max_lines` lines, oldest first.
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

    /// Deletes the file. Returns whether there was one.
    pub fn clear(&self) -> AppResult<bool> {
        let _guard = self.lock()?;
        Ok(fs::remove_file(self.path()).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn append_writes_kind_message_and_optional_description() {
        let dir = TempDir::new().unwrap();
        let log = ToastLogState::new(dir.path().into());
        log.append("warning", "  2 profiles emptied  ", None).unwrap();
        log.append("success", "Saved", Some("web-01")).unwrap();
        let lines = log.tail(10).unwrap();
        assert_eq!(lines.len(), 2);
        let a: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(a["kind"], "warning");
        assert_eq!(a["message"], "2 profiles emptied");
        assert!(a.get("description").is_none());
        let b: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(b["description"], "web-01");
    }

    #[test]
    fn refuses_unknown_kind_and_empty_message() {
        let dir = TempDir::new().unwrap();
        let log = ToastLogState::new(dir.path().into());
        assert!(log.append("loading", "x", None).is_err());
        assert!(log.append("error", "   ", None).is_err());
        assert!(log.tail(10).unwrap().is_empty());
    }

    #[test]
    fn keeps_only_the_newest() {
        let dir = TempDir::new().unwrap();
        let log = ToastLogState::new(dir.path().into());
        for n in 0..KEEP + 7 {
            log.append("info", &format!("toast {n}"), None).unwrap();
        }
        let lines = log.tail(KEEP * 2).unwrap();
        assert_eq!(lines.len(), KEEP);
        assert!(lines[0].contains("\"toast 7\""));
        assert!(lines[KEEP - 1].contains(&format!("\"toast {}\"", KEEP + 6)));
    }

    #[test]
    fn caps_long_text_on_a_char_boundary() {
        let dir = TempDir::new().unwrap();
        let log = ToastLogState::new(dir.path().into());
        let long = "é".repeat(MAX_TEXT + 50);
        log.append("error", &long, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        assert_eq!(v["message"].as_str().unwrap().chars().count(), MAX_TEXT + 1);
    }

    #[test]
    fn clear_empties_it() {
        let dir = TempDir::new().unwrap();
        let log = ToastLogState::new(dir.path().into());
        log.append("success", "x", None).unwrap();
        assert!(log.clear().unwrap());
        assert!(log.tail(10).unwrap().is_empty());
        assert!(!log.clear().unwrap());
    }
}
