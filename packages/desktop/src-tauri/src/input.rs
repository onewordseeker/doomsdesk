use serde_json::Value;
use std::sync::mpsc;

pub struct InputWorker {
    sender: mpsc::SyncSender<Value>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl InputWorker {
    pub fn start(_resource_dir: &std::path::PathBuf) -> Option<Self> {
        let (tx, rx) = mpsc::sync_channel::<Value>(256);
        let handle = std::thread::Builder::new()
            .name("aetherlink-input".into())
            .spawn(move || platform::run_loop(rx))
            .ok()?;
        Some(Self { sender: tx, handle: Some(handle) })
    }

    pub fn send(&self, event: &Value) -> std::io::Result<()> {
        self.sender.try_send(event.clone()).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })
    }

    pub fn stop(mut self) {
        drop(self.sender);
        if let Some(h) = self.handle.take() {
            h.join().ok();
        }
    }
}

// ── macOS ─────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use serde_json::Value;
    use std::os::raw::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }

    // Mouse event types
    const MOVED: u32 = 5;
    const LD: u32 = 1; const LU: u32 = 2;
    const RD: u32 = 3; const RU: u32 = 4;
    const MD: u32 = 25; const MU: u32 = 26;
    // Mouse buttons
    const BL: u32 = 0; const BR: u32 = 1; const BM: u32 = 2;
    // Event tap (HID)
    const HID: u32 = 0;
    // Modifier flags
    const F_SHIFT: u64 = 0x0002_0000;
    const F_CTRL:  u64 = 0x0004_0000;
    const F_ALT:   u64 = 0x0008_0000;
    const F_CMD:   u64 = 0x0010_0000;
    // Scroll unit: pixel
    const SCROLL_PIXEL: u32 = 0;

    // CGEvent virtual key codes for clipboard paste
    const VK_V: u16 = 9;
    const VK_META: u16 = 55;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateMouseEvent(
            src: *mut c_void, t: u32, pos: CGPoint, btn: u32,
        ) -> *mut c_void;
        fn CGEventCreateKeyboardEvent(
            src: *mut c_void, vk: u16, down: bool,
        ) -> *mut c_void;
            // CGEventCreateScrollWheelEvent2: fixed-arity version supporting up to 3 axes
        fn CGEventCreateScrollWheelEvent2(
            src: *mut c_void, unit: u32, wc: u32, w1: i32, w2: i32, w3: i32,
        ) -> *mut c_void;
        fn CGEventPost(tap: u32, ev: *mut c_void);
        fn CGEventSetFlags(ev: *mut c_void, flags: u64);
        fn CGEventSetIntegerValueField(ev: *mut c_void, field: i32, val: i64);
        fn CGEventGetLocation(ev: *mut c_void) -> CGPoint;
        fn CGEventCreate(src: *mut c_void) -> *mut c_void;
        fn CFRelease(cf: *mut c_void);
    }

    // kCGMouseEventDeltaX = 4, kCGMouseEventDeltaY = 5 (from CGEvent.h)
    const MOUSE_DELTA_X: i32 = 4;
    const MOUSE_DELTA_Y: i32 = 5;

    #[inline]
    unsafe fn post_mouse(t: u32, x: f64, y: f64, btn: u32) {
        let ev = CGEventCreateMouseEvent(
            std::ptr::null_mut(), t, CGPoint { x, y }, btn,
        );
        if !ev.is_null() { CGEventPost(HID, ev); CFRelease(ev); }
    }

    #[inline]
    unsafe fn post_key(vk: u16, down: bool, flags: u64) {
        let ev = CGEventCreateKeyboardEvent(std::ptr::null_mut(), vk, down);
        if !ev.is_null() {
            if flags != 0 { CGEventSetFlags(ev, flags); }
            CGEventPost(HID, ev);
            CFRelease(ev);
        }
    }

    #[inline]
    unsafe fn post_scroll(dy: i32, dx: i32) {
        let axes = if dx != 0 { 2 } else { 1 };
        let ev = CGEventCreateScrollWheelEvent2(
            std::ptr::null_mut(), SCROLL_PIXEL, axes, dy, dx, 0,
        );
        if !ev.is_null() { CGEventPost(HID, ev); CFRelease(ev); }
    }

    // Virtual cursor position for relative movement — -1 means "not yet initialized"
    static CURSOR_X: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
    static CURSOR_Y: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

    fn web_key_to_vk(key: &str) -> Option<u16> {
        // Try direct match first, then lowercase for single-char keys
        vk_lookup(key).or_else(|| {
            if key.len() == 1 {
                let lower = key.to_ascii_lowercase();
                vk_lookup(&lower)
            } else {
                None
            }
        })
    }

    fn vk_lookup(key: &str) -> Option<u16> {
        Some(match key {
            "a" => 0,  "s" => 1,  "d" => 2,  "f" => 3,  "h" => 4,
            "g" => 5,  "z" => 6,  "x" => 7,  "c" => 8,  "v" => 9,
            "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15,
            "y" => 16, "t" => 17,
            "1" | "!" => 18, "2" | "@" => 19, "3" | "#" => 20,
            "4" | "$" => 21, "6" | "^" => 22, "5" | "%" => 23,
            "=" | "+" => 24, "9" | "(" => 25, "7" | "&" => 26,
            "-" | "_" => 27, "8" | "*" => 28, "0" | ")" => 29,
            "]" | "}" => 30, "o" => 31, "u" => 32, "[" | "{" => 33,
            "i" => 34, "p" => 35, "l" => 37, "j" => 38,
            "'" | "\"" => 39, "k" => 40, ";" | ":" => 41,
            "\\" | "|" => 42, "," | "<" => 43, "/" | "?" => 44,
            "n" => 45, "m" => 46, "." | ">" => 47, "`" | "~" => 50,
            "Enter" => 36, "Tab" => 48, " " => 49, "Backspace" => 51,
            "Escape" => 53, "Delete" => 117,
            "Meta" => 55, "Shift" => 56, "CapsLock" => 57,
            "Alt" => 58, "Control" => 59,
            "ArrowRight" => 124, "ArrowLeft" => 123,
            "ArrowDown" => 125, "ArrowUp" => 126,
            "Home" => 115, "End" => 119,
            "PageUp" => 116, "PageDown" => 121,
            "F1"  => 122, "F2"  => 120, "F3"  => 99,  "F4"  => 118,
            "F5"  => 96,  "F6"  => 97,  "F7"  => 98,  "F8"  => 100,
            "F9"  => 101, "F10" => 109, "F11" => 103, "F12" => 111,
            _ => return None,
        })
    }

    pub fn run_loop(rx: std::sync::mpsc::Receiver<Value>) {
        for ev in rx { handle(&ev); }
    }

    fn handle(ev: &Value) {
        let t   = ev["type"].as_str().unwrap_or("");
        let x   = ev["x"].as_f64().unwrap_or(0.0);
        let y   = ev["y"].as_f64().unwrap_or(0.0);
        let btn = ev["button"].as_str().unwrap_or("left");
        let key = ev["key"].as_str().unwrap_or("");
        let m   = &ev["modifiers"];

        unsafe {
            match t {
                "mousemove" => {
                    // Sync virtual cursor with absolute position
                    CURSOR_X.store(x as i64, std::sync::atomic::Ordering::Relaxed);
                    CURSOR_Y.store(y as i64, std::sync::atomic::Ordering::Relaxed);
                    post_mouse(MOVED, x, y, BL)
                }

                "mousemove_rel" => {
                    let dx = ev["dx"].as_f64().unwrap_or(0.0);
                    let dy = ev["dy"].as_f64().unwrap_or(0.0);
                    let old_x = CURSOR_X.load(std::sync::atomic::Ordering::Relaxed);
                    let old_y = CURSOR_Y.load(std::sync::atomic::Ordering::Relaxed);
                    if old_x < 0 {
                        // Not yet initialized — use screen center
                        let ev0 = CGEventCreate(std::ptr::null_mut());
                        let loc = if !ev0.is_null() { let p = CGEventGetLocation(ev0); CFRelease(ev0); p } else { CGPoint { x: 960.0, y: 540.0 } };
                        CURSOR_X.store(loc.x as i64, std::sync::atomic::Ordering::Relaxed);
                        CURSOR_Y.store(loc.y as i64, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                    let new_x = (old_x as f64 + dx).max(0.0);
                    let new_y = (old_y as f64 + dy).max(0.0);
                    CURSOR_X.store(new_x as i64, std::sync::atomic::Ordering::Relaxed);
                    CURSOR_Y.store(new_y as i64, std::sync::atomic::Ordering::Relaxed);
                    let ev = CGEventCreateMouseEvent(std::ptr::null_mut(), MOVED, CGPoint { x: new_x, y: new_y }, BL);
                    if !ev.is_null() {
                        CGEventSetIntegerValueField(ev, MOUSE_DELTA_X, dx as i64);
                        CGEventSetIntegerValueField(ev, MOUSE_DELTA_Y, dy as i64);
                        CGEventPost(HID, ev);
                        CFRelease(ev);
                    }
                }

                "mousedown" | "click" => {
                    let click = t == "click";
                    match btn {
                        "right"  => { post_mouse(RD, x, y, BR); if click { post_mouse(RU, x, y, BR); } }
                        "middle" => { post_mouse(MD, x, y, BM); if click { post_mouse(MU, x, y, BM); } }
                        _        => { post_mouse(LD, x, y, BL); if click { post_mouse(LU, x, y, BL); } }
                    }
                }

                "mouseup" => match btn {
                    "right"  => post_mouse(RU, x, y, BR),
                    "middle" => post_mouse(MU, x, y, BM),
                    _        => post_mouse(LU, x, y, BL),
                },

                "dblclick" => {
                    // Two rapid left clicks
                    post_mouse(LD, x, y, BL); post_mouse(LU, x, y, BL);
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    post_mouse(LD, x, y, BL); post_mouse(LU, x, y, BL);
                }

                "wheel" => {
                    let dy = ev["deltaY"].as_f64().unwrap_or(0.0);
                    let dx = ev["deltaX"].as_f64().unwrap_or(0.0);
                    let ticks_y = ((-dy) / 20.0) as i32;
                    let ticks_x = ((-dx) / 20.0) as i32;
                    if ticks_y != 0 || ticks_x != 0 { post_scroll(ticks_y, ticks_x); }
                }

                "keydown" | "keyup" => {
                    let down = t == "keydown";
                    if let Some(vk) = web_key_to_vk(key) {
                        let mut flags: u64 = 0;
                        let is_upper = key.len() == 1
                            && key.chars().next().map_or(false, |c| c.is_uppercase());
                        if m["shift"].as_bool().unwrap_or(false) || is_upper { flags |= F_SHIFT; }
                        if m["ctrl"].as_bool().unwrap_or(false)  { flags |= F_CTRL; }
                        if m["alt"].as_bool().unwrap_or(false)   { flags |= F_ALT; }
                        if m["meta"].as_bool().unwrap_or(false)  { flags |= F_CMD; }
                        post_key(vk, down, flags);
                    }
                }

                "clipboard" => {
                    if let Some(text) = ev["text"].as_str() {
                        // Write text to system clipboard, then simulate Cmd+V
                        let mut child = std::process::Command::new("pbcopy")
                            .stdin(std::process::Stdio::piped())
                            .spawn();
                        if let Ok(ref mut c) = child {
                            if let Some(mut stdin) = c.stdin.take() {
                                use std::io::Write;
                                let _ = stdin.write_all(text.as_bytes());
                            }
                            let _ = c.wait();
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        post_key(VK_META, true, 0);
                        post_key(VK_V, true, F_CMD);
                        post_key(VK_V, false, F_CMD);
                        post_key(VK_META, false, 0);
                    }
                }

                "set_display_resolution" => {
                    let w = ev["width"].as_u64().unwrap_or(0);
                    let h = ev["height"].as_u64().unwrap_or(0);
                    if w > 0 && h > 0 {
                        let _ = std::process::Command::new("displayplacer")
                            .arg(format!("res:{}x{}", w, h))
                            .arg("scaling:off")
                            .spawn();
                    }
                }

                "send_keys" => {
                    let combo = ev["combo"].as_str().unwrap_or("");
                    match combo {
                        "lock" => {
                            let _ = std::process::Command::new(
                                "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession"
                            ).arg("-suspend").spawn();
                        }
                        "task_mgr" | "ctrl_shift_esc" => {
                            let _ = std::process::Command::new("open")
                                .args(["-a", "Activity Monitor"])
                                .spawn();
                        }
                        "ctrl_alt_del" => {
                            // macOS has no equivalent — open Force Quit as closest analog
                            let _ = std::process::Command::new("open")
                                .args(["-a", "Force Quit Applications"])
                                .spawn();
                        }
                        _ => {}
                    }
                }

                _ => {}
            }
        }
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────
#[cfg(windows)]
mod platform {
    use serde_json::Value;

    const LEFTDOWN:   u32 = 0x0002;
    const LEFTUP:     u32 = 0x0004;
    const RIGHTDOWN:  u32 = 0x0008;
    const RIGHTUP:    u32 = 0x0010;
    const MIDDLEDOWN: u32 = 0x0020;
    const MIDDLEUP:   u32 = 0x0040;
    const WHEEL:      u32 = 0x0800;
    const HWHEEL:     u32 = 0x1000;
    const KEYUP:      u32 = 0x0002;

    #[link(name = "user32")]
    extern "system" {
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn mouse_event(dw_flags: u32, dx: u32, dy: u32, dw_data: u32, dw_extra: usize);
        fn keybd_event(bvk: u8, b_scan: u8, dw_flags: u32, dw_extra: usize);
        fn LockWorkStation() -> i32;
    }

    fn web_key_to_vk(key: &str) -> Option<u8> {
        Some(match key {
            "Backspace" => 0x08, "Tab" => 0x09, "Enter" => 0x0D,
            "Shift" => 0x10, "Control" => 0x11, "Alt" => 0x12,
            "CapsLock" => 0x14, "Escape" => 0x1B, " " => 0x20,
            "PageUp" => 0x21, "PageDown" => 0x22,
            "End" => 0x23, "Home" => 0x24,
            "ArrowLeft" => 0x25, "ArrowUp" => 0x26,
            "ArrowRight" => 0x27, "ArrowDown" => 0x28,
            "Delete" => 0x2E, "Meta" => 0x5B,
            "F1"  => 0x70, "F2"  => 0x71, "F3"  => 0x72, "F4"  => 0x73,
            "F5"  => 0x74, "F6"  => 0x75, "F7"  => 0x76, "F8"  => 0x77,
            "F9"  => 0x78, "F10" => 0x79, "F11" => 0x7A, "F12" => 0x7B,
            k if k.len() == 1 => {
                (k.chars().next()?.to_ascii_uppercase() as u32) as u8
            }
            _ => return None,
        })
    }

    pub fn run_loop(rx: std::sync::mpsc::Receiver<Value>) {
        for ev in rx { handle(&ev); }
    }

    fn handle(ev: &Value) {
        let t   = ev["type"].as_str().unwrap_or("");
        let x   = ev["x"].as_i64().unwrap_or(0) as i32;
        let y   = ev["y"].as_i64().unwrap_or(0) as i32;
        let btn = ev["button"].as_str().unwrap_or("left");
        let key = ev["key"].as_str().unwrap_or("");
        let m   = &ev["modifiers"];

        unsafe {
            match t {
                "mousemove" => { SetCursorPos(x, y); }

                "mousemove_rel" => {
                    let dx = ev["dx"].as_i64().unwrap_or(0) as i32;
                    let dy = ev["dy"].as_i64().unwrap_or(0) as i32;
                    // MOUSEEVENTF_MOVE (0x0001) without ABSOLUTE flag = relative movement
                    mouse_event(0x0001, dx as u32, dy as u32, 0, 0);
                }

                "mousedown" | "click" => {
                    SetCursorPos(x, y);
                    let click = t == "click";
                    match btn {
                        "right" => {
                            mouse_event(RIGHTDOWN, 0, 0, 0, 0);
                            if click { mouse_event(RIGHTUP, 0, 0, 0, 0); }
                        }
                        "middle" => {
                            mouse_event(MIDDLEDOWN, 0, 0, 0, 0);
                            if click { mouse_event(MIDDLEUP, 0, 0, 0, 0); }
                        }
                        _ => {
                            mouse_event(LEFTDOWN, 0, 0, 0, 0);
                            if click { mouse_event(LEFTUP, 0, 0, 0, 0); }
                        }
                    }
                }

                "mouseup" => match btn {
                    "right"  => mouse_event(RIGHTUP,  0, 0, 0, 0),
                    "middle" => mouse_event(MIDDLEUP, 0, 0, 0, 0),
                    _        => mouse_event(LEFTUP,   0, 0, 0, 0),
                },

                "dblclick" => {
                    SetCursorPos(x, y);
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0);
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0);
                }

                "wheel" => {
                    let dy = ev["deltaY"].as_f64().unwrap_or(0.0);
                    let dx = ev["deltaX"].as_f64().unwrap_or(0.0);
                    let v_delta = ((-dy) * 6.0) as i32;
                    let h_delta = (dx * 6.0) as i32;
                    if v_delta != 0 { mouse_event(WHEEL,  0, 0, v_delta as u32, 0); }
                    if h_delta != 0 { mouse_event(HWHEEL, 0, 0, h_delta as u32, 0); }
                }

                "keydown" => {
                    if m["ctrl"].as_bool().unwrap_or(false)  { keybd_event(0x11, 0, 0, 0); }
                    if m["shift"].as_bool().unwrap_or(false) { keybd_event(0x10, 0, 0, 0); }
                    if m["alt"].as_bool().unwrap_or(false)   { keybd_event(0x12, 0, 0, 0); }
                    if m["meta"].as_bool().unwrap_or(false)  { keybd_event(0x5B, 0, 0, 0); }
                    if let Some(vk) = web_key_to_vk(key) { keybd_event(vk, 0, 0, 0); }
                }

                "keyup" => {
                    if let Some(vk) = web_key_to_vk(key) { keybd_event(vk, 0, KEYUP, 0); }
                    if m["meta"].as_bool().unwrap_or(false)  { keybd_event(0x5B, 0, KEYUP, 0); }
                    if m["alt"].as_bool().unwrap_or(false)   { keybd_event(0x12, 0, KEYUP, 0); }
                    if m["shift"].as_bool().unwrap_or(false) { keybd_event(0x10, 0, KEYUP, 0); }
                    if m["ctrl"].as_bool().unwrap_or(false)  { keybd_event(0x11, 0, KEYUP, 0); }
                }

                "clipboard" => {
                    if let Some(text) = ev["text"].as_str() {
                        let escaped = text.replace('\'', "''");
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-NonInteractive", "-Command",
                                   &format!("Set-Clipboard -Value '{}'", escaped)])
                            .status();
                        keybd_event(0x11, 0, 0, 0); // Ctrl down
                        keybd_event(0x56, 0, 0, 0); // V down
                        keybd_event(0x56, 0, KEYUP, 0);
                        keybd_event(0x11, 0, KEYUP, 0);
                    }
                }

                "set_display_resolution" => {
                    let w = ev["width"].as_u64().unwrap_or(0);
                    let h = ev["height"].as_u64().unwrap_or(0);
                    if w > 0 && h > 0 {
                        let script = format!(
                            "$dm=New-Object System.Object;\
                            Add-Type -MemberDefinition '[DllImport(\"user32.dll\")]public static extern int ChangeDisplaySettings(ref object dm,int f);' -Name U -Namespace W;\
                            $dm|Add-Member dmPelsWidth {};\
                            $dm|Add-Member dmPelsHeight {};\
                            [W.U]::ChangeDisplaySettings([ref]$dm,0)", w, h
                        );
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                            .spawn();
                    }
                }

                "send_keys" => {
                    let combo = ev["combo"].as_str().unwrap_or("");
                    match combo {
                        "lock" => { LockWorkStation(); }
                        "task_mgr" | "ctrl_shift_esc" => {
                            // Ctrl+Shift+Esc opens Task Manager
                            keybd_event(0x11, 0, 0, 0); // Ctrl ↓
                            keybd_event(0x10, 0, 0, 0); // Shift ↓
                            keybd_event(0x1B, 0, 0, 0); // Esc ↓
                            keybd_event(0x1B, 0, KEYUP, 0);
                            keybd_event(0x10, 0, KEYUP, 0);
                            keybd_event(0x11, 0, KEYUP, 0);
                        }
                        "ctrl_alt_del" => {
                            // Simulate Ctrl+Alt+Del via SAS (Secure Attention Sequence)
                            // keybd_event cannot send CAD directly; use the SAS stub DLL approach via powershell
                            let _ = std::process::Command::new("powershell")
                                .args(["-NoProfile", "-NonInteractive", "-Command",
                                       "(New-Object -comObject Shell.Application).WindowsSecurity()"])
                                .spawn();
                        }
                        _ => {}
                    }
                }

                _ => {}
            }
        }
    }
}

// ── Linux / unsupported ───────────────────────────────────────────────────────
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn run_loop(rx: std::sync::mpsc::Receiver<serde_json::Value>) {
        for _ in rx {}
    }
}
