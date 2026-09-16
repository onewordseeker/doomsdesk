// Screen capture abstraction.
//
// macOS: CGDisplayCreateImage via CoreGraphics (non-deprecated, lower latency
//        than the screenshots crate's CGWindowListCreateImage path).
//        Returns native pixel resolution — Retina displays return 2x data.
//
// Windows / other: screenshots crate (DXGI / GDI path).
//
// Public API: capture_screen() -> Option<RgbaFrame>

pub struct RgbaFrame {
    pub data: Vec<u8>,  // RGBA8, row-major, width*height*4 bytes
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "macos")]
pub use macos::capture_screen;

#[cfg(not(target_os = "macos"))]
pub use fallback::capture_screen;

// ── macOS ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::RgbaFrame;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize { width: f64, height: f64 }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect { origin: CGPoint, size: CGSize }

    // kCGImageAlphaNoneSkipLast (5) — RGBX, 4 bytes/pixel, alpha slot forced to 0
    // kCGBitmapByteOrderDefault (0) — native byte order, no swap
    // Combined: gives R,G,B,0 in memory — safe to pass to VideoToolbox after swap(0,2)
    const BITMAP_INFO: u32 = 5;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateImage(displayID: u32) -> *mut c_void; // CGImageRef
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(cs: *mut c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize, height: usize,
            bitsPerComponent: usize,
            bytesPerRow: usize,
            space: *mut c_void,
            bitmapInfo: u32,
        ) -> *mut c_void; // CGContextRef
        fn CGContextRelease(ctx: *mut c_void);
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
    }

    pub fn capture_screen() -> Option<RgbaFrame> {
        unsafe {
            let display = CGMainDisplayID();
            let cg_image = CGDisplayCreateImage(display);
            if cg_image.is_null() { return None; }

            let w = CGImageGetWidth(cg_image);
            let h = CGImageGetHeight(cg_image);
            if w == 0 || h == 0 {
                CGImageRelease(cg_image);
                return None;
            }

            let mut rgba = vec![0u8; w * h * 4];
            let cs = CGColorSpaceCreateDeviceRGB();
            let ctx = CGBitmapContextCreate(
                rgba.as_mut_ptr() as *mut c_void,
                w, h, 8, w * 4, cs, BITMAP_INFO,
            );
            CGColorSpaceRelease(cs);

            if ctx.is_null() {
                CGImageRelease(cg_image);
                return None;
            }

            let rect = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize { width: w as f64, height: h as f64 },
            };
            CGContextDrawImage(ctx, rect, cg_image);
            CGContextRelease(ctx);
            CGImageRelease(cg_image);

            Some(RgbaFrame { data: rgba, width: w as u32, height: h as u32 })
        }
    }
}

// ── Windows / Linux — screenshots crate ──────────────────────────────────────

#[cfg(not(target_os = "macos"))]
mod fallback {
    use super::RgbaFrame;
    use screenshots::Screen;

    pub fn capture_screen() -> Option<RgbaFrame> {
        let screens = Screen::all().ok()?;
        let screen = screens.into_iter().next()?;
        let img = screen.capture().ok()?;
        let width = img.width();
        let height = img.height();
        Some(RgbaFrame { data: img.into_raw(), width, height })
    }
}
