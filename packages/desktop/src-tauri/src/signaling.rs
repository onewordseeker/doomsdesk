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
            app,
            url,
            device_id,
            permanent_password,
            tx_state,
            random_password,
            is_connected,
        )
        .await;
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
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
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
                let _ = sink
                    .send(Message::Text(reg.to_string().into()))
                    .await;

                loop {
                    tokio::select! {
                        msg = stream.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                                        handle_message(&app, &parsed, &random_password).await;
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
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
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

async fn handle_message(
    app: &AppHandle,
    msg: &Value,
    random_password: &Arc<Mutex<String>>,
) {
    let msg_type = msg
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Update random password if server returns one
    if msg_type == "registered" {
        if let Some(rp) = msg.get("randomPassword").and_then(|v| v.as_str()) {
            *random_password.lock().await = rp.to_string();
        }
    }

    // Forward all messages to frontend
    let _ = app.emit("signaling-message", msg);

    // Emit specific lifecycle events
    match msg_type {
        "connect_result" => {
            let approved = msg
                .get("approved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let peer_id = msg
                .get("peerId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if approved && !peer_id.is_empty() {
                let _ = app.emit(
                    "start-session",
                    serde_json::json!({ "peerId": peer_id, "role": "controller" }),
                );
            }
        }
        "session_started" => {
            let controller_id = msg
                .get("controllerId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
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

    // Hide main window first
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }

    // Hidden background window — JS runs WebRTC + native capture, no visible UI needed
    match tauri::WebviewWindowBuilder::new(
        app,
        "agent-banner",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("DoomsDesk")
    .inner_size(1.0, 1.0)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .build()
    {
        Ok(_) => {}
        Err(e) => eprintln!("[signaling] Failed to create agent window: {}", e),
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

fn rand_6digit() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        .hash(&mut h);
    (h.finish() % 900_000 + 100_000) as u32
}
