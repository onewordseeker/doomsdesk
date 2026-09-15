// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod input;
mod signaling;

use config::Config;
use input::InputWorker;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tokio::sync::Mutex as AsyncMutex;

struct AppState {
    config_path: Mutex<PathBuf>,
    config: Mutex<Config>,
    signal_tx: Arc<AsyncMutex<Option<signaling::SignalTx>>>,
    random_password: Arc<AsyncMutex<String>>,
    is_connected: Arc<AsyncMutex<bool>>,
    input_worker: Mutex<Option<InputWorker>>,
    resource_dir: Mutex<PathBuf>,
    permanent_password: Mutex<String>,
    capture_running: Arc<AtomicBool>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(state: State<'_, AppState>, partial: Value) {
    let mut cfg = state.config.lock().unwrap();
    if let Some(pw) = partial.get("permanentPassword").and_then(|v| v.as_str()) {
        cfg.permanent_password = pw.to_string();
        *state.permanent_password.lock().unwrap() = pw.to_string();
    }
    if let Some(url) = partial.get("serverUrl").and_then(|v| v.as_str()) {
        cfg.server_url = url.to_string();
    }
    if let Some(v) = partial.get("startMinimized").and_then(|v| v.as_bool()) {
        cfg.start_minimized = v;
    }
    config::save(&state.config_path.lock().unwrap(), &cfg);
}

#[tauri::command]
fn get_device_id(state: State<'_, AppState>) -> String {
    state.config.lock().unwrap().device_id.clone()
}

#[tauri::command]
async fn get_random_password(state: State<'_, AppState>) -> Result<String, ()> {
    Ok(state.random_password.lock().await.clone())
}

#[tauri::command]
async fn is_server_connected(state: State<'_, AppState>) -> Result<bool, ()> {
    Ok(*state.is_connected.lock().await)
}

#[tauri::command]
async fn send_signaling(state: State<'_, AppState>, msg: Value) -> Result<(), String> {
    let lock = state.signal_tx.lock().await;
    if let Some(tx) = lock.as_ref() {
        tx.send(msg).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn connect_to_peer(
    state: State<'_, AppState>,
    target_id: String,
    password: String,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "connect",
        "targetId": target_id,
        "password": password
    });
    let lock = state.signal_tx.lock().await;
    if let Some(tx) = lock.as_ref() {
        tx.send(msg).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn respond_to_connection(
    state: State<'_, AppState>,
    source_id: String,
    approved: bool,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "approve",
        "targetId": source_id,
        "approved": approved
    });
    let lock = state.signal_tx.lock().await;
    if let Some(tx) = lock.as_ref() {
        tx.send(msg).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn inject_input(state: State<'_, AppState>, event: Value) -> Result<(), String> {
    let lock = state.input_worker.lock().unwrap();
    if let Some(worker) = lock.as_ref() {
        worker.send(&event).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_input_worker(state: State<'_, AppState>) {
    let mut lock = state.input_worker.lock().unwrap();
    if lock.is_none() {
        let resource_dir = state.resource_dir.lock().unwrap().clone();
        *lock = InputWorker::start(&resource_dir);
    }
}

#[tauri::command]
fn stop_input_worker(state: State<'_, AppState>) {
    let mut lock = state.input_worker.lock().unwrap();
    if let Some(w) = lock.take() {
        w.stop();
    }
}

#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) {
    let is_fs = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!is_fs);
}

#[tauri::command]
fn session_ready() {
    // No-op in Tauri — sessions start via URL params or events
}

#[tauri::command]
async fn report_agent_error(app: AppHandle, msg: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    eprintln!("[agent-error] {}", msg);
    app.dialog()
        .message(&msg)
        .title("Screen sharing failed")
        .blocking_show();
    Ok(())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(&url, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_session(app: AppHandle) {
    signaling::close_agent_window(&app);
    let _ = app.emit("session-ended", ());
}

#[tauri::command]
fn forward_agent_log(app: AppHandle, msg: String) {
    let _ = app.emit("agent-log", msg);
}

#[tauri::command]
async fn start_native_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use screenshots::Screen;
    use screenshots::image::{DynamicImage, imageops::FilterType};
    use screenshots::image::codecs::jpeg::JpegEncoder;
    use base64::Engine;

    let running = state.capture_running.clone();
    if running.swap(true, Ordering::SeqCst) {
        return Ok(()); // Already running
    }

    tauri::async_runtime::spawn_blocking(move || {
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            let ok = (|| -> Option<()> {
                let screens = Screen::all().ok()?;
                let screen = screens.first()?;
                let captured = screen.capture().ok()?; // RgbaImage

                let w = captured.width();
                let h = captured.height();

                let dyn_img = DynamicImage::ImageRgba8(captured);

                // Cap at 1280px wide for reasonable bandwidth
                let dyn_img = if w > 1280 {
                    dyn_img.resize(
                        1280,
                        (h as f64 * 1280.0 / w as f64) as u32,
                        FilterType::Nearest,
                    )
                } else {
                    dyn_img
                };

                let rgb = dyn_img.to_rgb8();
                let mut jpeg_buf = Vec::new();
                let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, 50);
                enc.encode_image(&rgb).ok()?;

                let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);
                let _ = app.emit("screen-frame", b64);
                Some(())
            })();

            if ok.is_none() {
                let _ = app.emit("screen-frame-error", "capture_failed");
            }

            std::thread::sleep(std::time::Duration::from_millis(66)); // ~15 fps
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_native_capture(state: State<'_, AppState>) {
    state.capture_running.store(false, Ordering::SeqCst);
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_path = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("config.json");

            let cfg = config::load(&config_path);
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            let signal_tx: Arc<AsyncMutex<Option<signaling::SignalTx>>> =
                Arc::new(AsyncMutex::new(None));
            let random_password: Arc<AsyncMutex<String>> =
                Arc::new(AsyncMutex::new(String::new()));
            let is_connected: Arc<AsyncMutex<bool>> = Arc::new(AsyncMutex::new(false));

            let perm_pw = cfg.permanent_password.clone();
            let server_url = cfg.server_url.clone();
            let device_id = cfg.device_id.clone();

            app.manage(AppState {
                config_path: Mutex::new(config_path),
                config: Mutex::new(cfg),
                signal_tx: signal_tx.clone(),
                random_password: random_password.clone(),
                is_connected: is_connected.clone(),
                input_worker: Mutex::new(None),
                resource_dir: Mutex::new(resource_dir),
                permanent_password: Mutex::new(perm_pw.clone()),
                capture_running: Arc::new(AtomicBool::new(false)),
            });

            // Start signaling loop
            signaling::start(
                app.handle().clone(),
                server_url,
                device_id,
                perm_pw,
                signal_tx,
                random_password,
                is_connected,
            );

            // Show main window (created with visible: false)
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }

            // Set up system tray
            setup_tray(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_device_id,
            get_random_password,
            is_server_connected,
            send_signaling,
            connect_to_peer,
            respond_to_connection,
            inject_input,
            start_input_worker,
            stop_input_worker,
            toggle_fullscreen,
            session_ready,
            report_agent_error,
            open_external,
            close_session,
            forward_agent_log,
            start_native_capture,
            stop_native_capture,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Minimize to tray instead of closing
                    window.hide().ok();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .expect("bundled icon.png is valid");
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open DoomsDesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("DoomsDesk")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    win.show().ok();
                    win.set_focus().ok();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                if let Some(win) = tray.app_handle().get_webview_window("main") {
                    win.show().ok();
                    win.set_focus().ok();
                }
            }
        })
        .build(app)?;
    Ok(())
}
