// H.264 encoder — macOS VideoToolbox (hardware) + Windows openh264 (software).
// Output is Annex B byte stream, ready for WebCodecs VideoDecoder.
#![allow(non_upper_case_globals, non_snake_case, dead_code, clashing_extern_declarations)]

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub is_key: bool,
}

pub struct H264Encoder {
    inner: platform::Encoder,
    width: u32,
    height: u32,
}

impl H264Encoder {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        platform::Encoder::new(width, height).map(|inner| Self { inner, width, height })
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// `rgba` must be exactly `width * height * 4` bytes.
    pub fn encode(&mut self, rgba: &[u8], pts_ms: u64) -> Option<EncodedFrame> {
        self.inner.encode(rgba, self.width, self.height, pts_ms)
    }

    pub fn set_bitrate(&mut self, bps: u32) {
        self.inner.set_bitrate(bps);
    }
}

// ── macOS VideoToolbox ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::EncodedFrame;
    use std::ffi::c_void;
    use std::sync::mpsc;

    type CFStringRef       = *const c_void;
    type CFBooleanRef      = *const c_void;
    type CFArrayRef        = *const c_void;
    type CFDictionaryRef   = *const c_void;
    type CFNumberRef       = *const c_void;
    type CFTypeRef         = *const c_void;
    type CFIndex           = isize;
    type OSStatus          = i32;

    type CMSampleBufferRef      = *mut c_void;
    type CMFormatDescriptionRef = *mut c_void;
    type CMBlockBufferRef       = *mut c_void;
    type CVPixelBufferRef       = *mut c_void;
    type VTCompressionSessionRef = *mut c_void;
    type VTEncodeInfoFlags      = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTime { value: i64, timescale: i32, flags: u32, epoch: i64 }

    fn cm_time_ms(ms: u64) -> CMTime {
        CMTime { value: ms as i64, timescale: 1000, flags: 1, epoch: 0 }
    }

    const CM_TIME_INDEFINITE: CMTime = CMTime { value: 0, timescale: 0, flags: 0x11, epoch: 0 };

    const kCVPixelFormatType_32BGRA: u32 = 0x42475241;
    const kCFNumberSInt32Type: i32 = 3;
    const kCMVideoCodecType_H264: u32 = 0x61766331;

    type CVPixelBufferReleaseBytesCallback =
        unsafe extern "C" fn(releaseRefCon: *mut c_void, baseAddress: *const c_void);

    type VTCompressionOutputCallback = unsafe extern "C" fn(
        outputCallbackRefCon: *mut c_void,
        sourceFrameRefCon: *mut c_void,
        status: OSStatus,
        infoFlags: VTEncodeInfoFlags,
        sampleBuffer: CMSampleBufferRef,
    );

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFNumberCreate(
            alloc: *const c_void, theType: i32, valuePtr: *const c_void,
        ) -> CFNumberRef;
        fn CFRelease(cf: *const c_void);
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) -> *const c_void;
        static kCFBooleanTrue: CFBooleanRef;
        static kCFBooleanFalse: CFBooleanRef;
    }

    #[link(name = "CoreVideo", kind = "framework")]
    extern "C" {
        fn CVPixelBufferCreateWithBytes(
            allocator: *const c_void,
            width: usize,
            height: usize,
            pixelFormatType: u32,
            baseAddress: *mut c_void,
            bytesPerRow: usize,
            releaseCallback: Option<CVPixelBufferReleaseBytesCallback>,
            releaseRefCon: *mut c_void,
            pixelBufferAttributes: CFDictionaryRef,
            pixelBufferOut: *mut CVPixelBufferRef,
        ) -> i32;
    }

    #[link(name = "CoreMedia", kind = "framework")]
    extern "C" {
        fn CMSampleBufferGetFormatDescription(buf: CMSampleBufferRef) -> CMFormatDescriptionRef;
        fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            videoDesc: CMFormatDescriptionRef,
            parameterSetIndex: usize,
            parameterSetPointerOut: *mut *const u8,
            parameterSetSizeOut: *mut usize,
            parameterSetCountOut: *mut usize,
            NALUnitHeaderLengthOut: *mut i32,
        ) -> OSStatus;
        fn CMSampleBufferGetDataBuffer(buf: CMSampleBufferRef) -> CMBlockBufferRef;
        fn CMBlockBufferGetDataPointer(
            theBuffer: CMBlockBufferRef,
            offset: usize,
            lengthAtOffsetOut: *mut usize,
            totalLengthOut: *mut usize,
            dataPointerOut: *mut *mut u8,
        ) -> OSStatus;
        fn CMSampleBufferGetSampleAttachmentsArray(
            sbuf: CMSampleBufferRef,
            createIfNecessary: bool,
        ) -> CFArrayRef;
        static kCMSampleAttachmentKey_NotSync: CFStringRef;
    }

    #[link(name = "VideoToolbox", kind = "framework")]
    extern "C" {
        fn VTCompressionSessionCreate(
            allocator: *const c_void,
            width: i32,
            height: i32,
            codecType: u32,
            encoderSpecification: *const c_void,
            sourceImageBufferAttributes: CFDictionaryRef,
            compressedDataAllocator: *const c_void,
            outputCallback: Option<VTCompressionOutputCallback>,
            outputCallbackRefCon: *mut c_void,
            compressionSessionOut: *mut VTCompressionSessionRef,
        ) -> OSStatus;
        fn VTSessionSetProperty(
            session: VTCompressionSessionRef,
            propertyKey: CFStringRef,
            propertyValue: CFTypeRef,
        ) -> OSStatus;
        fn VTCompressionSessionPrepareToEncodeFrames(
            session: VTCompressionSessionRef,
        ) -> OSStatus;
        fn VTCompressionSessionEncodeFrame(
            session: VTCompressionSessionRef,
            imageBuffer: CVPixelBufferRef,
            presentationTimeStamp: CMTime,
            duration: CMTime,
            frameProperties: CFDictionaryRef,
            sourceFrameRefCon: *mut c_void,
            infoFlagsOut: *mut VTEncodeInfoFlags,
        ) -> OSStatus;
        fn VTCompressionSessionCompleteFrames(
            session: VTCompressionSessionRef,
            completeUntilPresentationTimeStamp: CMTime,
        ) -> OSStatus;
        fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
        static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
        static kVTCompressionPropertyKey_RealTime: CFStringRef;
        static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
        static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFStringRef;
        static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
        static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
        static kVTProfileLevel_H264_High_AutoLevel: CFStringRef;
    }

    fn cf_i32(n: i32) -> CFNumberRef {
        unsafe {
            CFNumberCreate(
                std::ptr::null(),
                kCFNumberSInt32Type,
                &n as *const i32 as *const c_void,
            )
        }
    }

    // ── Callback context ─────────────────────────────────────────────────────

    struct CallbackCtx { tx: mpsc::SyncSender<EncodedFrame> }

    unsafe extern "C" fn compress_cb(
        refcon: *mut c_void,
        _src_refcon: *mut c_void,
        status: OSStatus,
        _info: VTEncodeInfoFlags,
        sample_buf: CMSampleBufferRef,
    ) {
        if status != 0 || sample_buf.is_null() { return; }
        let ctx = &*(refcon as *mut CallbackCtx);

        let is_key = {
            let arr = CMSampleBufferGetSampleAttachmentsArray(sample_buf, false);
            if arr.is_null() || CFArrayGetCount(arr) == 0 {
                true
            } else {
                let dict = CFArrayGetValueAtIndex(arr, 0) as CFDictionaryRef;
                CFDictionaryGetValue(
                    dict,
                    kCMSampleAttachmentKey_NotSync as *const c_void,
                ).is_null()
            }
        };

        let mut out = Vec::<u8>::new();

        // Key frames: prepend SPS then PPS so the decoder can self-initialise
        if is_key {
            let desc = CMSampleBufferGetFormatDescription(sample_buf);
            if !desc.is_null() {
                for idx in 0..2usize {
                    let mut ptr: *const u8 = std::ptr::null();
                    let mut size: usize    = 0;
                    let mut count: usize   = 0;
                    let mut hdr_len: i32   = 4;
                    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                        desc, idx, &mut ptr, &mut size, &mut count, &mut hdr_len,
                    ) == 0 && !ptr.is_null() {
                        out.extend_from_slice(&[0, 0, 0, 1]);
                        out.extend_from_slice(std::slice::from_raw_parts(ptr, size));
                    }
                }
            }
        }

        // AVCC 4-byte length prefix → Annex B 00 00 00 01 start code
        let bb = CMSampleBufferGetDataBuffer(sample_buf);
        if !bb.is_null() {
            let mut _lat: usize    = 0;
            let mut total: usize   = 0;
            let mut dptr: *mut u8  = std::ptr::null_mut();
            if CMBlockBufferGetDataPointer(bb, 0, &mut _lat, &mut total, &mut dptr) == 0
                && !dptr.is_null()
            {
                let data = std::slice::from_raw_parts(dptr, total);
                let mut off = 0usize;
                while off + 4 <= total {
                    let nal_len = u32::from_be_bytes([
                        data[off], data[off+1], data[off+2], data[off+3],
                    ]) as usize;
                    off += 4;
                    if off + nal_len > total { break; }
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    out.extend_from_slice(&data[off..off + nal_len]);
                    off += nal_len;
                }
            }
        }

        if !out.is_empty() {
            let _ = ctx.tx.try_send(EncodedFrame { data: out, is_key });
        }
    }

    unsafe extern "C" fn pixel_buf_release(
        release_ref: *mut c_void, _base: *const c_void,
    ) {
        drop(Box::from_raw(release_ref as *mut Vec<u8>));
    }

    // ── Encoder ──────────────────────────────────────────────────────────────

    pub struct Encoder {
        session: VTCompressionSessionRef,
        _ctx: Box<CallbackCtx>,
        rx: mpsc::Receiver<EncodedFrame>,
    }

    unsafe impl Send for Encoder {}

    impl Encoder {
        pub fn new(width: u32, height: u32) -> Option<Self> {
            let (tx, rx) = mpsc::sync_channel::<EncodedFrame>(4);
            let ctx = Box::new(CallbackCtx { tx });
            let ctx_ptr = &*ctx as *const CallbackCtx as *mut c_void;

            let mut session: VTCompressionSessionRef = std::ptr::null_mut();
            let st = unsafe {
                VTCompressionSessionCreate(
                    std::ptr::null(),
                    width as i32, height as i32,
                    kCMVideoCodecType_H264,
                    std::ptr::null(), std::ptr::null(), std::ptr::null(),
                    Some(compress_cb),
                    ctx_ptr,
                    &mut session,
                )
            };
            if st != 0 || session.is_null() { return None; }

            unsafe {
                // Scale initial bitrate to resolution; floor 2 Mbps, cap 8 Mbps
                let bps = ((width as i64 * height as i64 * 4_000_000) / (1920 * 1080))
                    .clamp(2_000_000, 8_000_000) as i32;

                let v = cf_i32(bps);
                VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, v as CFTypeRef);
                CFRelease(v as *const c_void);

                VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef);
                VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef);

                // IDR every 15 frames (0.5s at 30fps) — fast recovery from packet loss
                let v = cf_i32(15);
                VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, v as CFTypeRef);
                CFRelease(v as *const c_void);

                // Tell VT the expected frame rate for better rate control
                let v = cf_i32(30);
                VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, v as CFTypeRef);
                CFRelease(v as *const c_void);

                VTSessionSetProperty(
                    session,
                    kVTCompressionPropertyKey_ProfileLevel,
                    kVTProfileLevel_H264_High_AutoLevel as CFTypeRef,
                );

                VTCompressionSessionPrepareToEncodeFrames(session);
            }

            Some(Self { session, _ctx: ctx, rx })
        }

        pub fn encode(&mut self, rgba: &[u8], width: u32, height: u32, pts_ms: u64) -> Option<EncodedFrame> {
            // RGBA → BGRA swap (VideoToolbox kCVPixelFormatType_32BGRA)
            let mut bgra = rgba.to_vec();
            for p in bgra.chunks_exact_mut(4) { p.swap(0, 2); }

            let w = width as usize;
            let h = height as usize;
            let bytes_per_row = w * 4;

            let bgra_box = Box::new(bgra);
            let base_addr = bgra_box.as_ptr() as *mut c_void;
            let release_ref = Box::into_raw(bgra_box) as *mut c_void;

            let mut pixel_buf: CVPixelBufferRef = std::ptr::null_mut();
            let cv_st = unsafe {
                CVPixelBufferCreateWithBytes(
                    std::ptr::null(),
                    w, h,
                    kCVPixelFormatType_32BGRA,
                    base_addr,
                    bytes_per_row,
                    Some(pixel_buf_release),
                    release_ref,
                    std::ptr::null(),
                    &mut pixel_buf,
                )
            };
            if cv_st != 0 || pixel_buf.is_null() {
                unsafe { drop(Box::from_raw(release_ref as *mut Vec<u8>)); }
                return None;
            }

            let pts = cm_time_ms(pts_ms);
            let dur = cm_time_ms(33);

            let enc_st = unsafe {
                VTCompressionSessionEncodeFrame(
                    self.session,
                    pixel_buf,
                    pts, dur,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            unsafe { CFRelease(pixel_buf as *const c_void); }

            if enc_st != 0 { return None; }

            unsafe { VTCompressionSessionCompleteFrames(self.session, CM_TIME_INDEFINITE); }

            self.rx.try_recv().ok()
        }

        pub fn set_bitrate(&mut self, bps: u32) {
            let v = cf_i32(bps.clamp(2_000_000, 8_000_000) as i32);
            unsafe {
                VTSessionSetProperty(self.session, kVTCompressionPropertyKey_AverageBitRate, v as *const c_void);
                CFRelease(v as *const c_void);
            }
        }
    }

    impl Drop for Encoder {
        fn drop(&mut self) {
            unsafe {
                VTCompressionSessionInvalidate(self.session);
                CFRelease(self.session as *const c_void);
            }
        }
    }
}

// ── Windows openh264 ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::EncodedFrame;
    use openh264::OpenH264API;
    use openh264::encoder::{Encoder as OH264Encoder, EncoderConfig, FrameType};
    use openh264::formats::YUVBuffer;

    pub struct Encoder {
        enc: OH264Encoder,
        width: u32,
        height: u32,
        current_bps: u32,
    }

    fn make_encoder(width: u32, height: u32, bps: u32) -> Option<OH264Encoder> {
        let api = OpenH264API::from_source();
        let cfg = EncoderConfig::new(width, height)
            .set_bitrate_bps(bps)
            .max_frame_rate(30.0);
        OH264Encoder::with_config(api, cfg).ok()
    }

    impl Encoder {
        pub fn new(width: u32, height: u32) -> Option<Self> {
            let bps = ((width as u64 * height as u64 * 4_000_000) / (1920 * 1080))
                .clamp(2_000_000, 8_000_000) as u32;
            let enc = make_encoder(width, height, bps)?;
            Some(Self { enc, width, height, current_bps: bps })
        }

        pub fn encode(&mut self, rgba: &[u8], width: u32, height: u32, _pts_ms: u64) -> Option<EncodedFrame> {
            let rgb: Vec<u8> = rgba
                .chunks_exact(4)
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();

            let yuv = YUVBuffer::with_rgb(width as usize, height as usize, &rgb);
            let bs = self.enc.encode(&yuv).ok()?;

            let is_key = matches!(bs.frame_type(), FrameType::IDR | FrameType::I);
            let mut out = Vec::<u8>::new();
            bs.write_vec(&mut out);

            if out.is_empty() { None } else { Some(EncodedFrame { data: out, is_key }) }
        }

        pub fn set_bitrate(&mut self, bps: u32) {
            let clamped = bps.clamp(2_000_000, 8_000_000);
            if clamped == self.current_bps { return; }
            if let Some(enc) = make_encoder(self.width, self.height, clamped) {
                self.enc = enc;
                self.current_bps = clamped;
            }
        }
    }
}

// ── Fallback (Linux / other) ──────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::EncodedFrame;

    pub struct Encoder;

    impl Encoder {
        pub fn new(_w: u32, _h: u32) -> Option<Self> { None }
        pub fn encode(&mut self, _r: &[u8], _w: u32, _h: u32, _pts: u64) -> Option<EncodedFrame> { None }
        pub fn set_bitrate(&mut self, _bps: u32) {}
    }
}
