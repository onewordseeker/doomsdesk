use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub device_id: String,
    pub permanent_password: String,
    pub theme: String,
    pub start_minimized: bool,
    pub launch_on_startup: bool,
    pub server_url: String,
    pub web_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_credential: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            device_id: generate_device_id(),
            permanent_password: String::new(),
            theme: "dark".into(),
            start_minimized: false,
            launch_on_startup: false,
            server_url: "wss://doomsdesk.hamidentifier.cloud/signaling".into(),
            web_url: "https://doomsdesk.hamidentifier.cloud".into(),
            turn_url: None,
            turn_username: None,
            turn_credential: None,
        }
    }
}

fn generate_device_id() -> String {
    let digits: String = Uuid::new_v4()
        .to_string()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(9)
        .collect();
    let digits = format!("{:0>9}", digits);
    format!("{}-{}-{}", &digits[0..3], &digits[3..6], &digits[6..9])
}

pub fn load(config_path: &PathBuf) -> Config {
    if let Ok(data) = fs::read_to_string(config_path) {
        if let Ok(mut cfg) = serde_json::from_str::<Config>(&data) {
            if cfg.device_id.is_empty() {
                cfg.device_id = generate_device_id();
                save(config_path, &cfg);
            }
            return cfg;
        }
    }
    let cfg = Config::default();
    save(config_path, &cfg);
    cfg
}

pub fn save(config_path: &PathBuf, config: &Config) {
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(config) {
        let _ = fs::write(config_path, data);
    }
}
