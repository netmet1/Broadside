mod commands;
mod credentials;
mod db;
mod error;
mod licensing;

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
            app.manage(db_state);

            let app_data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            let cred_state = credentials::CredentialState::new(app_data_dir);
            app.manage(cred_state);

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
