// Video encoder — macOS VideoToolbox (hardware HEVC/H.264) + Windows openh264 (software H.264).
// Output is Annex B byte stream, ready for WebCodecs VideoDecoder.
//
// On macOS 11+ the encoder attempts HEVC (H.265) first for ~40% better compression at equal
// quality. If the VT session creation fails (older hardware or OS) it automatically falls back
// to H.264 High profile. The public API is unchanged: H264Encoder struct + codec_name() method.
#![allow(non_upper_case_globals, non_snake_case, dead_code, clashing_extern_declarations)]

/// Which codec is actually driving the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecType {
    H264,
    H265,
}

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub is_key: bool,
}

/// Public encoder handle. Named H264Encoder for API compatibility; may internally use HEVC.
pub struct H264Encoder {
    inner: platform::Encoder,
    width: u32,
    height: u32,
}

impl H264Encoder {
    /// Create an encoder. On macOS tries HEVC first, falls back to H.264.
    pub fn new(width: u32, height: u32) -> Option<Self> {
        platform::Encoder::new(width, height).map(|inner| Self { inner, width, height })
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Returns "h265" when running HEVC, "h264" otherwise.
    pub fn codec_name(&self) -> &'static str {
        self.inner.codec_name()
    }

    /// `rgba` must be exactly `width * height * 4` bytes (RGBA or BGRX channel order — see
    /// platform notes in encode.rs for the byte-swap details).
    /// When `force_keyframe` is true the encoder is asked to produce an IDR frame immediately.
    pub fn encode(&mut self, rgba: &[u8], pts_ms: u64, force_keyframe: bool) -> Option<EncodedFrame> {
        self.inner.encode(rgba, self.width, self.height, pts_ms, force_keyframe)
    }

    pub fn set_bitrate(&mut self, bps: u32) {
        self.inner.set_bitrate(bps);
    }
}

// ── macOS VideoToolbox ────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::{CodecType, EncodedFrame};
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

    type CMSampleBufferRef       = *mut c_void;
    type CMFormatDescriptionRef  = *mut c_void;
    type CMBlockBufferRef        = *mut c_void;
    type CVPixelBufferRef        = *mut c_void;
    type VTCompressionSessionRef = *mut c_void;
    type VTEncodeInfoFlags       = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTime { value: i64, timescale: i32, flags: u32, epoch: i64 }

    fn cm_time_ms(ms: u64) -> CMTime {
        CMTime { value: ms as i64, timescale: 1000, flags: 1, epoch: 0 }
    }

    const CM_TIME_INDEFINITE: CMTime = CMTime { value: 0, timescale: 0, flags: 0x11, epoch: 0 };

    const kCVPixelFormatType_32BGRA: u32 = 0x42475241;
    const kCFNumberSInt32Type: i32 = 3;

    // H.264 codec FourCC: 'avc1'
    const kCMVideoCodecType_H264: u32 = 0x61766331;
    // HEVC codec FourCC: 'hvc1'
    const kCMVideoCodecType_HEVC: u32 = 0x68766331;

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
        fn CVPixelBufferRelease(pixelBuffer: CVPixelBufferRef);
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
        fn CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
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
        static kVTProfileLevel_HEVC_Main_AutoLevel: CFStringRef;
        static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;
        static kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: CFStringRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            numValues: CFIndex,
            keyCallBacks: *const c_void,
            valueCallBacks: *const c_void,
        ) -> CFDictionaryRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
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

    fn cf_f64(n: f64) -> CFNumberRef {
        const kCFNumberFloat64Type: i32 = 14;
        unsafe {
            CFNumberCreate(
                std::ptr::null(),
                kCFNumberFloat64Type,
                &n as *const f64 as *const c_void,
            )
        }
    }

    // ── Callback context ─────────────────────────────────────────────────────

    /// Shared between the VT callback and the Encoder. The codec field tells the
    /// callback whether to extract H.264 (SPS+PPS = 2 sets) or HEVC (VPS+SPS+PPS = 3 sets)
    /// parameter sets on keyframes.
    struct CallbackCtx {
        tx: mpsc::SyncSender<EncodedFrame>,
        codec: CodecType,
    }

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

        // Key frames: prepend parameter sets so the decoder can self-initialise.
        // H.264 → SPS + PPS (2 sets); HEVC → VPS + SPS + PPS (3 sets).
        if is_key {
            let desc = CMSampleBufferGetFormatDescription(sample_buf);
            if !desc.is_null() {
                let param_count = match ctx.codec {
                    CodecType::H264 => 2usize,
                    CodecType::H265 => 3usize,
                };
                for idx in 0..param_count {
                    let mut ptr: *const u8 = std::ptr::null();
                    let mut size: usize    = 0;
                    let mut count: usize   = 0;
                    let mut hdr_len: i32   = 4;
                    let st = match ctx.codec {
                        CodecType::H264 => CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                            desc, idx, &mut ptr, &mut size, &mut count, &mut hdr_len,
                        ),
                        CodecType::H265 => CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                            desc, idx, &mut ptr, &mut size, &mut count, &mut hdr_len,
                        ),
                    };
                    if st == 0 && !ptr.is_null() && size > 0 {
                        out.extend_from_slice(&[0, 0, 0, 1]);
                        out.extend_from_slice(std::slice::from_raw_parts(ptr, size));
                    }
                }
            }
        }

        // AVCC / HVCC 4-byte length prefix → Annex B 00 00 00 01 start code
        let bb = CMSampleBufferGetDataBuffer(sample_buf);
        if !bb.is_null() {
            let mut _lat: usize   = 0;
            let mut total: usize  = 0;
            let mut dptr: *mut u8 = std::ptr::null_mut();
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
                    if nal_len == 0 { continue; }
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

    // ── Session factory ───────────────────────────────────────────────────────

    /// Attempt to create a VT session with the given codec type.
    /// Returns (session, codec_type) on success.
    fn try_create_session(
        width: u32,
        height: u32,
        codec: u32,
        ctx_ptr: *mut c_void,
    ) -> Option<VTCompressionSessionRef> {
        let mut session: VTCompressionSessionRef = std::ptr::null_mut();
        let st = unsafe {
            VTCompressionSessionCreate(
                std::ptr::null(),
                width as i32, height as i32,
                codec,
                std::ptr::null(), std::ptr::null(), std::ptr::null(),
                Some(compress_cb),
                ctx_ptr,
                &mut session,
            )
        };
        if st == 0 && !session.is_null() { Some(session) } else { None }
    }

    /// Configure common VT session properties after creation.
    unsafe fn configure_session(
        session: VTCompressionSessionRef,
        codec: CodecType,
        width: u32,
        height: u32,
    ) {
        // Scale initial bitrate to resolution; floor 3 Mbps, cap 50 Mbps for LAN quality
        let bps = ((width as i64 * height as i64 * 8_000_000) / (1920 * 1080))
            .clamp(3_000_000, 50_000_000) as i32;

        let v = cf_i32(bps);
        VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, v as CFTypeRef);
        CFRelease(v as *const c_void);

        VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef);
        VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef);

        // IDR every 90 frames (3 s at 30 fps).
        // Shorter intervals (15 frames) cause IDR spam during video playback
        // which eats the entire bitrate budget — P-frames get almost nothing.
        // Recovery from packet loss is handled by the controller requesting
        // a keyframe on decoder error.
        let v = cf_i32(90);
        VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, v as CFTypeRef);
        CFRelease(v as *const c_void);

        let v = cf_i32(60);
        VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, v as CFTypeRef);
        CFRelease(v as *const c_void);

        // Belt-and-suspenders: also set a 3 s time-based keyframe cap so FPS
        // changes don't accidentally produce more IDRs than intended.
        let v = cf_f64(3.0);
        VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, v as CFTypeRef);
        CFRelease(v as *const c_void);

        let profile = match codec {
            CodecType::H264 => kVTProfileLevel_H264_High_AutoLevel,
            CodecType::H265 => kVTProfileLevel_HEVC_Main_AutoLevel,
        };
        VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel, profile as CFTypeRef);

        VTCompressionSessionPrepareToEncodeFrames(session);
    }

    // ── Encoder ──────────────────────────────────────────────────────────────

    pub struct Encoder {
        session: VTCompressionSessionRef,
        _ctx: Box<CallbackCtx>,
        rx: mpsc::Receiver<EncodedFrame>,
        codec: CodecType,
    }

    unsafe impl Send for Encoder {}

    impl Encoder {
        pub fn new(width: u32, height: u32) -> Option<Self> {
            let (tx, rx) = mpsc::sync_channel::<EncodedFrame>(4);

            // The CallbackCtx starts as H265; we may patch it to H264 below.
            let mut ctx = Box::new(CallbackCtx { tx, codec: CodecType::H265 });
            let ctx_ptr = &mut *ctx as *mut CallbackCtx as *mut c_void;

            // Try HEVC first; fall back to H.264 if the session cannot be created
            // (e.g., unsupported hardware or OS older than macOS 11).
            let (session, codec) =
                if let Some(s) = try_create_session(width, height, kCMVideoCodecType_HEVC, ctx_ptr) {
                    (s, CodecType::H265)
                } else if let Some(s) = try_create_session(width, height, kCMVideoCodecType_H264, ctx_ptr) {
                    ctx.codec = CodecType::H264;
                    (s, CodecType::H264)
                } else {
                    return None;
                };

            unsafe { configure_session(session, codec, width, height); }

            Some(Self { session, _ctx: ctx, rx, codec })
        }

        pub fn codec_name(&self) -> &'static str {
            match self.codec {
                CodecType::H264 => "h264",
                CodecType::H265 => "h265",
            }
        }

        pub fn encode(&mut self, rgba: &[u8], width: u32, height: u32, pts_ms: u64, force_keyframe: bool) -> Option<EncodedFrame> {
            // macOS captures BGRX [B,G,R,X]. VideoToolbox kCVPixelFormatType_32BGRA
            // expects [B,G,R,A] — channel order is identical, just set alpha=255.
            let mut bgra = rgba.to_vec();
            for p in bgra.chunks_exact_mut(4) { p[3] = 255; }

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

            // Build a frame-properties dictionary requesting a keyframe when asked.
            // kVTEncodeFrameOptionKey_ForceKeyFrame = kCFBooleanTrue forces an IDR.
            let frame_props: CFDictionaryRef = if force_keyframe {
                unsafe {
                    let key = kVTEncodeFrameOptionKey_ForceKeyFrame as *const c_void;
                    let val = kCFBooleanTrue as *const c_void;
                    CFDictionaryCreate(
                        std::ptr::null(),
                        &key as *const *const c_void,
                        &val as *const *const c_void,
                        1,
                        &kCFTypeDictionaryKeyCallBacks as *const c_void,
                        &kCFTypeDictionaryValueCallBacks as *const c_void,
                    )
                }
            } else {
                std::ptr::null()
            };

            let enc_st = unsafe {
                VTCompressionSessionEncodeFrame(
                    self.session,
                    pixel_buf,
                    pts, dur,
                    frame_props,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };

            // Release the frame-properties dictionary if we created one.
            if !frame_props.is_null() {
                unsafe { CFRelease(frame_props as *const c_void); }
            }

            unsafe { CVPixelBufferRelease(pixel_buf); }

            if enc_st != 0 { return None; }

            unsafe { VTCompressionSessionCompleteFrames(self.session, CM_TIME_INDEFINITE); }

            self.rx.try_recv().ok()
        }

        pub fn set_bitrate(&mut self, bps: u32) {
            let v = cf_i32(bps.clamp(2_000_000, 50_000_000) as i32);
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
    use super::{CodecType, EncodedFrame};
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
            let bps = ((width as u64 * height as u64 * 8_000_000) / (1920 * 1080))
                .clamp(3_000_000, 50_000_000) as u32;
            let enc = make_encoder(width, height, bps)?;
            Some(Self { enc, width, height, current_bps: bps })
        }

        pub fn codec_name(&self) -> &'static str { "h264" }

        pub fn encode(&mut self, rgba: &[u8], width: u32, height: u32, _pts_ms: u64, force_keyframe: bool) -> Option<EncodedFrame> {
            // Signal the openh264 encoder to produce an IDR frame on the next encode call.
            if force_keyframe {
                unsafe { self.enc.raw_api().force_intra_frame(true); }
            }

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
            let clamped = bps.clamp(2_000_000, 50_000_000);
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
        pub fn codec_name(&self) -> &'static str { "h264" }
        pub fn encode(&mut self, _r: &[u8], _w: u32, _h: u32, _pts: u64, _force_keyframe: bool) -> Option<EncodedFrame> { None }
        pub fn set_bitrate(&mut self, _bps: u32) {}
    }
}
