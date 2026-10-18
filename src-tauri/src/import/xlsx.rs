//! Reads the first worksheet of an `.xlsx` file as rows of text.
//!
//! Written for the host import instead of using a spreadsheet crate, because
//! all the import needs is the cell text of one sheet, and a general reader
//! (formats, dates, `.xls`, `.ods`, formulas) is a lot of parser to point at a
//! file somebody may have been sent. Everything here treats the file as
//! hostile:
//!
//! - Nothing is extracted to disk. Parts are read by name, in memory.
//! - Every read is capped by bytes actually decompressed, never by the size a
//!   zip header claims, so a zip bomb stops at [`MAX_PART_BYTES`].
//! - Rows and columns are capped, so a cell reference like `XFD1048576` cannot
//!   make one row sixteen thousand cells wide.
//! - XML entities are the five predefined ones and character references only.
//!   There is no DTD processing at all, so no external or expanding entities.

use std::collections::BTreeMap;
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::events::{BytesRef, Event};
use quick_xml::Reader;

use crate::error::{AppError, AppResult};

/// The largest `.xlsx` the import opens. A few thousand hosts is well under a
/// megabyte.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// The most one part of the archive may decompress to.
const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;
/// The most rows a sheet may have, header included.
const MAX_ROWS: usize = 50_000;
/// Columns past this are ignored. The import reads eight.
const MAX_COLS: usize = 256;

fn bad(msg: impl Into<String>) -> AppError {
    AppError::InvalidInput(msg.into())
}

/// The sheet's rows, each with its 1-based row number as Excel shows it, and
/// its cells by column from A. Rows with no cells at all are left out.
pub fn read_first_sheet(path: &Path) -> AppResult<Vec<(usize, Vec<String>)>> {
    let file =
        std::fs::File::open(path).map_err(|e| bad(format!("could not open workbook: {e}")))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_FILE_BYTES {
        return Err(bad("workbook is too large to import"));
    }
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| bad(format!("could not open workbook: {e}")))?;

    let sheet_path = first_sheet_path(&mut zip)?;
    let shared = match read_part(&mut zip, "xl/sharedStrings.xml")? {
        Some(xml) => shared_strings(&xml)?,
        None => Vec::new(),
    };
    let sheet =
        read_part(&mut zip, &sheet_path)?.ok_or_else(|| bad("workbook has no worksheets"))?;
    sheet_rows(&sheet, &shared)
}

/// A part's text, or None when the archive has no part of that name.
fn read_part<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> AppResult<Option<String>> {
    let entry = match zip.by_name(name) {
        Ok(e) => e,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(bad(format!("could not read workbook: {e}"))),
    };
    let mut buf = Vec::new();
    entry
        .take(MAX_PART_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| bad(format!("could not read workbook: {e}")))?;
    if buf.len() as u64 > MAX_PART_BYTES {
        return Err(bad("workbook is too large to import"));
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| bad("workbook is not valid UTF-8"))
}

/// Where the first sheet lives: the first `<sheet>` in the workbook, looked
/// up in the workbook's relationships. Falls back to the conventional name
/// when either part is missing, as some writers leave them out.
fn first_sheet_path<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> AppResult<String> {
    const FALLBACK: &str = "xl/worksheets/sheet1.xml";
    let (Some(workbook), Some(rels)) = (
        read_part(zip, "xl/workbook.xml")?,
        read_part(zip, "xl/_rels/workbook.xml.rels")?,
    ) else {
        return Ok(FALLBACK.into());
    };
    let Some(rid) = first_attr(&workbook, b"sheet", b"r:id")? else {
        return Ok(FALLBACK.into());
    };

    let mut reader = Reader::from_str(&rels);
    loop {
        match reader.read_event().map_err(xml_err)? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                if attr(&e, b"Id")?.as_deref() == Some(rid.as_str()) {
                    let target = attr(&e, b"Target")?.unwrap_or_default();
                    return part_name(&target);
                }
            }
            Event::Eof => return Ok(FALLBACK.into()),
            _ => {}
        }
    }
}

/// A relationship target as a part name in the archive. Relative targets are
/// relative to `xl/`; absolute ones start at the archive root.
fn part_name(target: &str) -> AppResult<String> {
    let name = match target.strip_prefix('/') {
        Some(abs) => abs.to_string(),
        None => format!("xl/{target}"),
    };
    if name.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(bad("workbook names a sheet outside itself"));
    }
    Ok(name)
}

/// The value of `attr_name` on the first element named `element`.
fn first_attr(xml: &str, element: &[u8], attr_name: &[u8]) -> AppResult<Option<String>> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event().map_err(xml_err)? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == element => {
                return attr(&e, attr_name);
            }
            Event::Eof => return Ok(None),
            _ => {}
        }
    }
}

fn attr(e: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> AppResult<Option<String>> {
    match e.try_get_attribute(name).map_err(xml_err)? {
        Some(a) => Ok(Some(
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map_err(xml_err)?
                .into_owned(),
        )),
        None => Ok(None),
    }
}

fn xml_err(e: impl std::fmt::Display) -> AppError {
    bad(format!("could not read workbook: {e}"))
}

/// Appends the text of an entity or character reference. Only the predefined
/// entities exist here; anything else is an error rather than a guess.
fn push_ref(out: &mut String, r: &BytesRef<'_>) -> AppResult<()> {
    if let Some(c) = r.resolve_char_ref().map_err(xml_err)? {
        out.push(c);
        return Ok(());
    }
    let name = r.decode().map_err(xml_err)?;
    let text = quick_xml::escape::resolve_xml_entity(&name)
        .ok_or_else(|| bad(format!("could not read workbook: unknown entity &{name};")))?;
    out.push_str(text);
    Ok(())
}

/// The shared string table, in order. A string is the text of its `<t>`
/// elements, run by run, leaving out phonetic guides (`<rPh>`).
fn shared_strings(xml: &str) -> AppResult<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut in_t = false;
    let mut phonetic = 0usize;
    loop {
        match reader.read_event().map_err(xml_err)? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"si" => current = Some(String::new()),
                b"rPh" => phonetic += 1,
                b"t" => in_t = true,
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == b"si" => out.push(String::new()),
            Event::End(e) => match e.local_name().as_ref() {
                b"si" => out.push(current.take().unwrap_or_default()),
                b"rPh" => phonetic = phonetic.saturating_sub(1),
                b"t" => in_t = false,
                _ => {}
            },
            Event::Text(t) if in_t && phonetic == 0 => {
                if let Some(s) = current.as_mut() {
                    s.push_str(&t.decode().map_err(xml_err)?);
                }
            }
            Event::CData(t) if in_t && phonetic == 0 => {
                if let Some(s) = current.as_mut() {
                    s.push_str(&t.decode().map_err(xml_err)?);
                }
            }
            Event::GeneralRef(r) if in_t && phonetic == 0 => {
                if let Some(s) = current.as_mut() {
                    push_ref(s, &r)?;
                }
            }
            Event::Eof => return Ok(out),
            _ => {}
        }
    }
}

/// Column index from A = 0 and row number from 1, out of a reference like
/// `C12`. None for anything that is not one.
fn parse_ref(r: &str) -> Option<(usize, usize)> {
    let letters = r.bytes().take_while(u8::is_ascii_alphabetic).count();
    if letters == 0 || letters > 3 {
        return None;
    }
    let col = r[..letters].bytes().fold(0usize, |acc, b| {
        acc * 26 + (b.to_ascii_uppercase() - b'A' + 1) as usize
    }) - 1;
    let row = r[letters..].parse::<usize>().ok().filter(|&n| n > 0)?;
    Some((col, row))
}

/// How a number cell reads as text: a port typed as 22 is stored as `22`, and
/// sometimes `22.0` or `2.2E1` by other writers, and should read `22`.
fn number_text(raw: &str) -> String {
    match raw.trim().parse::<f64>() {
        Ok(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        _ => raw.trim().to_string(),
    }
}

/// One cell being read.
#[derive(Default)]
struct Cell {
    col: usize,
    kind: String,
    value: String,
    inline: String,
}

impl Cell {
    fn text(self, shared: &[String]) -> AppResult<String> {
        Ok(match self.kind.as_str() {
            "s" => {
                let i: usize = self
                    .value
                    .trim()
                    .parse()
                    .map_err(|_| bad("could not read workbook: bad shared string index"))?;
                shared
                    .get(i)
                    .cloned()
                    .ok_or_else(|| bad("could not read workbook: bad shared string index"))?
            }
            "inlineStr" => self.inline,
            "b" => match self.value.trim() {
                "1" => "true".into(),
                "0" => "false".into(),
                other => other.into(),
            },
            "" | "n" => number_text(&self.value),
            // str (formula text), e (error), d (ISO date): the text as stored.
            _ => self.value,
        })
    }
}

fn sheet_rows(xml: &str, shared: &[String]) -> AppResult<Vec<(usize, Vec<String>)>> {
    let mut reader = Reader::from_str(xml);
    let mut rows: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut row_no = 0usize;
    let mut next_col = 0usize;
    let mut cell: Option<Cell> = None;
    // Which text element we are inside: <v> or an inline string's <t>.
    let mut in_v = false;
    let mut in_t = false;
    let mut phonetic = 0usize;

    let finish =
        |rows: &mut BTreeMap<usize, Vec<String>>, row_no: usize, c: Cell| -> AppResult<()> {
            if c.col >= MAX_COLS {
                return Ok(());
            }
            let col = c.col;
            let text = c.text(shared)?;
            if text.is_empty() {
                return Ok(());
            }
            if !rows.contains_key(&row_no) && rows.len() >= MAX_ROWS {
                return Err(bad("worksheet has too many rows to import"));
            }
            let row = rows.entry(row_no).or_default();
            if row.len() <= col {
                row.resize(col + 1, String::new());
            }
            row[col] = text;
            Ok(())
        };

    loop {
        let event = reader.read_event().map_err(xml_err)?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.local_name().as_ref() {
                    b"row" => {
                        row_no = match attr(e, b"r")?.and_then(|r| r.trim().parse().ok()) {
                            Some(n) => n,
                            None => row_no + 1,
                        };
                        next_col = 0;
                    }
                    b"c" => {
                        let (col, row) = match attr(e, b"r")?.as_deref().and_then(parse_ref) {
                            Some((c, r)) => (c, Some(r)),
                            None => (next_col, None),
                        };
                        if let Some(r) = row {
                            row_no = r;
                        }
                        if row_no == 0 {
                            row_no = 1;
                        }
                        next_col = col + 1;
                        let c = Cell {
                            col,
                            kind: attr(e, b"t")?.unwrap_or_default(),
                            ..Cell::default()
                        };
                        if empty {
                            finish(&mut rows, row_no, c)?;
                        } else {
                            cell = Some(c);
                        }
                    }
                    b"v" if !empty => in_v = true,
                    b"t" if !empty => in_t = true,
                    b"rPh" if !empty => phonetic += 1,
                    _ => {}
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"c" => {
                    if let Some(c) = cell.take() {
                        finish(&mut rows, row_no, c)?;
                    }
                }
                b"v" => in_v = false,
                b"t" => in_t = false,
                b"rPh" => phonetic = phonetic.saturating_sub(1),
                _ => {}
            },
            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) => {
                let Some(c) = cell.as_mut() else { continue };
                let target = if in_v {
                    &mut c.value
                } else if in_t && phonetic == 0 {
                    &mut c.inline
                } else {
                    continue;
                };
                match event {
                    Event::Text(t) => target.push_str(&t.decode().map_err(xml_err)?),
                    Event::CData(t) => target.push_str(&t.decode().map_err(xml_err)?),
                    Event::GeneralRef(r) => push_ref(target, &r)?,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_references() {
        assert_eq!(parse_ref("A1"), Some((0, 1)));
        assert_eq!(parse_ref("AB12"), Some((27, 12)));
        assert_eq!(parse_ref("XFD1048576"), Some((16383, 1048576)));
        assert_eq!(parse_ref("1A"), None);
        assert_eq!(parse_ref("A0"), None);
        assert_eq!(parse_ref("ABCD1"), None);
    }

    #[test]
    fn numbers_read_as_people_typed_them() {
        assert_eq!(number_text("22"), "22");
        assert_eq!(number_text("22.0"), "22");
        assert_eq!(number_text("2.2E1"), "22");
        assert_eq!(number_text("1.5"), "1.5");
    }

    #[test]
    fn shared_strings_join_runs_and_skip_phonetics() {
        let xml = r#"<sst><si><t>plain &amp; simple</t></si>
            <si><r><t>rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></si>
            <si/><si><t>&#65;</t></si></sst>"#;
        assert_eq!(
            shared_strings(xml).unwrap(),
            vec!["plain & simple", "rich text", "", "A"]
        );
    }

    #[test]
    fn an_unknown_entity_is_refused() {
        let xml = r#"<sst><si><t>&evil;</t></si></sst>"#;
        assert!(shared_strings(xml).is_err());
    }

    #[test]
    fn cells_of_every_kind_and_position() {
        let shared = vec!["label".to_string(), "web-01".to_string()];
        let xml = r#"<worksheet><sheetData>
            <row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="inlineStr"><is><t>port</t></is></c></row>
            <row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3"><v>22</v></c><c r="D3" t="b"><v>1</v></c>
                <c r="E3" t="str"><f>A1</f><v>calc</v></c><c r="F3"/></row>
            <row r="4"></row>
        </sheetData></worksheet>"#;
        let rows = sheet_rows(xml, &shared).unwrap();
        assert_eq!(rows.len(), 2, "rows with no cells are left out");
        assert_eq!(rows[0], (2, vec!["".into(), "label".into(), "port".into()]));
        assert_eq!(
            rows[1],
            (
                3,
                vec![
                    "".into(),
                    "web-01".into(),
                    "22".into(),
                    "true".into(),
                    "calc".into()
                ]
            )
        );
    }

    #[test]
    fn a_far_column_is_ignored_rather_than_allocated() {
        let xml = r#"<worksheet><sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>a</t></is></c>
            <c r="XFD1" t="inlineStr"><is><t>far</t></is></c>
        </row></sheetData></worksheet>"#;
        let rows = sheet_rows(xml, &[]).unwrap();
        assert_eq!(rows, vec![(1, vec!["a".to_string()])]);
    }

    #[test]
    fn a_shared_index_out_of_range_is_an_error() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>9</v></c></row></sheetData></worksheet>"#;
        assert!(sheet_rows(xml, &[]).is_err());
    }

    #[test]
    fn sheet_targets() {
        assert_eq!(
            part_name("worksheets/sheet1.xml").unwrap(),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(
            part_name("/xl/worksheets/s.xml").unwrap(),
            "xl/worksheets/s.xml"
        );
        assert!(part_name("../../etc/x.xml").is_err());
    }

    #[test]
    fn a_zip_bomb_stops_at_the_cap() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bomb.xlsx");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        w.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        let chunk = vec![b' '; 1024 * 1024];
        for _ in 0..(MAX_PART_BYTES / chunk.len() as u64 + 2) {
            w.write_all(&chunk).unwrap();
        }
        w.finish().unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < MAX_FILE_BYTES);
        let err = read_first_sheet(&path).unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
    }
}
