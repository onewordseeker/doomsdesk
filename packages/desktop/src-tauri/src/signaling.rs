use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub type SignalTx = mpsc::Sender<Value>;

pub fn start(
    app: AppHandle,
    url: String,
    device_id: String,
    permanent_password: String,
    tx_state: Arc<Mutex<Option<SignalTx>>>,
    random_password: Arc<Mutex<String>>,
    is_connected: Arc<Mutex<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        run_loop(
            app, url, device_id, permanent_password,
            tx_state, random_password, is_connected,
        ).await;
    });
}

async fn run_loop(
    app: AppHandle,
    url: String,
    device_id: String,
    permanent_password: String,
    tx_state: Arc<Mutex<Option<SignalTx>>>,
    random_password: Arc<Mutex<String>>,
    is_connected: Arc<Mutex<bool>>,
) {
    // Exponential backoff: 2, 4, 8, … up to 60s, with ±30% jitter
    let mut backoff_secs: u64 = 2;

    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                backoff_secs = 2; // reset on successful connect

                *is_connected.lock().await = true;
                let (mut sink, mut stream) = ws.split();
                let (tx, mut rx) = mpsc::channel::<Value>(100);
                *tx_state.lock().await = Some(tx);

                // Generate or reuse random password
                let rp = {
                    let mut rp_lock = random_password.lock().await;
                    if rp_lock.is_empty() {
                        let n = rand_6digit();
                        *rp_lock = n.to_string();
                    }
                    rp_lock.clone()
                };

                let reg = serde_json::json!({
                    "type": "register",
                    "deviceId": device_id,
                    "permanentPassword": if permanent_password.is_empty() {
                        Value::Null
                    } else {
                        Value::String(permanent_password.clone())
                    },
                    "randomPassword": rp,
                });
                let _ = sink.send(Message::Text(reg.to_string().into())).await;

                // Ping timer — keeps the connection alive and measures RTT
                let mut ping_interval =
                    tokio::time::interval(tokio::time::Duration::from_secs(30));
                ping_interval.tick().await; // consume immediate first tick

                let mut last_ping_t: u64 = 0;

                loop {
                    tokio::select! {
                        msg = stream.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                                        // Measure RTT on pong
                                        if parsed.get("type").and_then(|v| v.as_str()) == Some("pong") {
                                            if let Some(t) = parsed.get("t").and_then(|v| v.as_u64()) {
                                                let now = unix_ms();
                                                if t == last_ping_t && t > 0 {
                                                    let rtt = now.saturating_sub(t);
                                                    let _ = app.emit(
                                                        "signaling-rtt",
                                                        serde_json::json!({ "rtt": rtt }),
                                                    );
                                                }
                                            }
                                        }
                                        handle_message(&app, &parsed, &random_password).await;
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(e)) => {
                                    eprintln!("[signaling] ws error: {}", e);
                                    break;
                                }
                                _ => {}
                            }
                        }
                        out = rx.recv() => {
                            match out {
                                Some(msg) => {
                                    let _ = sink.send(Message::Text(msg.to_string().into())).await;
                                }
                                None => break,
                            }
                        }
                        _ = ping_interval.tick() => {
                            last_ping_t = unix_ms();
                            let ping = serde_json::json!({ "type": "ping", "t": last_ping_t });
                            let _ = sink.send(Message::Text(ping.to_string().into())).await;
                        }
                    }
                }

                *is_connected.lock().await = false;
                *tx_state.lock().await = None;
                let _ = app.emit("server-disconnected", ());
            }
            Err(e) => {
                eprintln!("[signaling] connect failed: {}", e);
                *is_connected.lock().await = false;
                let _ = app.emit("server-disconnected", ());
            }
        }

        // Backoff with ±30% jitter to spread reconnect storms
        let jitter = (backoff_secs * 30 / 100).max(1);
        let delay = backoff_secs.saturating_add(rand_jitter(jitter));
        eprintln!("[signaling] reconnecting in {}s", delay);
        tokio::time::sleep(tokio::time::Duration::from_secs(delay)).await;
        backoff_secs = (backoff_secs * 2).min(60);
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn rand_jitter(max: u64) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    unix_ms().hash(&mut h);
    h.finish() % (max + 1)
}

fn rand_6digit() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    unix_ms().hash(&mut h);
    (h.finish() % 900_000 + 100_000) as u32
}

async fn handle_message(
    app: &AppHandle,
    msg: &Value,
    random_password: &Arc<Mutex<String>>,
) {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if msg_type == "registered" {
        if let Some(rp) = msg.get("randomPassword").and_then(|v| v.as_str()) {
            *random_password.lock().await = rp.to_string();
        }
    }

    let _ = app.emit("signaling-message", msg);

    match msg_type {
        "connect_result" => {
            let approved = msg.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
            let peer_id = msg
                .get("peerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if approved && !peer_id.is_empty() {
                let _ = app.emit(
                    "start-session",
                    serde_json::json!({ "peerId": peer_id, "role": "controller" }),
                );
            }
        }
        "session_started" => {
            let controller_id = msg
                .get("controllerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !controller_id.is_empty() {
                create_agent_window(app, &controller_id);
            }
        }
        "peer_disconnected" => {
            close_agent_window(app);
            let _ = app.emit("session-ended", ());
        }
        _ => {}
    }
}

pub fn create_agent_window(app: &AppHandle, peer_id: &str) {
    let url = format!("/?peer={}&role=agent", peer_id);

    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }

    match tauri::WebviewWindowBuilder::new(
        app,
        "agent-banner",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("DoomsDesk — Remote Session")
    .inner_size(320.0, 72.0)
    .decorations(false)
    .skip_taskbar(false)
    .resizable(false)
    .always_on_top(true)
    .visible(true)
    .focused(false)
    .build()
    {
        Ok(win) => {
            // Position at top-right of primary monitor
            if let (Ok(sf), Ok(mon)) = (win.scale_factor(), win.current_monitor()) {
                if let Some(m) = mon {
                    let pos = m.position();
                    let size = m.size();
                    let w = (320.0 * sf) as i32;
                    let margin = (16.0 * sf) as i32;
                    let x = pos.x + size.width as i32 - w - margin;
                    let y = pos.y + margin;
                    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
        }
        Err(e) => eprintln!("[signaling] agent window error: {}", e),
    }
}

pub fn close_agent_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("agent-banner") {
        let _ = win.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
    }
}
