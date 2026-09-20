// Screen capture abstraction with multi-monitor support.
//
// macOS: CGDisplayCreateImage via CoreGraphics with sRGB output (color-accurate).
// Windows / other: screenshots crate.
//
// Public API:
//   list_displays() -> Vec<DisplayInfo>
//   capture_screen_at(display_id: u32) -> Option<RgbaFrame>
//     display_id 0 = primary / main display
//
//   FrameDiffer — tile-based change detection
//     FrameDiffer::new() -> FrameDiffer
//     FrameDiffer::diff(&mut self, rgba: &[u8], width: u32, height: u32) -> DiffResult
//     FrameDiffer::force_reset(&mut self)

pub struct RgbaFrame {
    pub data: Vec<u8>,  // RGBA8 (or BGRX on macOS), row-major, width*height*4 bytes
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

// ── Tile-based frame differ ───────────────────────────────────────────────────
//
// The frame is divided into 64×64 pixel tiles. Each tile is hashed by sampling
// 16 pixels (every 16th pixel across a 4×4 grid within the tile) and XOR-mixing
// them with the tile's grid position. This is intentionally lightweight — the
// goal is fast change detection, not cryptographic strength.
//
// changed_ratio = fraction of tiles whose hash differs from the previous frame.
// is_static      = true when no tile changed at all.
//
// The caller should force a keyframe whenever changed_ratio > 0.5 (major scene
// change) and skip encoding entirely when is_static = true.

const TILE_SIZE: u32 = 64;

/// Result of comparing a frame against the previous one.
pub struct DiffResult {
    /// Fraction of tiles that changed, in [0.0, 1.0].
    pub changed_ratio: f32,
    /// True when no tile changed (screen is visually static).
    pub is_static: bool,
}

/// Tile-based perceptual frame differ. Maintains hash state across calls.
pub struct FrameDiffer {
    prev_hashes: Vec<u64>,
    frame_w: u32,
    frame_h: u32,
}

impl FrameDiffer {
    pub fn new() -> Self {
        Self {
            prev_hashes: Vec::new(),
            frame_w: 0,
            frame_h: 0,
        }
    }

    /// Clear hash state, forcing the next diff to treat all tiles as changed.
    pub fn force_reset(&mut self) {
        self.prev_hashes.clear();
        self.frame_w = 0;
        self.frame_h = 0;
    }

    /// Compare `rgba` (width*height*4 bytes, any RGBA/BGRX channel order — we
    /// only care about byte values, not colour accuracy) against the previous
    /// frame. Updates internal state for the next call.
    pub fn diff(&mut self, rgba: &[u8], width: u32, height: u32) -> DiffResult {
        // Resolution change → treat every tile as new
        if width != self.frame_w || height != self.frame_h {
            self.prev_hashes.clear();
            self.frame_w = width;
            self.frame_h = height;
        }

        let cols = (width  + TILE_SIZE - 1) / TILE_SIZE;
        let rows = (height + TILE_SIZE - 1) / TILE_SIZE;
        let total_tiles = (cols * rows) as usize;

        // Ensure the hash buffer matches the tile count
        if self.prev_hashes.len() != total_tiles {
            self.prev_hashes.clear();
            self.prev_hashes.resize(total_tiles, u64::MAX); // MAX → guaranteed diff on first frame
        }

        let bytes_per_row = width as usize * 4;
        let mut changed = 0usize;

        for row in 0..rows {
            for col in 0..cols {
                let tile_idx = (row * cols + col) as usize;
                let hash = hash_tile(rgba, bytes_per_row, width, height, col, row);

                if hash != self.prev_hashes[tile_idx] {
                    self.prev_hashes[tile_idx] = hash;
                    changed += 1;
                }
            }
        }

        let changed_ratio = changed as f32 / total_tiles as f32;
        DiffResult {
            changed_ratio,
            is_static: changed == 0,
        }
    }
}

/// Compute a fast hash for the 64×64 tile at grid position (tile_col, tile_row).
///
/// Samples every 16th pixel across a 4-wide × 4-tall grid inside the tile
/// (16 samples total), XOR-mixed with the tile's position for uniqueness.
/// The BGRX→RGBA channel swap is intentionally skipped — we only need
/// consistency between frames for the same display, not colour accuracy.
#[inline]
fn hash_tile(
    rgba: &[u8],
    bytes_per_row: usize,
    frame_w: u32,
    frame_h: u32,
    tile_col: u32,
    tile_row: u32,
) -> u64 {
    // Pixel-space extents of this tile (may be clipped at frame edges)
    let px_x0 = tile_col * TILE_SIZE;
    let py_y0 = tile_row  * TILE_SIZE;
    let px_x1 = (px_x0 + TILE_SIZE).min(frame_w);
    let py_y1 = (py_y0 + TILE_SIZE).min(frame_h);

    let tile_w = (px_x1 - px_x0) as usize;
    let tile_h = (py_y1 - py_y0) as usize;

    // Sample 4 evenly-spaced columns and 4 rows within the tile.
    // For very small edge tiles (< 4 px in either dimension) we step by 1.
    let step_x = (tile_w  / 4).max(1);
    let step_y = (tile_h / 4).max(1);

    // Seed with tile position so two identical tiles at different locations
    // hash differently, preventing false "no-change" when content shifts.
    let mut h: u64 = (tile_col as u64)
        .wrapping_mul(2654435761)
        ^ (tile_row as u64).wrapping_mul(2246822519);

    let y0 = py_y0 as usize;
    let x0 = px_x0 as usize;

    let mut sy = 0usize;
    while sy < tile_h {
        let row_off = (y0 + sy) * bytes_per_row;
        let mut sx = 0usize;
        while sx < tile_w {
            let byte_off = row_off + (x0 + sx) * 4;
            if byte_off + 3 < rgba.len() {
                // Combine all four channels into a single u32 then mix into h
                let pixel = u32::from_le_bytes([
                    rgba[byte_off],
                    rgba[byte_off + 1],
                    rgba[byte_off + 2],
                    rgba[byte_off + 3],
                ]) as u64;
                h ^= pixel.wrapping_mul(6364136223846793005)
                         .wrapping_add(1442695040888963407);
                h = h.rotate_left(17);
            }
            sx += step_x;
        }
        sy += step_y;
    }

    h
}

// ── macOS ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::{DisplayInfo, RgbaFrame};
    use std::ffi::c_void;

    // ── ScreenCaptureKit C shim (capture_sck.m) ──────────────────────────────
    extern "C" {
        fn sck_ensure(display_id: u32) -> i32;
        fn sck_get_frame(ow: *mut u32, oh: *mut u32, ostride: *mut u32) -> *mut u8;
        fn sck_free_frame(p: *mut u8);
    }

    // ── CoreGraphics fallback ─────────────────────────────────────────────────
    #[repr(C)] #[derive(Clone, Copy)] struct CGPoint { x: f64, y: f64 }
    #[repr(C)] #[derive(Clone, Copy)] struct CGSize  { width: f64, height: f64 }
    #[repr(C)] #[derive(Clone, Copy)] struct CGRect  { origin: CGPoint, size: CGSize }
    const BITMAP_INFO: u32 = 5; // kCGImageAlphaNoneSkipLast, little-endian → BGRX

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateImage(displayID: u32) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
        fn CGColorSpaceRelease(cs: *mut c_void);
        fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize,
            bpc: usize, bpr: usize, space: *mut c_void, bi: u32) -> *mut c_void;
        fn CGContextRelease(ctx: *mut c_void);
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
        fn CGGetActiveDisplayList(max: u32, ids: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(displayID: u32) -> CGRect;
        static kCGColorSpaceSRGB: *const c_void;
    }

    fn cg_capture(display_id: u32) -> Option<RgbaFrame> {
        unsafe {
            let display = if display_id == 0 { CGMainDisplayID() } else { display_id };
            let img = CGDisplayCreateImage(display);
            if img.is_null() { return None; }
            let w = CGImageGetWidth(img);
            let h = CGImageGetHeight(img);
            if w == 0 || h == 0 { CGImageRelease(img); return None; }
            let mut data = vec![0u8; w * h * 4];
            let cs  = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            let ctx = CGBitmapContextCreate(data.as_mut_ptr() as *mut c_void,
                w, h, 8, w * 4, cs, BITMAP_INFO);
            CGColorSpaceRelease(cs);
            if ctx.is_null() { CGImageRelease(img); return None; }
            CGContextDrawImage(ctx, CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize { width: w as f64, height: h as f64 },
            }, img);
            CGContextRelease(ctx);
            CGImageRelease(img);
            Some(RgbaFrame { data, width: w as u32, height: h as u32 })
        }
    }

    pub fn list_displays() -> Vec<DisplayInfo> {
        unsafe {
            let mut ids = [0u32; 32];
            let mut count = 0u32;
            CGGetActiveDisplayList(32, ids.as_mut_ptr(), &mut count);
            let main = CGMainDisplayID();
            (0..count as usize).map(|i| {
                let id = ids[i];
                let b = CGDisplayBounds(id);
                DisplayInfo { id, width: b.size.width as u32, height: b.size.height as u32,
                    is_main: id == main }
            }).collect()
        }
    }

    pub fn capture_screen_at(display_id: u32) -> Option<RgbaFrame> {
        unsafe {
            // Ensure SCK stream is running (init on first call, reinit on display change).
            // sck_ensure blocks up to 3 s on first call; subsequent calls return instantly.
            if sck_ensure(display_id) == 0 {
                return cg_capture(display_id); // macOS < 12.3 or permission denied
            }

            let mut w = 0u32; let mut h = 0u32; let mut stride = 0u32;
            let ptr = sck_get_frame(&mut w, &mut h, &mut stride);

            if ptr.is_null() {
                // SCK stream is warming up — use legacy path for this one frame
                return cg_capture(display_id);
            }

            let stride = stride as usize;
            let w_usize = w as usize;
            let h_usize = h as usize;

            // Strip row padding if any (stride may be > w*4 on Retina)
            let data = if stride == w_usize * 4 {
                std::slice::from_raw_parts(ptr, stride * h_usize).to_vec()
            } else {
                let mut packed = Vec::with_capacity(w_usize * h_usize * 4);
                for row in 0..h_usize {
                    packed.extend_from_slice(
                        std::slice::from_raw_parts(ptr.add(row * stride), w_usize * 4));
                }
                packed
            };
            sck_free_frame(ptr);
            Some(RgbaFrame { data, width: w, height: h })
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
