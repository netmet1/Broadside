//! .otlog session files (D-010): JSONL `{ts, host, stream, data}` per line,
//! ANSI preserved verbatim in `data`, optional passphrase encryption (age).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtlogLine {
    pub ts: String,
    pub host: String,
    /// "stdout" | "stderr" (free-form for future streams).
    pub stream: String,
    pub data: String,
}

pub fn save(path: &Path, lines: &[OtlogLine], passphrase: Option<&str>) -> AppResult<()> {
    let mut body = String::new();
    for line in lines {
        body.push_str(&serde_json::to_string(line)?);
        body.push('\n');
    }
    let bytes = match passphrase {
        Some(p) if !p.is_empty() => crypto::encrypt(body.as_bytes(), p)?,
        _ => body.into_bytes(),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

pub fn is_encrypted(path: &Path) -> AppResult<bool> {
    let mut header = [0u8; 32];
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let n = file.read(&mut header)?;
    Ok(crypto::is_age_encrypted(&header[..n]))
}

pub fn load(path: &Path, passphrase: Option<&str>) -> AppResult<Vec<OtlogLine>> {
    let raw = fs::read(path)?;
    let body = if crypto::is_age_encrypted(&raw) {
        let passphrase = passphrase.filter(|p| !p.is_empty()).ok_or_else(|| {
            AppError::Crypto("this session file is encrypted — passphrase required".into())
        })?;
        crypto::decrypt(&raw, passphrase)?
    } else {
        raw
    };
    let text = String::from_utf8(body)
        .map_err(|_| AppError::InvalidInput("session file is not valid UTF-8".into()))?;
    let mut out = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let parsed: OtlogLine = serde_json::from_str(line).map_err(|e| {
            AppError::InvalidInput(format!("bad .otlog line {}: {e}", idx + 1))
        })?;
        out.push(parsed);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample() -> Vec<OtlogLine> {
        vec![
            OtlogLine {
                ts: "2026-06-11T12:00:00Z".into(),
                host: "web01".into(),
                stream: "stdout".into(),
                data: "Linux web01 6.8.0\n\u{1b}[32mok\u{1b}[0m".into(),
            },
            OtlogLine {
                ts: "2026-06-11T12:00:01Z".into(),
                host: "db01".into(),
                stream: "stderr".into(),
                data: "error: lock timeout".into(),
            },
        ]
    }

    #[test]
    fn plaintext_round_trip_preserves_ansi() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        save(&path, &sample(), None).unwrap();
        assert!(!is_encrypted(&path).unwrap());
        let loaded = load(&path, None).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded[0].data.contains("\u{1b}[32m"), "ANSI must survive");
        assert_eq!(loaded[1].host, "db01");
        assert_eq!(loaded[1].stream, "stderr");
    }

    #[test]
    fn encrypted_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        save(&path, &sample(), Some("hunter2")).unwrap();
        assert!(is_encrypted(&path).unwrap());
        let loaded = load(&path, Some("hunter2")).unwrap();
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn encrypted_without_passphrase_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        save(&path, &sample(), Some("hunter2")).unwrap();
        let err = load(&path, None).unwrap_err();
        assert!(matches!(err, AppError::Crypto(_)), "got {err:?}");
    }

    #[test]
    fn wrong_passphrase_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        save(&path, &sample(), Some("hunter2")).unwrap();
        let err = load(&path, Some("wrong")).unwrap_err();
        assert!(matches!(err, AppError::Crypto(_)), "got {err:?}");
    }

    #[test]
    fn empty_passphrase_means_plaintext() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        save(&path, &sample(), Some("")).unwrap();
        assert!(!is_encrypted(&path).unwrap());
        assert_eq!(load(&path, None).unwrap().len(), 2);
    }

    #[test]
    fn malformed_line_reports_line_number() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("run.otlog");
        fs::write(&path, "{\"ts\":\"t\",\"host\":\"h\",\"stream\":\"stdout\",\"data\":\"d\"}\nnot-json\n").unwrap();
        let err = load(&path, None).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(ref m) if m.contains("line 2")));
    }
}
