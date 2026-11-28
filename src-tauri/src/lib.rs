mod auth_flow;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str, language: &str) -> String {
    match language {
        "fr" => format!("Bonjour, {} ! Vous avez été salué depuis Rust !", name),
        _ => format!("Hello, {}! You've been greeted from Rust!", name),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        use tauri::Manager;

        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.set_focus() {
                        eprintln!("Unable to focus the main window: {error}");
                    }
                }
            },
        ));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(all(debug_assertions, windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                app.deep_link().register_all()?;
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            auth_flow::store_pending_desktop_auth,
            auth_flow::get_pending_desktop_auth,
            auth_flow::clear_pending_desktop_auth,
            auth_flow::validate_desktop_auth_callback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
