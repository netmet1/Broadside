//! The handbook that ships beside the app.
//!
//! Help is a tab in the window, and it is also a PDF: the same sections, laid
//! out as a document, built at release time by `scripts/help-pdf` and carried
//! along as a bundled resource. All this end of it does is hand a copy to the
//! user, so the file they save is byte for byte the one that shipped.
//!
//! It is deliberately not generated on demand. Printing needs a browser and a
//! layout pass, neither of which belongs inside a running SSH console, and a
//! document that is built fresh every time is a document nobody has ever
//! actually looked at.

use std::fs;
use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::Manager;

use crate::error::{AppError, AppResult};

/// The bundled PDF's path. Resolved through the resource directory, so it is
/// the installed copy in a release and `src-tauri/resources` under `tauri dev`.
fn bundled_pdf(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let path = app
        .path()
        .resolve("resources/broadside-help.pdf", BaseDirectory::Resource)
        .map_err(|e| AppError::LocalFs(format!("cannot locate the help PDF: {e}")))?;
    if !path.is_file() {
        // A development build that has never run the PDF script, or an install
        // missing a file. Either way the button should say so rather than
        // failing with something about a path.
        return Err(AppError::LocalFs(
            "This build has no help PDF. It is created at release time; \
             the Help tab in the app has the same content."
                .to_string(),
        ));
    }
    Ok(path)
}

/// Whether this build carries a help PDF, so the button can be hidden rather
/// than offered and then refused.
#[tauri::command]
pub fn help_pdf_available(app: tauri::AppHandle) -> bool {
    bundled_pdf(&app).is_ok()
}

/// Copies the bundled help PDF to `dest`, which the user picked in a save
/// dialog. Returns the size written, for the confirmation toast.
#[tauri::command]
pub fn export_help_pdf(app: tauri::AppHandle, dest: String) -> AppResult<u64> {
    let src = bundled_pdf(&app)?;
    if dest.trim().is_empty() {
        return Err(AppError::InvalidInput("no destination given".to_string()));
    }
    let written = fs::copy(&src, PathBuf::from(&dest))?;
    Ok(written)
}
