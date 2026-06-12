// Public so the integration test crate (tests/) can drive the ssh + db
// layers directly against docker fixtures.
pub mod audit;
pub mod commands;
pub mod credentials;
pub mod crypto;
pub mod db;
pub mod error;
pub mod guard;
pub mod import;
mod licensing;
pub mod probe;
pub mod session;
pub mod ssh;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _tier = licensing::entitlement();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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

            app.manage(db_state);

            let cred_state = credentials::CredentialState::new(app_data_dir);
            app.manage(cred_state);

            app.manage(ssh::pty::PtyState::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hosts::list_hosts,
            commands::hosts::get_host,
            commands::hosts::create_host,
            commands::hosts::update_host,
            commands::hosts::delete_host,
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
            commands::pty::pty_open,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::session::save_session,
            commands::session::session_is_encrypted,
            commands::session::load_session,
            commands::audit::audit_info,
            commands::audit::audit_tail,
            commands::audit::set_audit_enabled,
            commands::settings::get_app_settings,
            commands::settings::set_app_settings,
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
