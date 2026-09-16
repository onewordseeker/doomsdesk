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
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Wry,
};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

// Tray icon handle — set once during setup, then used for tooltip updates
static TRAY: OnceLock<TrayIcon<Wry>> = OnceLock::new();

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
    capture_display: Arc<AtomicU32>,           // 0 = primary
    frame_tx: broadcast::Sender<Vec<u8>>,      // binary H.264 frames; empty vec = stop signal
    ws_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    if let Some(url) = partial.get("webUrl").and_then(|v| v.as_str()) {
        cfg.web_url = url.to_string();
    }
    if let Some(v) = partial.get("startMinimized").and_then(|v| v.as_bool()) {
        cfg.start_minimized = v;
    }
    if let Some(v) = partial.get("turnUrl").and_then(|v| v.as_str()) {
        cfg.turn_url = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = partial.get("turnUsername").and_then(|v| v.as_str()) {
        cfg.turn_username = if v.is_empty() { None } else { Some(v.to_string()) };
    }
    if let Some(v) = partial.get("turnCredential").and_then(|v| v.as_str()) {
        cfg.turn_credential = if v.is_empty() { None } else { Some(v.to_string()) };
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
fn session_ready() {}

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

/// Save a file received from the remote side.
/// Tries to auto-save to ~/Downloads/{name}; falls back to native save dialog if unavailable.
#[tauri::command]
async fn save_received_file(app: AppHandle, name: String, data: Vec<u8>) -> Result<(), String> {
    // Prefer auto-save to Downloads folder to avoid blocking dialog for each file
    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")));

    if let Some(dir) = downloads {
        if dir.exists() {
            // Avoid overwriting: append a counter if file already exists
            let mut dest = dir.join(&name);
            let stem = std::path::Path::new(&name)
                .file_stem().and_then(|s| s.to_str()).unwrap_or(&name);
            let ext = std::path::Path::new(&name)
                .extension().and_then(|s| s.to_str()).unwrap_or("");
            let mut counter = 1u32;
            while dest.exists() {
                let new_name = if ext.is_empty() {
                    format!("{} ({})", stem, counter)
                } else {
                    format!("{} ({}).{}", stem, counter, ext)
                };
                dest = dir.join(new_name);
                counter += 1;
            }
            std::fs::write(&dest, &data).map_err(|e| e.to_string())?;
            // Notify the frontend where the file was saved
            let _ = app.emit("file-saved", serde_json::json!({
                "name": name,
                "path": dest.to_string_lossy(),
            }));
            return Ok(());
        }
    }

    // Fallback: show native save dialog
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().set_file_name(&name).blocking_save_file();
    if let Some(p) = path {
        let buf = p.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&buf, &data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Check macOS permissions needed for remote desktop (accessibility + screen recording).
#[tauri::command]
fn check_macos_permissions() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        let accessibility = check_ax_permission();
        let screen_recording = check_screen_recording_permission();
        serde_json::json!({ "accessibility": accessibility, "screenRecording": screen_recording })
    }
    #[cfg(not(target_os = "macos"))]
    serde_json::json!({ "accessibility": true, "screenRecording": true })
}

#[cfg(target_os = "macos")]
fn check_ax_permission() -> bool {
    use std::os::raw::c_int;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> c_int;
    }
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(target_os = "macos")]
fn check_screen_recording_permission() -> bool {
    // CGPreflightScreenCaptureAccess: instant flag check, no frame captured.
    // Available since macOS 10.15. Falls back to capture attempt on older systems.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Open macOS System Settings to a specific privacy pane.
#[tauri::command]
fn open_privacy_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "screenRecording" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            _ => return Ok(()),
        };
        std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the agent-banner window height (used when chat panel opens/closes).
/// Preserves the current width so user resizes are respected.
#[tauri::command]
fn resize_agent_window(app: AppHandle, height: u32) {
    if let Some(win) = app.get_webview_window("agent-banner") {
        if let Ok(sf) = win.scale_factor() {
            let physical_h = (height as f64 * sf) as u32;
            let physical_w = win.inner_size()
                .map(|s| s.width)
                .unwrap_or((320.0 * sf) as u32);
            let _ = win.set_size(tauri::PhysicalSize::new(physical_w, physical_h));
        }
    }
}

/// Update the system tray tooltip (e.g., to show active session count).
#[tauri::command]
fn update_tray_tooltip(tooltip: String) {
    if let Some(tray) = TRAY.get() {
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

/// Regenerate the session password and re-register with the signaling server.
#[tauri::command]
async fn refresh_random_password(state: State<'_, AppState>) -> Result<String, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(123456);
    // LCG mix for better distribution from monotonic nanos
    let h: u64 = (nanos as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    let new_pw = ((h >> 17) % 900_000 + 100_000).to_string();

    *state.random_password.lock().await = new_pw.clone();

    let cfg = state.config.lock().unwrap().clone();
    let perm_pw = state.permanent_password.lock().unwrap().clone();
    let reg = serde_json::json!({
        "type": "register",
        "deviceId": cfg.device_id,
        "permanentPassword": if perm_pw.is_empty() { Value::Null } else { Value::String(perm_pw) },
        "randomPassword": new_pw,
    });
    let lock = state.signal_tx.lock().await;
    if let Some(tx) = lock.as_ref() {
        tx.send(reg).await.ok();
    }
    Ok(new_pw)
}

/// Enable or disable launch-on-startup (OS autostart).
#[tauri::command]
fn set_launch_on_startup(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let binary = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())?;
    let al = auto_launch::AutoLaunch::new("DoomsDesk", &binary, false, &[] as &[&str]);
    if enabled {
        al.enable().map_err(|e| e.to_string())?;
    } else if al.is_enabled().unwrap_or(false) {
        al.disable().map_err(|e| e.to_string())?;
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.launch_on_startup = enabled;
    config::save(&state.config_path.lock().unwrap(), &cfg);
    Ok(())
}

/// Query whether launch-on-startup is currently enabled via the OS.
#[tauri::command]
fn get_launch_on_startup() -> bool {
    let binary = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    auto_launch::AutoLaunch::new("DoomsDesk", &binary, false, &[] as &[&str])
        .is_enabled()
        .unwrap_or(false)
}

/// Returns the list of connected displays.
#[tauri::command]
fn list_monitors() -> Vec<Value> {
    capture::list_displays()
        .into_iter()
        .map(|d| serde_json::json!({
            "id": d.id,
            "width": d.width,
            "height": d.height,
            "isMain": d.is_main,
        }))
        .collect()
}

/// Switch which display is being captured. 0 = primary.
#[tauri::command]
fn set_capture_monitor(state: State<'_, AppState>, display_id: u32) {
    state.capture_display.store(display_id, Ordering::Relaxed);
}

/// Start screen capture + local binary WebSocket server.
/// Returns the port the WS server is listening on.
/// The agent window connects to ws://127.0.0.1:{port} and receives raw H.264 Annex B frames.
#[tauri::command]
async fn start_native_capture(app: AppHandle, state: State<'_, AppState>) -> Result<u16, String> {
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // Abort any previous WS server task
    if let Some(handle) = state.ws_handle.lock().unwrap().take() {
        handle.abort();
    }

    // Bind on OS-assigned port — eliminates port conflicts
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("capture WS bind: {}", e))?;
    let port = listener.local_addr().unwrap().port();

    let frame_tx = state.frame_tx.clone();

    // WS server: forward broadcast frames to any connected client
    let ws_task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let mut rx = frame_tx.subscribe();
                    tokio::spawn(async move {
                        if let Ok(ws) = accept_async(stream).await {
                            let (mut sink, _) = ws.split();
                            loop {
                                match rx.recv().await {
                                    Ok(data) => {
                                        // Empty vec = capture stopped; send Close and exit
                                        if data.is_empty() {
                                            let _ = sink.send(Message::Close(None)).await;
                                            break;
                                        }
                                        if sink.send(Message::Binary(data.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    Err(broadcast::error::RecvError::Closed) => break,
                                    // Lagged = encoder outpaced the subscriber; skip frames rather than crash
                                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                                }
                            }
                        }
                    });
                }
                Err(_) => break,
            }
        }
    });

    *state.ws_handle.lock().unwrap() = Some(ws_task);

    // Capture + encode loop (blocking thread)
    let gen_ref = state.capture_generation.clone();
    let bitrate_ref = state.capture_bitrate.clone();
    let display_ref = state.capture_display.clone();
    let frame_tx2 = state.frame_tx.clone();
    let my_gen = gen_ref.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn_blocking(move || {
        use screenshots::image::{DynamicImage, imageops::FilterType, RgbaImage};

        let mut encoder: Option<encode::H264Encoder> = None;
        let mut pts_ms: u64 = 0;
        let mut last_frame_hash: u64 = 0;
        let mut last_send_ms: u64 = 0;
        let mut last_bitrate: u32 = 0;
        const FRAME_MS: u64 = 33;          // ~30 fps
        const IDLE_FORCE_MS: u64 = 2_000;  // force keyalive even if screen is static

        loop {
            if gen_ref.load(Ordering::SeqCst) != my_gen {
                let _ = frame_tx2.send(vec![]); // signal WS clients to close
                break;
            }

            let frame_start = std::time::Instant::now();
            let display_id = display_ref.load(Ordering::Relaxed);

            let ok = (|| -> Option<()> {
                let frame = capture::capture_screen_at(display_id)?;
                let (w, h) = (frame.width, frame.height);

                let rgba_img = RgbaImage::from_raw(w, h, frame.data)?;
                let dyn_img = DynamicImage::ImageRgba8(rgba_img);

                // Cap at 1920 px wide to limit bandwidth; use Triangle filter (fast + good)
                let (eff_w, eff_h, rgba) = if w > 1920 {
                    let eff_h = (h as f64 * 1920.0 / w as f64) as u32;
                    let resized = dyn_img.resize(1920, eff_h, FilterType::Triangle);
                    let iw = resized.width();
                    let ih = resized.height();
                    (iw, ih, resized.into_rgba8().into_raw())
                } else {
                    (w, h, dyn_img.into_rgba8().into_raw())
                };

                // Recreate encoder only when resolution changes
                if encoder.as_ref().map(|e| e.dimensions()) != Some((eff_w, eff_h)) {
                    encoder = encode::H264Encoder::new(eff_w, eff_h);
                    pts_ms = 0;
                    last_frame_hash = 0;
                    last_send_ms = 0;
                }
                let enc = encoder.as_mut()?;

                // Live bitrate adaptation — no encoder recreation needed on macOS
                let wanted_bps = bitrate_ref.load(Ordering::Relaxed);
                if wanted_bps != last_bitrate {
                    enc.set_bitrate(wanted_bps.max(2_000_000));
                    last_bitrate = wanted_bps;
                }

                // Perceptual hash: sample every 512th byte with LCG mix
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
                    return Some(()); // static screen, no need to encode
                }
                last_frame_hash = hash;

                let encoded = enc.encode(&rgba, pts_ms)?;
                last_send_ms = pts_ms;

                // Send raw binary — no base64 encoding overhead
                let _ = frame_tx2.send(encoded.data);
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

    Ok(port)
}

#[tauri::command]
fn stop_native_capture(state: State<'_, AppState>) {
    // Increment generation — the capture loop exits on next iteration
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
    // Abort the WS server task immediately
    if let Some(handle) = state.ws_handle.lock().unwrap().take() {
        handle.abort();
    }
}

#[tauri::command]
fn set_capture_quality(state: State<'_, AppState>, quality: u8) {
    let clamped = quality.clamp(20, 95);
    state.capture_quality.store(clamped, Ordering::Relaxed);
}

#[tauri::command]
fn set_capture_bitrate(state: State<'_, AppState>, bps: u32) {
    let clamped = bps.clamp(2_000_000, 20_000_000);
    state.capture_bitrate.store(clamped, Ordering::Relaxed);
}

/// Capture the current display as a PNG and return base64-encoded bytes.
/// Returns base64 to avoid the slow JSON number-array serialization of Vec<u8>.
#[tauri::command]
fn capture_screenshot_png(state: State<'_, AppState>) -> Result<String, String> {
    use screenshots::image::{DynamicImage, RgbaImage, ImageFormat};
    use std::io::Cursor;

    let display_id = state.capture_display.load(Ordering::Relaxed);
    let frame = capture::capture_screen_at(display_id)
        .ok_or_else(|| "capture failed".to_string())?;

    // macOS capture gives BGRX (kCGImageAlphaNoneSkipLast, little-endian).
    // Swap R↔B and set A=255 to get proper RGBA for PNG encoding.
    #[cfg(target_os = "macos")]
    let pixel_data = {
        let mut d = frame.data;
        for i in (0..d.len()).step_by(4) {
            d.swap(i, i + 2);
            d[i + 3] = 255;
        }
        d
    };
    #[cfg(not(target_os = "macos"))]
    let pixel_data = frame.data;

    let img = RgbaImage::from_raw(frame.width, frame.height, pixel_data)
        .ok_or_else(|| "invalid frame buffer".to_string())?;
    let dyn_img = DynamicImage::ImageRgba8(img);

    let mut buf = Cursor::new(Vec::new());
    dyn_img.write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
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
            let start_minimized = cfg.start_minimized;

            // Broadcast channel for raw H.264 frames; capacity 8 allows brief bursts
            let (frame_tx, _) = broadcast::channel::<Vec<u8>>(8);

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
                capture_bitrate: Arc::new(AtomicU32::new(4_000_000)),
                capture_display: Arc::new(AtomicU32::new(0)),
                frame_tx,
                ws_handle: Mutex::new(None),
            });

            signaling::start(
                app.handle().clone(),
                server_url,
                device_id,
                perm_pw,
                signal_tx,
                random_password,
                is_connected,
            );

            if let Some(win) = app.get_webview_window("main") {
                if start_minimized {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                }
            }

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
            list_monitors,
            set_capture_monitor,
            save_received_file,
            capture_screenshot_png,
            refresh_random_password,
            set_launch_on_startup,
            get_launch_on_startup,
            update_tray_tooltip,
            resize_agent_window,
            check_macos_permissions,
            open_privacy_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
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

    let tray = TrayIconBuilder::new()
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
    TRAY.set(tray).ok();
    Ok(())
}
