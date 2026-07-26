use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Handle to the Python backend process.
///
/// The previous implementation spawned the sidecar with `std::process::Command`
/// and dropped the returned `Child` immediately. Rust does not kill a child on
/// drop, and no exit handler was registered, so closing RotoFox left the
/// backend running forever — holding a loaded model in VRAM and, more visibly,
/// keeping port 8000 bound. The next launch then spawned a second backend that
/// could not bind, died silently, and left the UI stuck on its loading screen.
///
/// Keeping the handle in managed state lets the exit handler shut it down.
struct BackendProcess(Mutex<Option<CommandChild>>);

/// Sidecar base name. Tauri appends the platform target triple, so the same
/// name resolves to `rotofox-backend-x86_64-pc-windows-msvc.exe` on Windows and
/// `rotofox-backend-x86_64-unknown-linux-gnu` on Linux. The old code hard-coded
/// the Windows filename, which made the documented Linux support impossible.
const SIDECAR_NAME: &str = "rotofox-backend";

/// Terminate the backend if it is still running.
fn shutdown_backend(state: &BackendProcess) {
    let child = match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };

    if let Some(child) = child {
        match child.kill() {
            Ok(()) => println!("RotoFox backend stopped."),
            Err(err) => eprintln!("Could not stop the RotoFox backend: {err}"),
        }
    }
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendProcess>) {
    shutdown_backend(&state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![stop_backend])
        .setup(|app| {
            // Spawn through the Tauri sidecar API rather than a bare
            // `Command::new`. It resolves the platform-specific binary name,
            // works from any working directory, and gives us a handle we can
            // actually kill.
            match app.shell().sidecar(SIDECAR_NAME) {
                Ok(command) => match command.spawn() {
                    Ok((mut rx, child)) => {
                        println!("RotoFox backend started (pid {}).", child.pid());
                        app.state::<BackendProcess>()
                            .0
                            .lock()
                            .expect("backend process mutex poisoned")
                            .replace(child);

                        // Forward backend output to this process's console.
                        // Previously every backend `print` vanished in release
                        // builds, leaving nothing to diagnose user reports with.
                        tauri::async_runtime::spawn(async move {
                            while let Some(event) = rx.recv().await {
                                match event {
                                    CommandEvent::Stdout(line) => {
                                        print!("[backend] {}", String::from_utf8_lossy(&line));
                                    }
                                    CommandEvent::Stderr(line) => {
                                        eprint!("[backend] {}", String::from_utf8_lossy(&line));
                                    }
                                    CommandEvent::Terminated(payload) => {
                                        eprintln!(
                                            "[backend] exited with code {:?}",
                                            payload.code
                                        );
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("Failed to start the RotoFox backend: {err}");
                    }
                },
                Err(err) => {
                    eprintln!("Backend sidecar '{SIDECAR_NAME}' was not found: {err}");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the RotoFox application")
        .run(|app_handle, event| {
            // Covers both the window close button and a quit from the menu or
            // the OS, so the backend never outlives the window.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                shutdown_backend(&app_handle.state::<BackendProcess>());
            }
        });
}
