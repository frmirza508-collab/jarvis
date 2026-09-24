//! JARVIS desktop shell.
//!
//! Responsibilities:
//! * keep the 32-byte secrets master key in the OS credential vault
//!   (Windows Credential Manager) - it never touches disk in plaintext;
//! * launch the local JARVIS core (`jarvis-core` sidecar) with a fresh
//!   per-launch session token, handing both over the child's private stdin;
//! * expose only one command to the UI: the core's loopback URL + token;
//! * terminate the core when the window closes.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, State};

#[derive(Clone, Serialize)]
struct CoreConnection {
    url: String,
    token: String,
}

#[derive(Default)]
struct CoreState {
    conn: Mutex<Option<CoreConnection>>,
    error: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    // Held open for the life of the app: the core exits when its stdin closes.
    stdin: Mutex<Option<ChildStdin>>,
    shutting_down: std::sync::atomic::AtomicBool,
    restarts: std::sync::atomic::AtomicU32,
}

const MAX_RESTARTS: u32 = 5;

#[tauri::command]
fn core_connection(state: State<'_, Arc<CoreState>>) -> Result<Option<CoreConnection>, String> {
    if let Some(e) = state.error.lock().unwrap().clone() {
        return Err(e);
    }
    Ok(state.conn.lock().unwrap().clone())
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b)
}

fn master_key() -> Result<String, String> {
    let entry = keyring::Entry::new("JARVIS", "secrets-master-key").map_err(|e| format!("credential vault: {e}"))?;
    match entry.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => {
            let key = B64.encode(random_bytes::<32>()?);
            entry.set_password(&key).map_err(|e| format!("credential vault: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("credential vault: {e}")),
    }
}

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("JARVIS_DATA_DIR") {
        return PathBuf::from(d);
    }
    #[cfg(windows)]
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(not(windows))]
    let base = std::env::var("HOME").map(|h| PathBuf::from(h).join(".local").join("share")).unwrap_or_else(|_| PathBuf::from("."));
    base.join("JARVIS")
}

/// Resolve the core executable: next to the app binary (installed layout), or
/// JARVIS_CORE_CMD for development (e.g. `node services/orchestrator/dist/main.js`).
fn core_command() -> Result<Command, String> {
    if let Ok(cmd) = std::env::var("JARVIS_CORE_CMD") {
        let mut parts = cmd.split_whitespace();
        let program = parts.next().ok_or("empty JARVIS_CORE_CMD")?;
        let mut c = Command::new(program);
        c.args(parts);
        return Ok(c);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no exe dir")?;
    let name = if cfg!(windows) { "jarvis-core.exe" } else { "jarvis-core" };
    let path = dir.join(name);
    if !path.exists() {
        return Err(format!("JARVIS core not found at {}", path.display()));
    }
    Ok(Command::new(path))
}

fn start_core(state: Arc<CoreState>) -> Result<(), String> {
    let data = data_dir();
    let logs = data.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log_path = logs.join("core.log");
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;

    let token = random_bytes::<32>()?.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let key = master_key()?;

    let mut cmd = core_command()?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?));
    cmd.env("JARVIS_DATA_DIR", &data);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start JARVIS core: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let bootstrap = serde_json::json!({ "token": token, "masterKey": key, "dataDir": data });
    writeln!(stdin, "{bootstrap}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);

    let st = state.clone();
    std::thread::spawn(move || {
        let mut log = log;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("JARVIS_READY ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    if let Some(port) = v.get("port").and_then(|p| p.as_u64()) {
                        *st.conn.lock().unwrap() = Some(CoreConnection { url: format!("http://127.0.0.1:{port}"), token: token.clone() });
                    }
                }
            } else if let Some(msg) = line.strip_prefix("JARVIS_FATAL ") {
                *st.error.lock().unwrap() = Some(msg.to_string());
            }
            let _ = writeln!(log, "{line}");
        }
        // The core's stdout closed: it exited. Recover unless the app is quitting.
        let was_ready = st.conn.lock().unwrap().take().is_some();
        if let Some(mut c) = st.child.lock().unwrap().take() {
            let _ = c.wait();
        }
        st.stdin.lock().unwrap().take();
        if st.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let n = st.restarts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let _ = writeln!(log, "[shell] core exited unexpectedly (restart {n}/{MAX_RESTARTS})");
        if !was_ready || n > MAX_RESTARTS {
            let mut err = st.error.lock().unwrap();
            if err.is_none() {
                *err = Some(format!("JARVIS core stopped and could not be restarted. See {}", log_path.display()));
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500 * u64::from(n)));
        if let Err(e) = start_core(st.clone()) {
            *st.error.lock().unwrap() = Some(e);
        }
    });
    Ok(())
}

fn stop_core(state: &CoreState) {
    state.shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
    state.stdin.lock().unwrap().take();
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(CoreState::default());
    let app = tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![core_connection])
        .setup(move |_app| {
            if let Err(e) = start_core(state.clone()) {
                *state.error.lock().unwrap() = Some(e);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building JARVIS");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let st = handle.state::<Arc<CoreState>>();
            stop_core(&st);
        }
    });
}
