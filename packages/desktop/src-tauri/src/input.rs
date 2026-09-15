use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

pub struct InputWorker {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
}

impl InputWorker {
    pub fn start(resource_dir: &PathBuf) -> Option<Self> {
        let (program, args): (String, Vec<String>) = if cfg!(target_os = "macos") {
            let script = resource_dir.join("resources").join("input-worker.py");
            let py = find_python3();
            (py, vec![script.to_string_lossy().to_string()])
        } else if cfg!(windows) {
            let script = resource_dir.join("resources").join("input-worker.ps1");
            (
                "powershell".into(),
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().to_string(),
                ],
            )
        } else {
            return None;
        };

        let mut child = Command::new(&program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        let stdin = child.stdin.take()?;
        let child = Arc::new(Mutex::new(Some(child)));
        let stdin = Arc::new(Mutex::new(Some(stdin)));

        Some(InputWorker { child, stdin })
    }

    pub fn send(&self, event: &Value) -> std::io::Result<()> {
        let mut lock = self.stdin.lock().unwrap();
        if let Some(stdin) = lock.as_mut() {
            let line = format!("{}\n", event);
            stdin.write_all(line.as_bytes())?;
            stdin.flush()?;
        }
        Ok(())
    }

    pub fn stop(&self) {
        let mut lock = self.child.lock().unwrap();
        if let Some(mut child) = lock.take() {
            child.kill().ok();
        }
    }
}

fn find_python3() -> String {
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
        "python3",
    ];
    for p in &candidates {
        if std::process::Command::new(p)
            .arg("--version")
            .output()
            .is_ok()
        {
            return p.to_string();
        }
    }
    "python3".into()
}
