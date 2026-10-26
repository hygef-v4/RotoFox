use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SIDECAR_NAME: &str = "rotofox-backend";
const DEFAULT_PORT: u16 = 8000;
const PORT_ATTEMPTS: u16 = 20;

enum RunningChild {
    Std(Child),
    Sidecar(CommandChild),
}

impl RunningChild {
    fn pid(&self) -> u32 {
        match self {
            Self::Std(child) => child.id(),
            Self::Sidecar(child) => child.pid(),
        }
    }

    fn kill(self) {
        let pid = self.pid();
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        match self {
            Self::Std(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Self::Sidecar(child) => {
                let _ = child.kill();
            }
        }
    }
}

struct BackendProcess(Mutex<Option<RunningChild>>);

#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub host: String,
    pub port: u16,
    pub token: String,
}

/// Pick a free loopback TCP port starting at `DEFAULT_PORT`.
fn find_free_port() -> u16 {
    for offset in 0..PORT_ATTEMPTS {
        let candidate = DEFAULT_PORT + offset;
        let addr = SocketAddr::from(([127, 0, 0, 1], candidate));
        // If something is already accepting connections on this port, skip it.
        if TcpStream::connect_timeout(&addr, Duration::from_millis(40)).is_ok() {
            continue;
        }
        if TcpListener::bind(addr).is_ok() {
            return candidate;
        }
    }
    DEFAULT_PORT
}

/// Generate a per-session secret token using OS-seeded RandomState instances.
fn generate_session_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();

    let mut out = String::with_capacity(64);
    for i in 0..4u64 {
        let state = RandomState::new();
        let mut hasher = state.build_hasher();
        hasher.write_u128(nanos);
        hasher.write_u32(pid);
        hasher.write_u64(i);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

/// Locate a backend executable whose sibling `_internal` runtime folder exists.
fn locate_backend_with_runtime() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "rotofox-backend.exe"
    } else {
        "rotofox-backend"
    };
    let triple_exe = if cfg!(target_os = "windows") {
        "rotofox-backend-x86_64-pc-windows-msvc.exe"
    } else {
        "rotofox-backend-x86_64-unknown-linux-gnu"
    };

    let mut candidate_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidate_dirs.push(exe_dir.to_path_buf());
            candidate_dirs.push(exe_dir.join("binaries").join("rotofox-backend"));
            candidate_dirs.push(exe_dir.join("..").join("..").join("binaries").join("rotofox-backend"));
            candidate_dirs.push(
                exe_dir
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("backend")
                    .join("dist")
                    .join("rotofox-backend"),
            );
        }
    }

    // Fallback to the build-tree sidecar directory if running on the build machine.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidate_dirs.push(manifest_dir.join("binaries").join("rotofox-backend"));
    candidate_dirs.push(
        manifest_dir
            .join("..")
            .join("backend")
            .join("dist")
            .join("rotofox-backend"),
    );

    for dir in candidate_dirs {
        if !dir.join("_internal").is_dir() {
            continue;
        }
        for name in [exe_name, triple_exe] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn spawn_std_backend(exe_path: &Path, info: &BackendInfo) -> std::io::Result<RunningChild> {
    let mut cmd = Command::new(exe_path);
    cmd.args(["--port", &info.port.to_string(), "--token", &info.token])
        .env("ROTOFOX_PORT", info.port.to_string())
        .env("ROTOFOX_TOKEN", &info.token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = exe_path.parent() {
        cmd.current_dir(parent);
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn()?;

    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                println!("[backend] {line}");
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
            }
        });
    }

    Ok(RunningChild::Std(child))
}

fn shutdown_backend(state: &BackendProcess) {
    let child = match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };

    if let Some(child) = child {
        child.kill();
        println!("RotoFox backend stopped.");
    }
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendProcess>) {
    shutdown_backend(&state);
}

#[tauri::command]
fn get_backend_info(state: State<'_, BackendInfo>) -> BackendInfo {
    state.inner().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend_info = BackendInfo {
        host: "127.0.0.1".to_string(),
        port: find_free_port(),
        token: generate_session_token(),
    };

    let init_script = format!(
        "window.__ROTOFOX__ = {{ host: {:?}, port: {}, token: {:?} }};",
        backend_info.host, backend_info.port, backend_info.token
    );

    let setup_info = backend_info.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .manage(backend_info)
        .append_invoke_initialization_script(init_script)
        .invoke_handler(tauri::generate_handler![stop_backend, get_backend_info])
        .setup(move |app| {
            // Prefer a sidecar binary that has its PyInstaller `_internal` directory
            // next to it; fall back to Tauri's sidecar resolver otherwise.
            if let Some(exe_path) = locate_backend_with_runtime() {
                match spawn_std_backend(&exe_path, &setup_info) {
                    Ok(running) => {
                        println!(
                            "RotoFox backend started from {:?} (pid {}, port {}).",
                            exe_path,
                            running.pid(),
                            setup_info.port
                        );
                        app.state::<BackendProcess>()
                            .0
                            .lock()
                            .expect("backend process mutex poisoned")
                            .replace(running);
                        return Ok(());
                    }
                    Err(err) => {
                        eprintln!("Failed to spawn {:?}: {err}", exe_path);
                    }
                }
            }

            match app.shell().sidecar(SIDECAR_NAME) {
                Ok(command) => {
                    let command = command
                        .args(["--port", &setup_info.port.to_string(), "--token", &setup_info.token])
                        .env("ROTOFOX_PORT", setup_info.port.to_string())
                        .env("ROTOFOX_TOKEN", &setup_info.token);

                    match command.spawn() {
                        Ok((mut rx, child)) => {
                            println!(
                                "RotoFox backend sidecar started (pid {}, port {}).",
                                child.pid(),
                                setup_info.port
                            );
                            app.state::<BackendProcess>()
                                .0
                                .lock()
                                .expect("backend process mutex poisoned")
                                .replace(RunningChild::Sidecar(child));

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
                    }
                }
                Err(err) => {
                    eprintln!("Backend sidecar '{SIDECAR_NAME}' was not found: {err}");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the RotoFox application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                shutdown_backend(&app_handle.state::<BackendProcess>());
            }
        });
}
