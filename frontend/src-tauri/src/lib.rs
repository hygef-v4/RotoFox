use std::env;
use std::process::Command;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Fix portable working directory issue:
            // Ensure the app's working directory is the folder containing the executable.
            // This is critical for PyInstaller --onedir sidecars to find their _internal/ folder.
            if let Ok(exe_path) = env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let _ = env::set_current_dir(exe_dir);
                    println!("Set working directory to: {}", exe_dir.display());
                }
            }

            // Spawn the python backend sidecar manually.
            // Since we set current_dir, it will find it right next to the .exe.
            let sidecar_exe = "rotofox-backend-x86_64-pc-windows-msvc.exe";
            match Command::new(sidecar_exe).spawn() {
                Ok(child) => {
                    println!("RotoFox sidecar backend spawned successfully (PID: {}).", child.id());
                }
                Err(err) => {
                    eprintln!("Error: failed to spawn sidecar backend child process: {}", err);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
