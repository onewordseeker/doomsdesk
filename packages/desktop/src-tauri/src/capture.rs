// Screen capture abstraction with multi-monitor support.
//
// macOS: CGDisplayCreateImage via CoreGraphics with sRGB output (color-accurate).
// Windows / other: screenshots crate.
//
// Public API:
//   list_displays() -> Vec<DisplayInfo>
//   capture_screen_at(display_id: u32) -> Option<RgbaFrame>
//     display_id 0 = primary / main display

pub struct RgbaFrame {
    pub data: Vec<u8>,  // RGBA8, row-major, width*height*4 bytes
    pub width: u32,
    pub height: u32,
}

pub struct DisplayInfo {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub is_main: bool,
}

#[cfg(target_os = "macos")]
pub use macos::{list_displays, capture_screen_at};

#[cfg(not(target_os = "macos"))]
pub use fallback::{list_displays, capture_screen_at};

// ── macOS ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::{DisplayInfo, RgbaFrame};
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

    // kCGImageAlphaNoneSkipLast = 5, kCGBitmapByteOrderDefault = 0
    // On little-endian (all modern Macs): gives BGRX in memory.
    // encode.rs swaps bytes 0↔2 to get BGRA for VideoToolbox.
    const BITMAP_INFO: u32 = 5;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateImage(displayID: u32) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
        fn CGColorSpaceRelease(cs: *mut c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize, height: usize,
            bitsPerComponent: usize,
            bytesPerRow: usize,
            space: *mut c_void,
            bitmapInfo: u32,
        ) -> *mut c_void;
        fn CGContextRelease(ctx: *mut c_void);
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
        fn CGGetActiveDisplayList(
            maxDisplays: u32,
            activeDisplays: *mut u32,
            displayCount: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(displayID: u32) -> CGRect;

        // sRGB color space name constant — ensures accurate colors regardless of display profile
        static kCGColorSpaceSRGB: *const c_void;
    }

    pub fn list_displays() -> Vec<DisplayInfo> {
        unsafe {
            let mut ids = [0u32; 32];
            let mut count = 0u32;
            CGGetActiveDisplayList(32, ids.as_mut_ptr(), &mut count);
            let main = CGMainDisplayID();
            (0..count as usize).map(|i| {
                let id = ids[i];
                let bounds = CGDisplayBounds(id);
                DisplayInfo {
                    id,
                    width: bounds.size.width as u32,
                    height: bounds.size.height as u32,
                    is_main: id == main,
                }
            }).collect()
        }
    }

    pub fn capture_screen_at(display_id: u32) -> Option<RgbaFrame> {
        unsafe {
            let display = if display_id == 0 {
                CGMainDisplayID()
            } else {
                display_id
            };

            let cg_image = CGDisplayCreateImage(display);
            if cg_image.is_null() { return None; }

            let w = CGImageGetWidth(cg_image);
            let h = CGImageGetHeight(cg_image);
            if w == 0 || h == 0 {
                CGImageRelease(cg_image);
                return None;
            }

            let mut rgba = vec![0u8; w * h * 4];

            // Use sRGB color space for accurate, consistent colors across all display types
            let cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
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
    use super::{DisplayInfo, RgbaFrame};
    use screenshots::Screen;

    pub fn list_displays() -> Vec<DisplayInfo> {
        Screen::all().unwrap_or_default()
            .into_iter()
            .map(|s| DisplayInfo {
                id: s.display_info.id,
                width: s.display_info.width,
                height: s.display_info.height,
                is_main: s.display_info.is_primary,
            })
            .collect()
    }

    pub fn capture_screen_at(display_id: u32) -> Option<RgbaFrame> {
        let screens = Screen::all().ok()?;
        let screen = if display_id == 0 {
            screens.into_iter().find(|s| s.display_info.is_primary)
                .or_else(|| Screen::all().ok()?.into_iter().next())?
        } else {
            screens.into_iter().find(|s| s.display_info.id == display_id)
                .or_else(|| Screen::all().ok()?.into_iter().find(|s| s.display_info.is_primary))?
        };
        let img = screen.capture().ok()?;
        let w = img.width();
        let h = img.height();
        Some(RgbaFrame { data: img.into_raw(), width: w, height: h })
    }
}
