use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_PORT: u16 = 8000;
const PORT_ATTEMPTS: u16 = 20;
const READY_MARKER: &str = ".rotofox_runtime_v1";
const UV_ZIP_URL: &str =
    "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip";

struct BackendProcess(Mutex<Option<Child>>);

#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub host: String,
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Serialize)]
pub struct RuntimeStatus {
    pub installed: bool,
    pub running: bool,
    pub install_dir: String,
    pub gpu_available: bool,
    pub gpu_name: String,
    pub total_vram_gb: Option<f64>,
}

#[derive(Clone, Serialize)]
struct InstallProgressPayload {
    pub progress: u8,
    pub stage: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Default)]
struct BootstrapConfig {
    install_dir: Option<String>,
}

enum RuntimeLaunch {
    InstalledVenv {
        python_exe: PathBuf,
        backend_dir: PathBuf,
        data_dir: PathBuf,
    },
    PortableSidecar {
        exe_path: PathBuf,
        data_dir: PathBuf,
    },
    DevVenv {
        python_exe: PathBuf,
        backend_dir: PathBuf,
        data_dir: PathBuf,
    },
}

/// Pick a free loopback TCP port starting at `DEFAULT_PORT`.
fn find_free_port() -> u16 {
    for offset in 0..PORT_ATTEMPTS {
        let candidate = DEFAULT_PORT + offset;
        let addr = SocketAddr::from(([127, 0, 0, 1], candidate));
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

/// Default per-user application data directory (`%LOCALAPPDATA%\RotoFox` on Windows).
fn default_app_data_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data).join("RotoFox");
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(home)
            .join("AppData")
            .join("Local")
            .join("RotoFox");
    }
    PathBuf::from("RotoFoxData")
}

fn bootstrap_config_path() -> PathBuf {
    let base = default_app_data_dir();
    let _ = fs::create_dir_all(&base);
    base.join("bootstrap.json")
}

fn load_configured_install_dir() -> PathBuf {
    let cfg_path = bootstrap_config_path();
    if let Ok(raw) = fs::read_to_string(&cfg_path) {
        if let Ok(parsed) = serde_json::from_str::<BootstrapConfig>(&raw) {
            if let Some(dir) = parsed.install_dir {
                let trimmed = dir.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed);
                }
            }
        }
    }
    default_app_data_dir()
}

fn save_configured_install_dir(install_dir: &Path) -> Result<(), String> {
    let cfg_path = bootstrap_config_path();
    let cfg = BootstrapConfig {
        install_dir: Some(install_dir.to_string_lossy().to_string()),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&cfg_path, json).map_err(|e| format!("Could not save {}: {e}", cfg_path.display()))?;

    // Also write rotofox_config.json inside install_dir so the Python backend
    // stores checkpoints in <install_dir>/checkpoints by default.
    let checkpoints_dir = install_dir.join("checkpoints");
    let _ = fs::create_dir_all(&checkpoints_dir);
    let backend_cfg_path = install_dir.join("rotofox_config.json");
    if !backend_cfg_path.exists() {
        let backend_cfg = serde_json::json!({
            "checkpoints_dir": checkpoints_dir.to_string_lossy().to_string()
        });
        if let Ok(text) = serde_json::to_string_pretty(&backend_cfg) {
            let _ = fs::write(&backend_cfg_path, text);
        }
    }

    Ok(())
}

/// Query NVIDIA GPU availability via `nvidia-smi` without needing Python/PyTorch yet.
fn detect_hardware() -> (bool, String, Option<f64>) {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = text.lines().next() {
                let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
                if !parts.is_empty() && !parts[0].is_empty() {
                    let name = parts[0].to_string();
                    let vram_gb = parts
                        .get(1)
                        .and_then(|v| v.parse::<f64>().ok())
                        .map(|mb| ((mb / 1024.0) * 10.0).round() / 10.0);
                    return (true, name, vram_gb);
                }
            }
        }
    }

    (false, "CPU".to_string(), None)
}

/// Locate the bundled pure-Python backend source tree (`resources/backend`).
fn locate_bundled_backend_source(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("resources").join("backend"));
        candidates.push(res_dir.join("backend"));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("resources").join("backend"));
            candidates.push(exe_dir.join("backend"));
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest_dir.join("resources").join("backend"));
    candidates.push(manifest_dir.join("..").join("..").join("backend"));

    candidates
        .into_iter()
        .find(|dir| dir.join("main.py").is_file() && dir.join("app").is_dir())
}

fn is_venv_installed(install_dir: &Path) -> bool {
    let venv_py = if cfg!(target_os = "windows") {
        install_dir
            .join("runtime")
            .join("venv")
            .join("Scripts")
            .join("python.exe")
    } else {
        install_dir
            .join("runtime")
            .join("venv")
            .join("bin")
            .join("python")
    };
    let marker = install_dir.join("runtime").join("venv").join(READY_MARKER);
    let backend_main = install_dir.join("runtime").join("backend").join("main.py");
    venv_py.is_file() && marker.is_file() && backend_main.is_file()
}

/// Resolve how the backend should be launched if a runtime is already available.
fn resolve_runtime_launch(app: &AppHandle, install_dir: &Path) -> Option<RuntimeLaunch> {
    // 1. User-installed runtime inside `<install_dir>/runtime`
    if is_venv_installed(install_dir) {
        let python_exe = if cfg!(target_os = "windows") {
            install_dir
                .join("runtime")
                .join("venv")
                .join("Scripts")
                .join("python.exe")
        } else {
            install_dir
                .join("runtime")
                .join("venv")
                .join("bin")
                .join("python")
        };
        let backend_dir = install_dir.join("runtime").join("backend");
        return Some(RuntimeLaunch::InstalledVenv {
            python_exe,
            backend_dir,
            data_dir: install_dir.to_path_buf(),
        });
    }

    // 2. Portable build with `_internal` next to the executable
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            if exe_dir.join("_internal").is_dir() {
                for name in [
                    "rotofox-backend.exe",
                    "rotofox-backend-x86_64-pc-windows-msvc.exe",
                ] {
                    let candidate = exe_dir.join(name);
                    if candidate.is_file() {
                        return Some(RuntimeLaunch::PortableSidecar {
                            exe_path: candidate,
                            data_dir: install_dir.to_path_buf(),
                        });
                    }
                }
            }
        }
    }

    // 3. Developer mode (`cargo run` / `tauri dev`)
    if cfg!(debug_assertions) || std::env::var("ROTOFOX_DEV").as_deref() == Ok("1") {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dev_backend = manifest_dir.join("..").join("..").join("backend");
        let dev_py = if cfg!(target_os = "windows") {
            dev_backend.join(".venv").join("Scripts").join("python.exe")
        } else {
            dev_backend.join(".venv").join("bin").join("python")
        };
        if dev_py.is_file() && dev_backend.join("main.py").is_file() {
            return Some(RuntimeLaunch::DevVenv {
                python_exe: dev_py,
                backend_dir: dev_backend.clone(),
                data_dir: dev_backend,
            });
        }
    }

    let _ = app;
    None
}

fn kill_child(mut child: Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_backend_process(launch: RuntimeLaunch, info: &BackendInfo) -> std::io::Result<Child> {
    let mut cmd = match &launch {
        RuntimeLaunch::InstalledVenv {
            python_exe,
            backend_dir,
            data_dir,
        }
        | RuntimeLaunch::DevVenv {
            python_exe,
            backend_dir,
            data_dir,
        } => {
            let mut c = Command::new(python_exe);
            let main_py = backend_dir.join("main.py");
            c.arg(&main_py)
                .args(["--port", &info.port.to_string(), "--token", &info.token])
                .current_dir(backend_dir)
                .env("PYTHONPATH", backend_dir)
                .env("PYTHONUTF8", "1")
                .env("ROTOFOX_DATA_DIR", data_dir);
            c
        }
        RuntimeLaunch::PortableSidecar { exe_path, data_dir } => {
            let mut c = Command::new(exe_path);
            c.args(["--port", &info.port.to_string(), "--token", &info.token])
                .env("ROTOFOX_DATA_DIR", data_dir);
            if let Some(parent) = exe_path.parent() {
                c.current_dir(parent);
            }
            c
        }
    };

    cmd.env("ROTOFOX_PORT", info.port.to_string())
        .env("ROTOFOX_TOKEN", &info.token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

    Ok(child)
}

fn ensure_backend_running(app: &AppHandle, install_dir: &Path) -> bool {
    let proc_state = app.state::<BackendProcess>();
    {
        let mut guard = match proc_state.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            *guard = None;
        }
    }

    let Some(launch) = resolve_runtime_launch(app, install_dir) else {
        return false;
    };

    let info = app.state::<BackendInfo>().inner().clone();
    match spawn_backend_process(launch, &info) {
        Ok(child) => {
            println!(
                "RotoFox backend started (pid {}, port {}).",
                child.id(),
                info.port
            );
            let mut guard = match proc_state.0.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            *guard = Some(child);
            true
        }
        Err(err) => {
            eprintln!("Failed to spawn RotoFox backend: {err}");
            false
        }
    }
}

fn shutdown_backend(state: &BackendProcess) {
    let child = match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };

    if let Some(child) = child {
        kill_child(child);
        println!("RotoFox backend stopped.");
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "__pycache__" || name_str == ".git" || name_str.ends_with(".pyc") {
            continue;
        }
        let dest_path = dst.join(&name);
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

fn emit_install_progress(app: &AppHandle, progress: u8, stage: &str, detail: &str) {
    let _ = app.emit(
        "runtime-install-progress",
        InstallProgressPayload {
            progress,
            stage: stage.to_string(),
            detail: detail.to_string(),
        },
    );
}

fn run_command_with_progress(
    mut cmd: Command,
    app: &AppHandle,
    start_pct: u8,
    end_pct: u8,
    stage: &str,
) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {stage}: {e}"))?;

    let stderr = child.stderr.take();
    let app_clone = app.clone();
    let stage_owned = stage.to_string();

    let reader_handle = std::thread::spawn(move || {
        let mut last_lines: Vec<String> = Vec::new();
        if let Some(err_stream) = stderr {
            let reader = BufReader::new(err_stream);
            let mut step_count: u32 = 0;
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                step_count = step_count.saturating_add(1);
                let span = (end_pct.saturating_sub(start_pct)) as u32;
                let bumped = start_pct
                    + ((step_count.min(40) * span) / 40).min(span.saturating_sub(1)) as u8;
                emit_install_progress(&app_clone, bumped, &stage_owned, &trimmed);
                if last_lines.len() >= 10 {
                    last_lines.remove(0);
                }
                last_lines.push(trimmed);
            }
        }
        last_lines
    });

    let status = child
        .wait()
        .map_err(|e| format!("Error waiting for {stage}: {e}"))?;
    let tail = reader_handle.join().unwrap_or_default();

    if !status.success() {
        let summary = if tail.is_empty() {
            format!("Process exited with status {status}")
        } else {
            tail.join(" | ")
        };
        return Err(format!("{stage} failed: {summary}"));
    }

    Ok(())
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendProcess>) {
    shutdown_backend(&state);
}

#[tauri::command]
fn get_backend_info(state: State<'_, BackendInfo>) -> BackendInfo {
    state.inner().clone()
}

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    let install_dir = load_configured_install_dir();
    let (gpu_available, gpu_name, total_vram_gb) = detect_hardware();
    let installed = resolve_runtime_launch(&app, &install_dir).is_some();
    let running = if installed {
        ensure_backend_running(&app, &install_dir)
    } else {
        false
    };

    RuntimeStatus {
        installed,
        running,
        install_dir: install_dir.to_string_lossy().to_string(),
        gpu_available,
        gpu_name,
        total_vram_gb,
    }
}

#[tauri::command]
async fn install_ai_runtime(app: AppHandle, install_dir: String) -> Result<RuntimeStatus, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_dir = if install_dir.trim().is_empty() {
            load_configured_install_dir()
        } else {
            PathBuf::from(install_dir.trim())
        };

        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Cannot create directory {}: {e}", target_dir.display()))?;

        // Check write permission before starting a multi-gigabyte download
        let probe = target_dir.join(".rotofox_write_test");
        fs::write(&probe, b"ok")
            .map_err(|e| format!("Folder {} is not writable: {e}", target_dir.display()))?;
        let _ = fs::remove_file(&probe);

        save_configured_install_dir(&target_dir)?;

        let (gpu_available, gpu_name, total_vram_gb) = detect_hardware();

        // Stop any running backend before modifying runtime
        shutdown_backend(&app_clone.state::<BackendProcess>());

        // If the selected folder already has a ready runtime, simply start it!
        if is_venv_installed(&target_dir) {
            emit_install_progress(
                &app_clone,
                95,
                "Starting AI Engine",
                "Existing AI runtime found in selected folder. Starting server...",
            );
            let running = ensure_backend_running(&app_clone, &target_dir);
            emit_install_progress(&app_clone, 100, "Complete", "AI Engine is ready.");
            return Ok(RuntimeStatus {
                installed: true,
                running,
                install_dir: target_dir.to_string_lossy().to_string(),
                gpu_available,
                gpu_name,
                total_vram_gb,
            });
        }

        let runtime_dir = target_dir.join("runtime");
        let uv_dir = runtime_dir.join("uv");
        let python_install_dir = runtime_dir.join("python");
        let venv_dir = runtime_dir.join("venv");
        let backend_dest = runtime_dir.join("backend");

        fs::create_dir_all(&uv_dir)
            .map_err(|e| format!("Failed to create runtime folder: {e}"))?;
        fs::create_dir_all(&python_install_dir)
            .map_err(|e| format!("Failed to create python folder: {e}"))?;

        // ── Stage 1: Download `uv` package manager (~14 MB) ──────────────────
        let uv_exe = uv_dir.join("uv.exe");
        if !uv_exe.is_file() {
            emit_install_progress(
                &app_clone,
                5,
                "Downloading Package Manager",
                "Fetching standalone uv installer...",
            );
            let zip_path = uv_dir.join("uv.zip");
            let mut curl_cmd = Command::new("curl.exe");
            curl_cmd.args([
                "-L",
                "--fail",
                "--retry",
                "3",
                "-o",
                &zip_path.to_string_lossy(),
                UV_ZIP_URL,
            ]);
            run_command_with_progress(
                curl_cmd,
                &app_clone,
                5,
                12,
                "Downloading Package Manager",
            )?;

            emit_install_progress(
                &app_clone,
                13,
                "Extracting Package Manager",
                "Unpacking uv.exe...",
            );
            let mut tar_cmd = Command::new("tar.exe");
            tar_cmd.args([
                "-xf",
                &zip_path.to_string_lossy(),
                "-C",
                &uv_dir.to_string_lossy(),
            ]);
            run_command_with_progress(
                tar_cmd,
                &app_clone,
                13,
                15,
                "Extracting Package Manager",
            )?;
            let _ = fs::remove_file(&zip_path);
        }

        // ── Stage 2: Create isolated Python 3.12 virtual environment ─────────
        emit_install_progress(
            &app_clone,
            16,
            "Installing Python 3.12 Runtime",
            "Creating isolated Python 3.12 environment in selected folder...",
        );
        let mut venv_cmd = Command::new(&uv_exe);
        venv_cmd
            .args([
                "venv",
                &venv_dir.to_string_lossy(),
                "--python",
                "3.12",
                "--clear",
            ])
            .env("UV_PYTHON_INSTALL_DIR", &python_install_dir)
            .env("UV_NO_CACHE", "1");
        run_command_with_progress(
            venv_cmd,
            &app_clone,
            16,
            30,
            "Installing Python 3.12 Runtime",
        )?;

        let venv_python = venv_dir.join("Scripts").join("python.exe");
        if !venv_python.is_file() {
            return Err(format!(
                "Python executable was not created at {}",
                venv_python.display()
            ));
        }

        // ── Stage 3: Install PyTorch (CUDA if NVIDIA GPU detected, else CPU) ─
        if gpu_available {
            emit_install_progress(
                &app_clone,
                32,
                "Installing PyTorch CUDA Engine",
                &format!("Downloading GPU-accelerated PyTorch for {gpu_name}..."),
            );
            let mut torch_cmd = Command::new(&uv_exe);
            torch_cmd
                .args([
                    "pip",
                    "install",
                    "--python",
                    &venv_python.to_string_lossy(),
                    "--no-cache",
                    "torch>=2.5.1",
                    "torchvision>=0.20.1",
                    "--index-url",
                    "https://download.pytorch.org/whl/cu124",
                ])
                .env("UV_PYTHON_INSTALL_DIR", &python_install_dir);

            if run_command_with_progress(
                torch_cmd,
                &app_clone,
                32,
                76,
                "Installing PyTorch CUDA Engine",
            )
            .is_err()
            {
                emit_install_progress(
                    &app_clone,
                    35,
                    "Installing PyTorch (CPU Fallback)",
                    "CUDA wheel download failed; falling back to CPU PyTorch...",
                );
                let mut cpu_cmd = Command::new(&uv_exe);
                cpu_cmd
                    .args([
                        "pip",
                        "install",
                        "--python",
                        &venv_python.to_string_lossy(),
                        "--no-cache",
                        "torch>=2.5.1",
                        "torchvision>=0.20.1",
                        "--index-url",
                        "https://download.pytorch.org/whl/cpu",
                    ])
                    .env("UV_PYTHON_INSTALL_DIR", &python_install_dir);
                run_command_with_progress(
                    cpu_cmd,
                    &app_clone,
                    35,
                    76,
                    "Installing PyTorch Engine",
                )?;
            }
        } else {
            emit_install_progress(
                &app_clone,
                32,
                "Installing PyTorch CPU Engine",
                "Downloading PyTorch runtime for CPU...",
            );
            let mut cpu_cmd = Command::new(&uv_exe);
            cpu_cmd
                .args([
                    "pip",
                    "install",
                    "--python",
                    &venv_python.to_string_lossy(),
                    "--no-cache",
                    "torch>=2.5.1",
                    "torchvision>=0.20.1",
                    "--index-url",
                    "https://download.pytorch.org/whl/cpu",
                ])
                .env("UV_PYTHON_INSTALL_DIR", &python_install_dir);
            run_command_with_progress(
                cpu_cmd,
                &app_clone,
                32,
                76,
                "Installing PyTorch CPU Engine",
            )?;
        }

        // ── Stage 4: Install FastAPI, OpenCV, Hydra, FFmpeg & AI dependencies
        emit_install_progress(
            &app_clone,
            78,
            "Installing AI & Video Libraries",
            "Installing FastAPI, OpenCV, Hydra, FFmpeg and SAM 2 dependencies...",
        );
        let mut deps_cmd = Command::new(&uv_exe);
        deps_cmd
            .args([
                "pip",
                "install",
                "--python",
                &venv_python.to_string_lossy(),
                "--no-cache",
                "fastapi>=0.115.6",
                "uvicorn[standard]>=0.34.0",
                "websockets>=13.1",
                "python-multipart>=0.0.20",
                "opencv-python>=4.10.0.84",
                "numpy>=1.26.4",
                "pillow>=11.1.0",
                "hydra-core>=1.3.2",
                "omegaconf>=2.3.0",
                "iopath>=0.1.10",
                "psutil>=6.1.1",
                "imageio-ffmpeg>=0.5.1",
                "tqdm>=4.67.1",
                "einops",
                "scipy",
                "timm",
                "pyyaml",
            ])
            .env("UV_PYTHON_INSTALL_DIR", &python_install_dir);
        run_command_with_progress(
            deps_cmd,
            &app_clone,
            78,
            94,
            "Installing AI & Video Libraries",
        )?;

        // ── Stage 5: Copy bundled backend source & start backend server ──────
        emit_install_progress(
            &app_clone,
            95,
            "Deploying RotoFox Backend",
            "Copying SAM 2.1 and MatAnyone 2 modules...",
        );
        let src_backend = locate_bundled_backend_source(&app_clone)
            .ok_or_else(|| "Bundled backend resources not found in installation.".to_string())?;

        if backend_dest.exists() {
            let _ = fs::remove_dir_all(&backend_dest);
        }
        copy_dir_recursive(&src_backend, &backend_dest)
            .map_err(|e| format!("Failed to copy backend sources: {e}"))?;

        // If developer workspace has sam2_src / third_party not yet flattened, copy them too
        let sam2_nested = src_backend.join("sam2_src").join("sam2");
        if sam2_nested.is_dir() && !backend_dest.join("sam2").is_dir() {
            copy_dir_recursive(&sam2_nested, &backend_dest.join("sam2"))
                .map_err(|e| format!("Failed to copy sam2 package: {e}"))?;
        }
        let mat_nested = src_backend
            .join("third_party")
            .join("MatAnyone2")
            .join("matanyone2");
        if mat_nested.is_dir() && !backend_dest.join("matanyone2").is_dir() {
            copy_dir_recursive(&mat_nested, &backend_dest.join("matanyone2"))
                .map_err(|e| format!("Failed to copy matanyone2 package: {e}"))?;
        }

        let marker = venv_dir.join(READY_MARKER);
        fs::write(&marker, b"ready").map_err(|e| format!("Could not write ready marker: {e}"))?;

        emit_install_progress(
            &app_clone,
            98,
            "Starting AI Server",
            "Launching local RotoFox AI backend...",
        );
        let running = ensure_backend_running(&app_clone, &target_dir);
        emit_install_progress(&app_clone, 100, "Complete", "AI Engine installed and running!");

        Ok(RuntimeStatus {
            installed: true,
            running,
            install_dir: target_dir.to_string_lossy().to_string(),
            gpu_available,
            gpu_name,
            total_vram_gb,
        })
    })
    .await
    .map_err(|e| format!("Runtime installer task panicked: {e}"))?
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .manage(backend_info)
        .append_invoke_initialization_script(init_script)
        .invoke_handler(tauri::generate_handler![
            stop_backend,
            get_backend_info,
            get_runtime_status,
            install_ai_runtime
        ])
        .setup(move |app| {
            let install_dir = load_configured_install_dir();
            let handle = app.handle().clone();
            if ensure_backend_running(&handle, &install_dir) {
                println!(
                    "RotoFox backend launched from {}",
                    install_dir.display()
                );
            } else {
                println!(
                    "AI runtime not yet installed at {}; awaiting Setup Wizard.",
                    install_dir.display()
                );
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
