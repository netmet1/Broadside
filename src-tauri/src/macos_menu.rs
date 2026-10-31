//! The macOS menu bar.
//!
//! A Mac app without one is missing more than a menu: the Edit items are what
//! make ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z work in every text field, because macOS routes
//! those keys through the menu. Tauri installs a default bar when an app sets
//! none, and this replaces it for one reason: its Quit is the system's own
//! `terminate:`, which ends the process without ever asking the window, so ⌘Q
//! walked straight past the exit guard that warns about live sessions. Here
//! Quit closes the main window instead, which is exactly what clicking its red
//! button does, so the guard sees it, and when nothing is connected the app
//! quits as before with its last window.
//!
//! Dock → Quit and logging out still go through `terminate:`; nothing an app
//! can hook asks first on that path. Help says so.
//!
//! No item here carries one of the app's own shortcuts (⌘F, ⌘⇧G, ⌘⇧T, ⇧⌘↩,
//! ⌘⌥←/→), so a menu can never take a key the terminals expect.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

const QUIT: &str = "broadside-quit";

pub fn build(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let quit = MenuItem::with_id(app, QUIT, "Quit Broadside", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Broadside",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // Close Window is `performClose:`, which raises the same close request as
    // the red button, so ⌘W is guarded too.
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

pub fn on_event(app: &AppHandle<Wry>, event: MenuEvent) {
    if event.id().as_ref() == QUIT {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.close();
        }
    }
}
