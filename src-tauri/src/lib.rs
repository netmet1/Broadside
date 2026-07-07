// Public so the integration test crate (tests/) can drive the ssh + db
// layers directly against docker fixtures.
pub mod admin_lock;
pub mod audit;
pub mod commands;
pub mod credentials;
pub mod crypto;
pub mod db;
pub mod errlog;
pub mod error;
pub mod export;
pub mod guard;
pub mod import;
mod licensing;
pub mod local;
pub mod omni;
pub mod probe;
pub mod session;
pub mod ssh;

use tauri::Manager;
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Reveal the main window once the webview has painted (the frontend calls this
/// after first paint). Showing here — rather than in `setup` — means the window
/// only ever appears with content already drawn.
///
/// Maximize is applied *here*, after the window is visible. Maximizing a hidden
/// window makes tao briefly `ShowWindow(SW_MAXIMIZE)` then `SW_HIDE` it, which
/// flashes an empty frame on launch (the reason we skip the window-state
/// plugin's initial restore of the maximized flag). Maximizing a window that is
/// already visible is just a normal maximize, no flash.
#[tauri::command]
fn reveal_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.restore_state(StateFlags::MAXIMIZED);
}

/// Keep the (restored) main window visible: if its rectangle does not overlap
/// any connected monitor, center it on the primary screen. Covers the case
/// where the window was last on a monitor that has since been disconnected.
fn ensure_window_on_screen(window: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let overlaps_a_monitor = monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let (mx2, my2) = (mp.x + ms.width as i32, mp.y + ms.height as i32);
        let (wx2, wy2) = (pos.x + w, pos.y + h);
        pos.x < mx2 && wx2 > mp.x && pos.y < my2 && wy2 > mp.y
    });
    if overlaps_a_monitor {
        return;
    }
    if let Ok(Some(primary)) = window.primary_monitor() {
        let mp = primary.position();
        let ms = primary.size();
        let x = mp.x + (ms.width as i32 - w).max(0) / 2;
        let y = mp.y + (ms.height as i32 - h).max(0) / 2;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _tier = licensing::entitlement();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Remember the window size, position and maximized state across restarts
        // (saved on exit, restored on launch). The recenter check in setup below
        // handles a saved monitor that is no longer connected.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                )
                // Save all three flags on exit, but skip the automatic restore at
                // window creation — it maximizes the still-hidden window, which
                // flashes an empty frame. We restore geometry (no flash) in
                // `setup` and maximize after the window is shown instead.
                .skip_initial_state("main")
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();
            let db_state = db::init(&handle)?;

            let app_data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;

            // Rolling audit log (D-011): on by default, persisted toggle.
            let audit_enabled = {
                let conn = db_state.0.lock().expect("fresh db mutex");
                db::settings::get_bool(&conn, "audit_enabled", true)?
            };
            app.manage(audit::AuditState::new(app_data_dir.clone(), audit_enabled));

            // Rolling error log (D-055): always-on, separate from audit.
            app.manage(errlog::ErrLogState::new(app_data_dir.clone()));

            app.manage(db_state);

            let cred_state = credentials::CredentialState::new(app_data_dir);
            app.manage(cred_state);

            app.manage(ssh::pty::PtyState::default());

            // Live SFTP browser sessions (kept open between operations).
            app.manage(ssh::sftp::SftpState::default());

            // Admin lock unlock state — fresh (locked) on every launch.
            app.manage(admin_lock::AdminLockState::default());

            // Detect local shells now, in the background, so the first page
            // that asks (Terminals launcher, Settings) gets an instant cache
            // hit instead of paying the wsl.exe spawn (seconds when cold).
            local::prewarm_shells();

            // Restore size + position now (while the window is still hidden, so
            // there is no flash), but NOT the maximized flag — that is applied
            // after the window is shown in `reveal_main_window`. If the restored
            // geometry is off every connected monitor (e.g. the monitor it was
            // on was unplugged), recenter on the primary screen.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.restore_state(StateFlags::SIZE | StateFlags::POSITION);
                ensure_window_on_screen(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reveal_main_window,
            commands::hosts::list_hosts,
            commands::hosts::get_host,
            commands::hosts::create_host,
            commands::hosts::update_host,
            commands::hosts::delete_host,
            commands::hosts::export_hosts,
            commands::hosts::path_is_file,
            commands::credentials::set_host_credentials,
            commands::credentials::clear_host_credentials,
            commands::credentials::is_credentials_unlocked,
            commands::credentials::requires_master_password,
            commands::credentials::unlock_credentials,
            commands::ssh::test_connection,
            commands::ssh::trust_host_key,
            commands::ssh::remove_host_key,
            commands::credentials::set_sudo_password,
            commands::credentials::set_sudo_same_as_login,
            commands::broadcast::check_destructive,
            commands::broadcast::broadcast_command,
            commands::broadcast::broadcast_history_list,
            commands::broadcast::broadcast_history_clear,
            commands::pty::pty_open,
            commands::pty::pty_open_local,
            commands::pty::list_local_shells,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::pty::pty_history_add,
            commands::pty::pty_history_list,
            commands::pty::pty_history_clear,
            commands::pty::omni_log_command,
            commands::pty::omni_blocks_add,
            commands::pty::omni_blocks_list,
            commands::pty::omni_blocks_clear,
            commands::pty::omni_blocks_delete,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_ensure_remote_dir,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_scan_dir,
            commands::sftp::sftp_upload_dir,
            commands::sftp::sftp_download_dir,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_disconnect,
            commands::localfs::local_home_dir,
            commands::localfs::local_list_dir,
            commands::localfs::local_list_drives,
            commands::localfs::local_mkdir,
            commands::localfs::local_delete,
            commands::localfs::local_scan_dir,
            commands::session::save_session,
            commands::session::session_is_encrypted,
            commands::session::load_session,
            commands::audit::audit_info,
            commands::audit::audit_tail,
            commands::audit::set_audit_enabled,
            commands::audit::export_audit_log,
            commands::errlog::error_log_tail,
            commands::errlog::clear_error_log,
            commands::errlog::export_error_log,
            commands::errlog::read_log_lines,
            commands::backup::backup_app_data,
            commands::backup::restore_app_data,
            commands::settings::get_app_settings,
            commands::settings::set_app_settings,
            commands::settings::reset_app_settings,
            commands::settings::destroy_all_hosts,
            commands::settings::set_help_hints_enabled,
            commands::settings::set_sudo_autofill_enabled,
            commands::security::admin_lock_status,
            commands::security::set_admin_passcode,
            commands::security::verify_admin_passcode,
            commands::security::reset_admin_passcode,
            commands::security::remove_admin_lock,
            commands::settings::set_ui_settings,
            commands::settings::save_shortcuts,
            commands::settings::save_guard_rules,
            commands::settings::recalibrate_probe,
            commands::settings::network_probe,
            commands::settings::command_history,
            commands::settings::clear_command_history,
            commands::import::preview_import,
            commands::import::import_hosts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
