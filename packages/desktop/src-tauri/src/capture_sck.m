// ScreenCaptureKit persistent stream — push-based, GPU compositor timing.
// Exposes a plain C API so Rust can call it via extern "C".
//
// Requires: macOS 12.3+, screen recording permission.
// Falls back gracefully (returns NULL) — caller falls back to CGDisplayCreateImage.

#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

// ---- Shared frame buffer ----
typedef struct { uint8_t *data; uint32_t w, h, stride; } SckBuf;
static NSLock     *gLock            = nil;
static SckBuf      gLatest          = {0};
static SCStream   *gStream          = nil;
static uint32_t    gStreamDisp      = UINT32_MAX;
static _Atomic int gReady           = 0;  // 1 once first frame arrives
static NSDate     *gLastStartAttempt = nil; // throttle restart attempts

// ---- Delegate ----
@interface SckDelegate : NSObject <SCStreamOutput, SCStreamDelegate>
@end
@implementation SckDelegate
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)err {
    gStream = nil; gStreamDisp = UINT32_MAX; gReady = 0;
}
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sb
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    CVImageBufferRef ib = CMSampleBufferGetImageBuffer(sb);
    if (!ib) return;
    CVPixelBufferLockBaseAddress(ib, kCVPixelBufferLock_ReadOnly);
    uint32_t w   = (uint32_t)CVPixelBufferGetWidth(ib);
    uint32_t h   = (uint32_t)CVPixelBufferGetHeight(ib);
    uint32_t bpr = (uint32_t)CVPixelBufferGetBytesPerRow(ib);
    void    *src = CVPixelBufferGetBaseAddress(ib);
    size_t   sz  = (size_t)bpr * h;
    uint8_t *buf = malloc(sz);
    if (buf) memcpy(buf, src, sz);
    CVPixelBufferUnlockBaseAddress(ib, kCVPixelBufferLock_ReadOnly);
    if (!buf) return;
    [gLock lock];
    if (gLatest.data) free(gLatest.data);
    gLatest = (SckBuf){ buf, w, h, bpr };
    [gLock unlock];
    gReady = 1;
}
@end

static SckDelegate *gDelegate = nil;

static SCDisplay *_find_display(SCShareableContent *c, uint32_t display_id) {
    for (SCDisplay *d in c.displays) {
        if (display_id == 0 && CGDisplayIsMain(d.displayID)) return d;
        if (display_id != 0 && d.displayID == display_id) return d;
    }
    return c.displays.firstObject;
}

// Returns 1 on success, 0 on failure. Blocks up to 3 s.
static int _start_stream(uint32_t display_id) {
    if (!gLock) gLock = [NSLock new];
    if (!gDelegate) gDelegate = [SckDelegate new];

    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block int ok = 0;

    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *c, NSError *err) {
        if (err || !c) { dispatch_semaphore_signal(sema); return; }

        SCDisplay *disp = _find_display(c, display_id);
        if (!disp) { dispatch_semaphore_signal(sema); return; }

        // Downscale to max 1920 wide at compositor level (GPU, zero CPU cost)
        NSInteger sw = disp.width, sh = disp.height;
        if (sw > 1920) { sh = sh * 1920 / sw; sw = 1920; }

        SCContentFilter *f = [[SCContentFilter alloc]
            initWithDisplay:disp
            excludingApplications:@[]
            exceptingWindows:@[]];

        SCStreamConfiguration *cfg = [SCStreamConfiguration new];
        cfg.width            = (size_t)sw;
        cfg.height           = (size_t)sh;
        cfg.pixelFormat      = kCVPixelFormatType_32BGRA;
        cfg.minimumFrameInterval = CMTimeMake(1, 60);
        cfg.showsCursor      = NO;
        cfg.capturesAudio    = NO;

        SCStream *s = [[SCStream alloc] initWithFilter:f configuration:cfg delegate:gDelegate];
        dispatch_queue_t q = dispatch_queue_create("sck.output", DISPATCH_QUEUE_SERIAL);
        NSError *addErr = nil;
        [s addStreamOutput:gDelegate type:SCStreamOutputTypeScreen sampleHandlerQueue:q error:&addErr];
        if (addErr) { dispatch_semaphore_signal(sema); return; }

        [s startCaptureWithCompletionHandler:^(NSError *e) {
            if (!e) { gStream = s; gStreamDisp = display_id; ok = 1; }
            dispatch_semaphore_signal(sema);
        }];
    }];

    dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
    return ok;
}

// ---- C API ----

// Reset the start-attempt cooldown (call before an explicit capture restart).
void sck_reset(void) {
    gLastStartAttempt = nil;
}

// Ensure stream is running for display_id. 0 = primary.
// Throttles restart attempts to once every 5 s to prevent spamming the macOS
// screen-recording permission TCC dialog when permission is denied or the stream
// failed — without this the 30 fps capture loop retries on every single frame.
int sck_ensure(uint32_t display_id) {
    @autoreleasepool {
        if (gStream && gStreamDisp == display_id) return 1;
        // Throttle: don't retry faster than once every 5 seconds after a failure.
        if (gLastStartAttempt &&
            [[NSDate date] timeIntervalSinceDate:gLastStartAttempt] < 5.0) {
            return 0;
        }
        gLastStartAttempt = [NSDate date];
        // Stop existing stream if display changed
        if (gStream) {
            [gStream stopCaptureWithCompletionHandler:^(NSError *e){}];
            gStream = nil; gStreamDisp = UINT32_MAX; gReady = 0;
        }
        return _start_stream(display_id);
    }
}

// Returns heap copy of latest frame. Caller must call sck_free_frame().
// Returns NULL if no frame has arrived yet.
uint8_t *sck_get_frame(uint32_t *ow, uint32_t *oh, uint32_t *ostride) {
    if (!gReady) return NULL;
    [gLock lock];
    if (!gLatest.data) { [gLock unlock]; return NULL; }
    size_t sz = (size_t)gLatest.stride * gLatest.h;
    uint8_t *copy = malloc(sz);
    if (copy) {
        memcpy(copy, gLatest.data, sz);
        *ow = gLatest.w; *oh = gLatest.h; *ostride = gLatest.stride;
    }
    [gLock unlock];
    return copy;
}

void sck_free_frame(uint8_t *p) { if (p) free(p); }

void sck_stop(void) {
    @autoreleasepool {
        gLastStartAttempt = nil; // allow immediate restart after explicit stop
        if (gStream) {
            [gStream stopCaptureWithCompletionHandler:^(NSError *e){}];
            gStream = nil; gStreamDisp = UINT32_MAX;
        }
        if (gLock) {
            [gLock lock];
            if (gLatest.data) { free(gLatest.data); gLatest.data = NULL; }
            [gLock unlock];
        }
        gReady = 0;
    }
}
