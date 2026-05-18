mod commands;
mod db;
mod error;
mod licensing;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _tier = licensing::entitlement();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db_state = db::init(&app.handle())?;
            app.manage(db_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hosts::list_hosts,
            commands::hosts::get_host,
            commands::hosts::create_host,
            commands::hosts::update_host,
            commands::hosts::delete_host,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
