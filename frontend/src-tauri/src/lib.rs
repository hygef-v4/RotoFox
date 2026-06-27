use tauri_plugin_shell::ShellExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Spawn the python backend sidecar
            // The sidecar is managed by Tauri and will be terminated when the app exits.
            match app.shell().sidecar("binaries/rotofox-backend") {
                Ok(sidecar) => {
                    match sidecar.spawn() {
                        Ok((_rx, _child)) => {
                            println!("RotoFox sidecar backend spawned successfully.");
                        }
                        Err(err) => {
                            eprintln!("Error: failed to spawn sidecar backend child process: {}", err);
                        }
                    }
                }
                Err(err) => {
                    eprintln!("Error: failed to initialize sidecar backend binary: {}", err);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
