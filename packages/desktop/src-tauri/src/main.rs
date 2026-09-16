// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod config;
mod encode;
mod input;
mod signaling;

use config::Config;
use input::InputWorker;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
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
    permanent_password: Mutex<String>,
    capture_generation: Arc<AtomicU64>,
    capture_quality: Arc<AtomicU8>,
    capture_bitrate: Arc<AtomicU32>,
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
        *lock = InputWorker::start(&std::path::PathBuf::new());
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
    use screenshots::image::{DynamicImage, imageops::FilterType, RgbaImage};
    use base64::Engine;

    let gen_ref     = state.capture_generation.clone();
    let bitrate_ref = state.capture_bitrate.clone();

    // Increment generation — any running loop with the old gen exits on next iteration.
    let my_gen = gen_ref.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn_blocking(move || {
        let mut encoder: Option<encode::H264Encoder> = None;
        let mut pts_ms: u64 = 0;
        let mut last_frame_hash: u64 = 0;
        let mut last_send_ms: u64 = 0;
        let mut last_bitrate: u32 = 0;
        const FRAME_MS: u64 = 33;          // ~30 fps
        const IDLE_FORCE_MS: u64 = 2_000;  // keepalive: force send every 2s even if static

        loop {
            if gen_ref.load(Ordering::SeqCst) != my_gen { break; }

            let frame_start = std::time::Instant::now();

            let ok = (|| -> Option<()> {
                // capture::capture_screen() uses CGDisplayCreateImage on macOS (CoreGraphics,
                // not deprecated) and the screenshots crate on Windows.
                let frame = capture::capture_screen()?;
                let (w, h) = (frame.width, frame.height);

                // Build DynamicImage for resize — reuse the Vec<u8> allocation
                let rgba_img = RgbaImage::from_raw(w, h, frame.data)?;
                let dyn_img = DynamicImage::ImageRgba8(rgba_img);

                // Cap at 1920 px wide — full HD ceiling, limits bandwidth
                let (eff_w, eff_h, rgba) = if w > 1920 {
                    let eff_h = (h as f64 * 1920.0 / w as f64) as u32;
                    let resized = dyn_img.resize(1920, eff_h, FilterType::Triangle);
                    let iw = resized.width();
                    let ih = resized.height();
                    (iw, ih, resized.into_rgba8().into_raw())
                } else {
                    (w, h, dyn_img.into_rgba8().into_raw())
                };

                // (Re)create encoder on dimension change
                if encoder.as_ref().map(|e| e.dimensions()) != Some((eff_w, eff_h)) {
                    encoder = encode::H264Encoder::new(eff_w, eff_h);
                    pts_ms = 0;
                    last_frame_hash = 0;
                    last_send_ms = 0;
                }
                let enc = encoder.as_mut()?;

                // Live bitrate adaptation — VT accepts updates without session restart
                let wanted_bps = bitrate_ref.load(Ordering::Relaxed);
                if wanted_bps != last_bitrate && wanted_bps > 0 {
                    enc.set_bitrate(wanted_bps);
                    last_bitrate = wanted_bps;
                }

                // Cheap perceptual hash — sample every 512th byte, LCG-mix with index
                let hash: u64 = rgba
                    .chunks_exact(512)
                    .enumerate()
                    .fold(0u64, |acc, (i, chunk)| {
                        acc ^ ((chunk[0] as u64)
                            .wrapping_mul(6364136223846793005)
                            .wrapping_add(i as u64))
                    });

                let idle_too_long = pts_ms.saturating_sub(last_send_ms) >= IDLE_FORCE_MS;
                if hash == last_frame_hash && !idle_too_long {
                    return Some(()); // static screen, keepalive not due
                }
                last_frame_hash = hash;

                let encoded = enc.encode(&rgba, pts_ms)?;
                last_send_ms = pts_ms;

                let b64 = base64::engine::general_purpose::STANDARD.encode(&encoded.data);
                let _ = app.emit("screen-frame", b64);
                Some(())
            })();

            if ok.is_none() {
                let _ = app.emit("screen-frame-error", "capture_failed");
            }

            pts_ms = pts_ms.wrapping_add(FRAME_MS);

            let elapsed = frame_start.elapsed();
            let budget = std::time::Duration::from_millis(FRAME_MS);
            if elapsed < budget {
                std::thread::sleep(budget - elapsed);
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_native_capture(state: State<'_, AppState>) {
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn set_capture_quality(state: State<'_, AppState>, quality: u8) {
    let clamped = quality.clamp(20, 95);
    state.capture_quality.store(clamped, Ordering::Relaxed);
}

#[tauri::command]
fn set_capture_bitrate(state: State<'_, AppState>, bps: u32) {
    let clamped = bps.clamp(500_000, 8_000_000);
    state.capture_bitrate.store(clamped, Ordering::Relaxed);
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
                permanent_password: Mutex::new(perm_pw.clone()),
                capture_generation: Arc::new(AtomicU64::new(0)),
                capture_quality: Arc::new(AtomicU8::new(60)),
                capture_bitrate: Arc::new(AtomicU32::new(0)),
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
            set_capture_quality,
            set_capture_bitrate,
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
