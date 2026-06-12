use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

use super::*;

// ---- fixture helpers ----

fn write_csv(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

/// Builds a minimal real .xlsx (zip of OOXML parts) with one worksheet.
/// Cells that parse as numbers are written as number cells (like Excel
/// does for ports), everything else as inline strings.
fn write_xlsx(dir: &Path, name: &str, rows: &[Vec<&str>]) -> std::path::PathBuf {
    let path = dir.join(name);
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    let mut put = |name: &str, content: String| {
        zip.start_file(name, opts).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    };

    put(
        "[Content_Types].xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#
            .to_string(),
    );
    put(
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#
            .to_string(),
    );
    put(
        "xl/workbook.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#
            .to_string(),
    );
    put(
        "xl/_rels/workbook.xml.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#
            .to_string(),
    );

    let col_letter = |i: usize| -> String {
        // Enough for our fixture widths (A..Z).
        ((b'A' + i as u8) as char).to_string()
    };
    let mut sheet = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );
    for (r, row) in rows.iter().enumerate() {
        sheet.push_str(&format!(r#"<row r="{}">"#, r + 1));
        for (c, value) in row.iter().enumerate() {
            let cell_ref = format!("{}{}", col_letter(c), r + 1);
            if !value.is_empty() && value.parse::<f64>().is_ok() {
                sheet.push_str(&format!(r#"<c r="{cell_ref}"><v>{value}</v></c>"#));
            } else {
                sheet.push_str(&format!(
                    r#"<c r="{cell_ref}" t="inlineStr"><is><t>{value}</t></is></c>"#
                ));
            }
        }
        sheet.push_str("</row>");
    }
    sheet.push_str("</sheetData></worksheet>");
    put("xl/worksheets/sheet1.xml", sheet);

    zip.finish().unwrap();
    path
}

fn no_existing() -> HashSet<String> {
    HashSet::new()
}

// ---- CSV parsing ----

#[test]
fn csv_parses_with_all_columns() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(
        dir.path(),
        "hosts.csv",
        "label,hostname,username,port,color,linux_flavor,notes\n\
         web-01,web01.example.com,root,2222,#3b82f6,ubuntu,primary\n\
         web-02,10.0.0.5,deploy,,#auto,,\n",
    );
    let rows = parse_file(&path).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].row_number, 2);
    assert_eq!(rows[0].label, "web-01");
    assert_eq!(rows[0].port, "2222");
    assert_eq!(rows[1].port, "");
    assert_eq!(rows[1].color, "#auto");
}

#[test]
fn csv_required_columns_only_is_enough() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(
        dir.path(),
        "hosts.csv",
        "label,hostname,username\nweb-01,web01.example.com,root\n",
    );
    let rows = parse_file(&path).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].port, "");
    assert_eq!(rows[0].color, "");
}

#[test]
fn csv_headers_case_insensitive_and_reordered() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(
        dir.path(),
        "hosts.csv",
        "Username,LABEL,Hostname\nroot,web-01,web01.example.com\n",
    );
    let rows = parse_file(&path).unwrap();
    assert_eq!(rows[0].label, "web-01");
    assert_eq!(rows[0].username, "root");
}

#[test]
fn csv_missing_required_column_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(dir.path(), "hosts.csv", "label,hostname\na,b\n");
    let err = parse_file(&path).unwrap_err();
    assert!(err.to_string().contains("username"), "got: {err}");
}

#[test]
fn csv_blank_rows_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(
        dir.path(),
        "hosts.csv",
        "label,hostname,username\nweb-01,web01.example.com,root\n,,\n",
    );
    assert_eq!(parse_file(&path).unwrap().len(), 1);
}

#[test]
fn unsupported_extension_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_csv(dir.path(), "hosts.txt", "label,hostname,username\n");
    let err = parse_file(&path).unwrap_err();
    assert!(err.to_string().contains("unsupported"), "got: {err}");
}

// ---- xlsx parsing ----

#[test]
fn xlsx_parses_with_numeric_port() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_xlsx(
        dir.path(),
        "hosts.xlsx",
        &[
            vec!["label", "hostname", "username", "port", "color"],
            vec!["web-01", "web01.example.com", "root", "2222", "#auto"],
            vec!["web-02", "10.0.0.5", "deploy", "", ""],
        ],
    );
    let rows = parse_file(&path).unwrap();
    assert_eq!(rows.len(), 2);
    // Excel numbers come back as floats; 2222.0 must read as "2222".
    assert_eq!(rows[0].port, "2222");
    assert_eq!(rows[0].row_number, 2);
    assert_eq!(rows[1].label, "web-02");
}

#[test]
fn xlsx_missing_required_column_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_xlsx(
        dir.path(),
        "hosts.xlsx",
        &[vec!["label", "hostname"], vec!["a", "b"]],
    );
    let err = parse_file(&path).unwrap_err();
    assert!(err.to_string().contains("username"), "got: {err}");
}

// ---- validation ----

fn raw(label: &str, hostname: &str, username: &str) -> RawRow {
    RawRow {
        row_number: 2,
        label: label.into(),
        hostname: hostname.into(),
        username: username.into(),
        ..Default::default()
    }
}

#[test]
fn valid_row_ready_with_defaults() {
    let out = validate_rows(&no_existing(), vec![raw("a", "host.example.com", "root")]);
    assert_eq!(out[0].status, RowStatus::Ready);
    assert_eq!(out[0].port, 22);
    assert_eq!(out[0].color, "#auto");
    assert_eq!(out[0].linux_flavor, None);
}

#[test]
fn invalid_hostname_errors() {
    for bad in ["-bad.example.com", "a..b", "999.1.1.1", "host name"] {
        let out = validate_rows(&no_existing(), vec![raw("a", bad, "root")]);
        assert_eq!(out[0].status, RowStatus::Error, "hostname {bad:?}");
    }
}

#[test]
fn valid_hostnames_accepted() {
    for good in ["web01.example.com", "10.0.0.5", "::1", "fe80::1", "localhost"] {
        let out = validate_rows(&no_existing(), vec![raw("a", good, "root")]);
        assert_eq!(out[0].status, RowStatus::Ready, "hostname {good:?}");
    }
}

#[test]
fn bad_port_errors() {
    for bad in ["0", "65536", "abc", "-1"] {
        let mut r = raw("a", "host.example.com", "root");
        r.port = bad.into();
        let out = validate_rows(&no_existing(), vec![r]);
        assert_eq!(out[0].status, RowStatus::Error, "port {bad:?}");
    }
}

#[test]
fn color_auto_and_hex_and_bad() {
    let mut auto = raw("a", "h.example.com", "root");
    auto.color = "#AUTO".into();
    let mut hex = raw("b", "h.example.com", "root");
    hex.color = "#abc".into();
    let mut bad = raw("c", "h.example.com", "root");
    bad.color = "blue".into();
    let out = validate_rows(&no_existing(), vec![auto, hex, bad]);
    assert_eq!(out[0].color, "#auto");
    assert_eq!(out[0].status, RowStatus::Ready);
    assert_eq!(out[1].color, "#abc");
    assert_eq!(out[1].status, RowStatus::Ready);
    assert_eq!(out[2].status, RowStatus::Error);
}

#[test]
fn flavor_normalized_or_rejected() {
    let mut ok = raw("a", "h.example.com", "root");
    ok.linux_flavor = "Ubuntu".into();
    let mut bad = raw("b", "h.example.com", "root");
    bad.linux_flavor = "windows".into();
    let out = validate_rows(&no_existing(), vec![ok, bad]);
    assert_eq!(out[0].linux_flavor.as_deref(), Some("ubuntu"));
    assert_eq!(out[1].status, RowStatus::Error);
}

#[test]
fn duplicate_against_db_and_within_file() {
    let mut existing = HashSet::new();
    existing.insert("web-01".to_string());
    let out = validate_rows(
        &existing,
        vec![
            raw("web-01", "h1.example.com", "root"),
            raw("web-02", "h2.example.com", "root"),
            raw("web-02", "h3.example.com", "root"),
        ],
    );
    assert_eq!(out[0].status, RowStatus::Duplicate);
    assert_eq!(out[1].status, RowStatus::Ready);
    assert_eq!(out[2].status, RowStatus::Duplicate);
}

#[test]
fn error_rows_do_not_claim_labels() {
    // An invalid row's label shouldn't block a later valid row from using it.
    let mut bad = raw("web-01", "not a host", "root");
    bad.hostname = "bad host".into();
    let out = validate_rows(
        &no_existing(),
        vec![bad, raw("web-01", "h.example.com", "root")],
    );
    assert_eq!(out[0].status, RowStatus::Error);
    assert_eq!(out[1].status, RowStatus::Ready);
}
