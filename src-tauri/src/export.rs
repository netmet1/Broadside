//! Hosts → CSV export. The column set mirrors the bulk-import format
//! (D-025) so an exported file round-trips through "Import hosts…" as-is.
//! Credentials are never exported (same rule as import — D-025).

use std::path::Path;

use crate::db::hosts::Host;
use crate::error::{AppError, AppResult};

pub const EXPORT_HEADERS: [&str; 7] = [
    "label",
    "hostname",
    "port",
    "username",
    "color",
    "linux_flavor",
    "notes",
];

pub fn write_hosts_csv(hosts: &[Host], path: &Path) -> AppResult<()> {
    let mut wtr = csv::Writer::from_path(path)
        .map_err(|e| AppError::State(format!("could not create CSV: {e}")))?;
    wtr.write_record(EXPORT_HEADERS)
        .map_err(|e| AppError::State(format!("CSV write: {e}")))?;
    for h in hosts {
        wtr.write_record([
            h.label.as_str(),
            h.hostname.as_str(),
            &h.port.to_string(),
            h.username.as_str(),
            h.color.as_str(),
            h.linux_flavor.as_deref().unwrap_or(""),
            h.notes.as_deref().unwrap_or(""),
        ])
        .map_err(|e| AppError::State(format!("CSV write: {e}")))?;
    }
    wtr.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::hosts::{self, HostInput};
    use crate::db::open_in_memory;

    fn input(label: &str, notes: Option<&str>) -> HostInput {
        HostInput {
            label: label.into(),
            hostname: "10.0.0.1".into(),
            port: 22,
            username: "ops".into(),
            color: "#3b82f6".into(),
            linux_flavor: Some("ubuntu".into()),
            notes: notes.map(Into::into),
        }
    }

    #[test]
    fn export_writes_header_and_rows() {
        let conn = open_in_memory().unwrap();
        hosts::create(&conn, input("web-01", Some("primary"))).unwrap();
        hosts::create(&conn, input("web-02", None)).unwrap();
        let all = hosts::list_all(&conn).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.csv");
        write_hosts_csv(&all, &path).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines = text.lines();
        assert_eq!(
            lines.next().unwrap(),
            "label,hostname,port,username,color,linux_flavor,notes"
        );
        assert_eq!(
            lines.next().unwrap(),
            "web-01,10.0.0.1,22,ops,#3b82f6,ubuntu,primary"
        );
        // Empty optionals export as empty cells, not literal "None".
        assert_eq!(lines.next().unwrap(), "web-02,10.0.0.1,22,ops,#3b82f6,ubuntu,");
        assert_eq!(lines.next(), None);
    }

    #[test]
    fn export_quotes_fields_with_commas() {
        let conn = open_in_memory().unwrap();
        hosts::create(&conn, input("db-01", Some("rack 4, row 2"))).unwrap();
        let all = hosts::list_all(&conn).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.csv");
        write_hosts_csv(&all, &path).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"rack 4, row 2\""));
    }

    #[test]
    fn export_round_trips_through_import() {
        let conn = open_in_memory().unwrap();
        hosts::create(&conn, input("web-01", Some("primary"))).unwrap();
        let all = hosts::list_all(&conn).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.csv");
        write_hosts_csv(&all, &path).unwrap();

        // An exported file parses and validates cleanly through the
        // bulk-import path (header mapping + same validation rules).
        let raw = crate::import::parse_file(&path).unwrap();
        let previews =
            crate::import::validate_rows(&std::collections::HashSet::new(), raw);
        assert_eq!(previews.len(), 1);
        assert!(matches!(previews[0].status, crate::import::RowStatus::Ready));
        assert_eq!(previews[0].label, "web-01");
        assert_eq!(previews[0].notes.as_deref(), Some("primary"));
    }
}
