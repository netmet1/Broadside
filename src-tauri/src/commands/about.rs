//! The About dialog's one outside link.

use crate::error::{AppError, AppResult};

/// Where Donate goes. Kept here rather than passed in, so the webview can ask
/// for this page and nothing else: there is no command that opens a URL of
/// its choosing.
const DONATE_URL: &str = "https://ko-fi.com/netmet";

/// Opens the donations page in the default browser.
#[tauri::command]
pub fn open_donate_page() -> AppResult<()> {
    open::that_detached(DONATE_URL)
        .map_err(|e| AppError::State(format!("could not open the browser: {e}")))
}
