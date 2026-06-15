//! Bulk host import (D-025/D-047): CSV + xlsx, header-row-driven mapping.
//! Required columns: label, hostname, username. Optional: port, color,
//! linux_flavor, notes. Credentials are NOT importable. Duplicate labels
//! (in the DB or earlier in the file) are skipped with a per-row report.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Linux flavor values the host form offers (label/icon only, D-005).
const FLAVORS: &[&str] = &[
    "ubuntu", "debian", "rhel", "fedora", "alpine", "arch", "suse", "other",
];

/// One data row as read from the file, fields still raw strings.
#[derive(Debug, Clone, Default)]
pub struct RawRow {
    /// 1-based row number in the file (header is row 1).
    pub row_number: usize,
    pub label: String,
    pub hostname: String,
    pub username: String,
    pub port: String,
    pub color: String,
    pub tag: String,
    pub linux_flavor: String,
    pub notes: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    /// Valid and importable.
    Ready,
    /// Label already exists (in the DB or earlier in this file) — skipped.
    Duplicate,
    /// Failed validation; `message` says why.
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct RowPreview {
    pub row_number: usize,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// Hex color, or the literal `#auto` for app-side palette picking.
    pub color: String,
    pub tag: Option<String>,
    pub linux_flavor: Option<String>,
    pub notes: Option<String>,
    pub status: RowStatus,
    pub message: Option<String>,
}

/// Column indices resolved from the header row (case-insensitive).
struct ColumnMap {
    label: usize,
    hostname: usize,
    username: usize,
    port: Option<usize>,
    color: Option<usize>,
    tag: Option<usize>,
    linux_flavor: Option<usize>,
    notes: Option<usize>,
}

impl ColumnMap {
    fn from_headers(headers: &[String]) -> AppResult<Self> {
        let find = |name: &str| {
            headers
                .iter()
                .position(|h| h.trim().eq_ignore_ascii_case(name))
        };
        let required = |name: &str| {
            find(name).ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "missing required column \"{name}\" in the header row"
                ))
            })
        };
        Ok(ColumnMap {
            label: required("label")?,
            hostname: required("hostname")?,
            username: required("username")?,
            port: find("port"),
            color: find("color"),
            tag: find("tag"),
            linux_flavor: find("linux_flavor"),
            notes: find("notes"),
        })
    }

    fn extract(&self, row_number: usize, cells: &[String]) -> RawRow {
        let cell = |idx: Option<usize>| {
            idx.and_then(|i| cells.get(i))
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        };
        RawRow {
            row_number,
            label: cell(Some(self.label)),
            hostname: cell(Some(self.hostname)),
            username: cell(Some(self.username)),
            port: cell(self.port),
            color: cell(self.color),
            tag: cell(self.tag),
            linux_flavor: cell(self.linux_flavor),
            notes: cell(self.notes),
        }
    }
}

/// Parses a .csv or .xlsx file into raw rows. Fully-empty rows are skipped.
pub fn parse_file(path: &Path) -> AppResult<Vec<RawRow>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "csv" => parse_csv(path),
        "xlsx" | "xls" => parse_xlsx(path),
        other => Err(AppError::InvalidInput(format!(
            "unsupported file type \".{other}\" — use .csv or .xlsx"
        ))),
    }
}

fn parse_csv(path: &Path) -> AppResult<Vec<RawRow>> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_path(path)
        .map_err(|e| AppError::InvalidInput(format!("could not read CSV: {e}")))?;
    let headers: Vec<String> = reader
        .headers()
        .map_err(|e| AppError::InvalidInput(format!("could not read CSV header: {e}")))?
        .iter()
        .map(|h| h.to_string())
        .collect();
    let map = ColumnMap::from_headers(&headers)?;

    let mut rows = Vec::new();
    for (i, record) in reader.records().enumerate() {
        let record =
            record.map_err(|e| AppError::InvalidInput(format!("CSV row error: {e}")))?;
        let cells: Vec<String> = record.iter().map(|c| c.to_string()).collect();
        if cells.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        // +2: 1-based, plus the header row.
        rows.push(map.extract(i + 2, &cells));
    }
    Ok(rows)
}

fn parse_xlsx(path: &Path) -> AppResult<Vec<RawRow>> {
    use calamine::{Data, Reader};

    let mut workbook = calamine::open_workbook_auto(path)
        .map_err(|e| AppError::InvalidInput(format!("could not open workbook: {e}")))?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| AppError::InvalidInput("workbook has no worksheets".into()))?
        .map_err(|e| AppError::InvalidInput(format!("could not read worksheet: {e}")))?;

    let cell_to_string = |d: &Data| -> String {
        match d {
            Data::Empty => String::new(),
            Data::String(s) => s.clone(),
            // Ports come back as floats from Excel; render 22.0 as "22".
            Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
            other => other.to_string(),
        }
    };

    let mut iter = range.rows();
    let headers: Vec<String> = iter
        .next()
        .ok_or_else(|| AppError::InvalidInput("worksheet is empty".into()))?
        .iter()
        .map(cell_to_string)
        .collect();
    let map = ColumnMap::from_headers(&headers)?;

    let mut rows = Vec::new();
    for (i, row) in iter.enumerate() {
        let cells: Vec<String> = row.iter().map(cell_to_string).collect();
        if cells.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        rows.push(map.extract(i + 2, &cells));
    }
    Ok(rows)
}

/// Composite endpoint key for duplicate detection: a host is "the same" only
/// when hostname (case-insensitive), port AND username all match (H5, 2026-06-15
/// — supersedes the hostname-only dedup). Username is case-sensitive (Linux
/// usernames are). Callers build this for existing DB hosts; the importer builds
/// the same key per row.
pub fn endpoint_key(hostname: &str, port: u16, username: &str) -> String {
    format!("{}|{}|{}", hostname.to_ascii_lowercase(), port, username)
}

/// Validates raw rows against the same rules as the host form (D-025) plus
/// duplicate-label detection against `existing_labels` and earlier rows.
pub fn validate_rows(existing_labels: &HashSet<String>, rows: Vec<RawRow>) -> Vec<RowPreview> {
    validate_inner(existing_labels, None, rows)
}

/// Like `validate_rows`, but also rejects rows whose (hostname, port, username)
/// endpoint already belongs to another host — in the DB (`existing_endpoints`,
/// keyed via [`endpoint_key`]) or earlier in the same file. Used by import so
/// the same connection can't be added twice; differing port or username is a
/// distinct host and imports normally (H5).
pub fn validate_rows_with_endpoints(
    existing_labels: &HashSet<String>,
    existing_endpoints: &HashSet<String>,
    rows: Vec<RawRow>,
) -> Vec<RowPreview> {
    validate_inner(existing_labels, Some(existing_endpoints), rows)
}

fn validate_inner(
    existing_labels: &HashSet<String>,
    existing_endpoints: Option<&HashSet<String>>,
    rows: Vec<RawRow>,
) -> Vec<RowPreview> {
    let mut seen_labels: HashSet<String> = HashSet::new();
    let mut seen_endpoints: HashSet<String> = HashSet::new();
    rows.into_iter()
        .map(|row| {
            let preview = validate_row(&row);
            if preview.status != RowStatus::Ready {
                return preview;
            }
            let label = preview.label.clone();
            if existing_labels.contains(&label) || seen_labels.contains(&label) {
                return RowPreview {
                    status: RowStatus::Duplicate,
                    message: Some("skipped — duplicate label".into()),
                    ..preview
                };
            }
            // Endpoint (hostname+port+username) dedup, only when the caller
            // opts in (import does). Differing port or username = distinct.
            let key = endpoint_key(&preview.hostname, preview.port, &preview.username);
            if let Some(existing) = existing_endpoints {
                if existing.contains(&key) || seen_endpoints.contains(&key) {
                    return RowPreview {
                        status: RowStatus::Duplicate,
                        message: Some(format!(
                            "skipped — {}@{}:{} already exists",
                            preview.username, preview.hostname, preview.port
                        )),
                        ..preview
                    };
                }
                seen_endpoints.insert(key);
            }
            seen_labels.insert(label);
            preview
        })
        .collect()
}

fn validate_row(row: &RawRow) -> RowPreview {
    let mut preview = RowPreview {
        row_number: row.row_number,
        label: row.label.clone(),
        hostname: row.hostname.clone(),
        port: 22,
        username: row.username.clone(),
        color: row.color.clone(),
        tag: (!row.tag.is_empty()).then(|| row.tag.clone()),
        linux_flavor: None,
        notes: (!row.notes.is_empty()).then(|| row.notes.clone()),
        status: RowStatus::Ready,
        message: None,
    };
    let fail = |preview: &mut RowPreview, msg: String| {
        preview.status = RowStatus::Error;
        preview.message = Some(msg);
    };

    if row.label.is_empty() {
        fail(&mut preview, "label is required".into());
        return preview;
    }
    if row.hostname.is_empty() {
        fail(&mut preview, "hostname is required".into());
        return preview;
    }
    if !is_valid_hostname_or_ip(&row.hostname) {
        fail(
            &mut preview,
            format!("\"{}\" is not a valid hostname or IP address", row.hostname),
        );
        return preview;
    }
    if row.username.is_empty() {
        fail(&mut preview, "username is required".into());
        return preview;
    }

    if row.port.is_empty() {
        preview.port = 22;
    } else {
        match row.port.parse::<u32>() {
            Ok(p) if (1..=65535).contains(&p) => preview.port = p as u16,
            _ => {
                fail(&mut preview, format!("port \"{}\" must be 1-65535", row.port));
                return preview;
            }
        }
    }

    // Color: empty or #auto (case-insensitive) -> app-side palette pick.
    if row.color.is_empty() || row.color.eq_ignore_ascii_case("#auto") {
        preview.color = "#auto".into();
    } else if !is_hex_color(&row.color) {
        fail(
            &mut preview,
            format!("color \"{}\" must be a hex value like #3b82f6 or #auto", row.color),
        );
        return preview;
    }

    if !row.linux_flavor.is_empty() {
        let flavor = row.linux_flavor.to_ascii_lowercase();
        if !FLAVORS.contains(&flavor.as_str()) {
            fail(
                &mut preview,
                format!(
                    "unknown linux_flavor \"{}\" (use one of: {})",
                    row.linux_flavor,
                    FLAVORS.join(", ")
                ),
            );
            return preview;
        }
        preview.linux_flavor = Some(flavor);
    }

    preview
}

fn is_hex_color(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('#') else {
        return false;
    };
    matches!(rest.len(), 3 | 6) && rest.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_valid_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| {
        !p.is_empty()
            && p.chars().all(|c| c.is_ascii_digit())
            && !(p.len() > 1 && p.starts_with('0'))
            && p.parse::<u32>().map(|n| n <= 255).unwrap_or(false)
    })
}

fn is_valid_ipv6(s: &str) -> bool {
    if !s.contains(':') {
        return false;
    }
    if s.matches("::").count() > 1 {
        return false;
    }
    let groups: Vec<&str> = s.split(':').collect();
    let has_elision = s.contains("::");
    let non_empty: Vec<&str> = groups.iter().copied().filter(|g| !g.is_empty()).collect();
    if !has_elision && groups.len() != 8 {
        return false;
    }
    if has_elision && non_empty.len() > 7 {
        return false;
    }
    non_empty
        .iter()
        .all(|g| g.len() <= 4 && g.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_valid_hostname(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    s.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Mirrors the host form's hostname rule (RFC 1123 name, strict IPv4, or
/// simplified IPv6).
fn is_valid_hostname_or_ip(s: &str) -> bool {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return is_valid_ipv4(s);
    }
    if s.contains(':') {
        return is_valid_ipv6(s);
    }
    is_valid_hostname(s)
}

#[cfg(test)]
mod tests;
