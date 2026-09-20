'use client';
export const dynamic = 'force-dynamic';

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  Suspense,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Monitor,
  Maximize2,
  Minimize2,
  Unplug,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Wifi,
  WifiOff,
  Lock,
  Tv2,
  ClipboardCopy,
  ClipboardPaste,
  Camera,
  Video,
  VideoOff,
  Keyboard,
  Volume2,
  VolumeX,
} from 'lucide-react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_WS_URL ?? 'wss://signal.doomsdesk.io')
    : 'wss://signal.doomsdesk.io';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: ['turn:72.62.66.94:3478', 'turn:72.62.66.94:3478?transport=tcp'],
    username: 'doomsdesk',
    credential: 'turn123',
  },
];

// How long without frames before we show the "frozen" overlay (ms)
const FREEZE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewerState = 'idle' | 'connecting' | 'connected' | 'failed' | 'disconnected';

interface Stats {
  fps: number;
  codec: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(len = 8): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** Find the offset of the first NAL unit payload after Annex-B start code. */
function findNalOffset(data: Uint8Array): number {
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01) return 4;
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01) return 3;
  return 0;
}

/** Detect codec from the first NAL unit byte of an Annex-B frame. */
function detectCodec(data: Uint8Array): 'h264' | 'h265' | null {
  const offset = findNalOffset(data);
  if (offset === 0) return null;
  const nalType = data[offset] & 0x1f;        // H.264 NAL unit type (5 bits)
  const h265NalType = (data[offset] >> 1) & 0x3f; // H.265 NAL unit type (6 bits)
  // H.265 VPS/SPS/PPS: 32,33,34
  if (h265NalType >= 32 && h265NalType <= 34) return 'h265';
  // H.264 IDR / SPS / PPS: 5, 7, 8
  if (nalType === 5 || nalType === 7 || nalType === 8) return 'h264';
  // Heuristic: if high-order bit is 0 it's likely H.264
  if ((data[offset] & 0x80) === 0) return 'h264';
  return 'h265';
}

/** Return true when the Annex-B frame begins with a keyframe NAL unit. */
function isKeyFrame(data: Uint8Array, codec: 'h264' | 'h265'): boolean {
  const offset = findNalOffset(data);
  if (offset === 0) return false;
  if (codec === 'h264') {
    const t = data[offset] & 0x1f;
    return t === 5 || t === 7 || t === 8; // IDR, SPS, PPS
  } else {
    const t = (data[offset] >> 1) & 0x3f;
    // IDR_W_RADL=19, IDR_N_LP=20, CRA=21, VPS=32, SPS=33, PPS=34
    return (t >= 19 && t <= 21) || (t >= 32 && t <= 34);
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function ViewerInner() {
  const searchParams = useSearchParams();

  // Form state
  const [deviceId, setDeviceId] = useState(searchParams.get('id') ?? '');
  const [password, setPassword] = useState(searchParams.get('pw') ?? '');

  // Viewer lifecycle state
  const [viewerState, setViewerState] = useState<ViewerState>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [stats, setStats] = useState<Stats>({ fps: 0, codec: '' });
  const [frozen, setFrozen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [showSendKeys, setShowSendKeys] = useState(false);
  const [remoteMonitors, setRemoteMonitors] = useState<Array<{ id: number; width: number; height: number; isMain: boolean }>>([]);
  const [selectedMonitor, setSelectedMonitor] = useState(0);

  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);

  // WebRTC / WS refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const inputDcRef = useRef<RTCDataChannel | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Internals
  const myIdRef = useRef<string>('');
  const frameCountRef = useRef(0);
  const lastFrameTsRef = useRef(0);
  const freezeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectedCodecRef = useRef<string>('');
  const codecTypeRef = useRef<'h264' | 'h265' | null>(null);
  const remoteScreenRef = useRef<{ w: number; h: number }>({ w: 1920, h: 1080 });
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ondatachannel = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (decoderRef.current) {
      try { decoderRef.current.close(); } catch { /* already closed */ }
      decoderRef.current = null;
    }
    if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current);
    if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    inputDcRef.current = null;
    frameCountRef.current = 0;
    lastFrameTsRef.current = 0;
    detectedCodecRef.current = '';
    codecTypeRef.current = null;
    remoteScreenRef.current = { w: 1920, h: 1080 };
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
    setFrozen(false);
    setStats({ fps: 0, codec: '' });
    setRemoteMonitors([]);
    setSelectedMonitor(0);
    setShowSendKeys(false);
    // Stop any active recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    setIsRecording(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Screenshot & Recording
  // ---------------------------------------------------------------------------

  function takeScreenshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `doomsdesk-${deviceId}-${Date.now()}.png`;
    a.click();
  }

  function toggleRecording() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }

    const stream = canvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const mr = new MediaRecorder(stream, { mimeType });
    recordingChunksRef.current = [];

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `doomsdesk-${deviceId}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      recordingChunksRef.current = [];
      setIsRecording(false);
    };

    mr.start(1000);
    mediaRecorderRef.current = mr;
    setIsRecording(true);
  }

  // ---------------------------------------------------------------------------
  // FPS tracking
  // ---------------------------------------------------------------------------

  function startFpsTracker() {
    if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    fpsIntervalRef.current = setInterval(() => {
      const fps = frameCountRef.current;
      frameCountRef.current = 0;
      setStats((prev) => ({ ...prev, fps }));
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Freeze detection
  // ---------------------------------------------------------------------------

  function resetFreezeTimer() {
    setFrozen(false);
    if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current);
    freezeTimerRef.current = setTimeout(() => setFrozen(true), FREEZE_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------
  // VideoDecoder
  // ---------------------------------------------------------------------------

  function initDecoder(codec: 'h264' | 'h265') {
    if (decoderRef.current) {
      try { decoderRef.current.close(); } catch { /* ok */ }
    }

    const codecStr = codec === 'h264' ? 'avc1.640033' : 'hvc1.1.6.L153.B0';
    detectedCodecRef.current = codec === 'h264' ? 'H.264' : 'H.265';
    codecTypeRef.current = codec;
    setStats((prev) => ({ ...prev, codec: detectedCodecRef.current }));

    const decoder = new VideoDecoder({
      output(frame) {
        frameCountRef.current += 1;
        lastFrameTsRef.current = Date.now();
        resetFreezeTimer();

        const canvas = canvasRef.current;
        if (!canvas) { frame.close(); return; }
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
        frame.close();
      },
      error(e) {
        console.error('[Decoder]', e);
      },
    });

    decoder.configure({
      codec: codecStr,
      optimizeForLatency: true,
    });

    decoderRef.current = decoder;
  }

  // ---------------------------------------------------------------------------
  // Frame handler (from DataChannel)
  // ---------------------------------------------------------------------------

  function handleFrame(data: ArrayBuffer) {
    const bytes = new Uint8Array(data);

    // Auto-detect codec on first frame
    if (!detectedCodecRef.current) {
      const detected = detectCodec(bytes);
      if (detected) initDecoder(detected);
    }

    const codec = codecTypeRef.current;
    if (!decoderRef.current || !codec) return;

    try {
      const key = isKeyFrame(bytes, codec);
      const chunk = new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: performance.now() * 1000,
        data: bytes,
      });
      decoderRef.current.decode(chunk);
    } catch (e) {
      console.warn('[Frame decode error]', e);
    }
  }

  // ---------------------------------------------------------------------------
  // DataChannel setup
  // ---------------------------------------------------------------------------

  function setupDataChannel(dc: RTCDataChannel) {
    if (dc.label === 'input') {
      inputDcRef.current = dc;
      dc.onopen = () => console.log('[DC:input] open');
      dc.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'screen_info' && typeof msg.width === 'number' && typeof msg.height === 'number') {
            remoteScreenRef.current = { w: msg.width, h: msg.height };
          } else if (msg.type === 'monitor_list' && Array.isArray(msg.monitors)) {
            setRemoteMonitors(msg.monitors as Array<{ id: number; width: number; height: number; isMain: boolean }>);
          } else if (msg.type === 'agent_clipboard' && typeof msg.text === 'string') {
            navigator.clipboard.writeText(msg.text).catch(() => {});
          }
        } catch { /* ignore */ }
      };
    }

    if (dc.label === 'frames') {
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        console.log('[DC:frames] open');
        setViewerState('connected');
        startFpsTracker();
        resetFreezeTimer();
      };
      dc.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          handleFrame(ev.data);
        } else if (typeof ev.data === 'string') {
          // JSON stats / chat from agent
          try {
            const msg = JSON.parse(ev.data as string);
            if (msg.type === 'stats') {
              setStats((prev) => ({
                fps: prev.fps,
                codec: msg.codec ?? prev.codec,
              }));
            }
          } catch { /* ignore */ }
        }
      };
    }
  }

  // ---------------------------------------------------------------------------
  // WebRTC setup
  // ---------------------------------------------------------------------------

  function createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.ontrack = (ev) => {
      if (ev.track.kind === 'audio') {
        if (!audioElRef.current) {
          const el = document.createElement('audio');
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
          audioElRef.current = el;
        }
        audioElRef.current.srcObject = ev.streams[0];
        audioElRef.current.muted = !audioEnabled;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'ice',
            targetId: deviceId,
            candidate: ev.candidate,
          })
        );
      }
    };

    pc.ondatachannel = (ev) => {
      setupDataChannel(ev.channel);
    };

    pc.onconnectionstatechange = () => {
      console.log('[PC] state:', pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setViewerState('disconnected');
        cleanup();
      }
    };

    pcRef.current = pc;
    return pc;
  }

  // ---------------------------------------------------------------------------
  // WebSocket signaling
  // ---------------------------------------------------------------------------

  function connect() {
    if (!deviceId.trim() || !password.trim()) return;

    cleanup();
    setViewerState('connecting');
    setStatusMsg('Connecting to signaling server…');
    setErrorMsg('');

    const myId = `web-${randomId()}`;
    myIdRef.current = myId;

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      setViewerState('failed');
      setErrorMsg('Could not open WebSocket. Check your network.');
      return;
    }

    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setStatusMsg('Registering controller…');
      ws.send(
        JSON.stringify({
          type: 'register',
          deviceId: myId,
          randomPassword: '',
          permanentPassword: null,
        })
      );
    };

    ws.onmessage = async (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'registered': {
          setStatusMsg(`Connecting to device ${deviceId}…`);
          ws.send(
            JSON.stringify({
              type: 'connect',
              targetId: deviceId,
              password: password,
            })
          );
          break;
        }

        case 'connect_result': {
          if (msg.approved) {
            setStatusMsg('Waiting for WebRTC offer…');
            createPeerConnection();
          } else {
            setViewerState('failed');
            setErrorMsg(
              typeof msg.reason === 'string' ? msg.reason : 'Connection rejected. Check device ID and password.'
            );
          }
          break;
        }

        case 'offer': {
          const pc = pcRef.current ?? createPeerConnection();
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp as string });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(
              JSON.stringify({
                type: 'answer',
                targetId: (msg.sourceId ?? msg.from ?? deviceId) as string,
                sdp: answer.sdp,
              })
            );
            setStatusMsg('Establishing encrypted tunnel…');
          } catch (e) {
            console.error('[SDP]', e);
            setViewerState('failed');
            setErrorMsg('WebRTC negotiation failed.');
          }
          break;
        }

        case 'ice': {
          const pc = pcRef.current;
          if (pc && msg.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
            } catch { /* race — ok */ }
          }
          break;
        }

        case 'peer_disconnected': {
          setViewerState('disconnected');
          setErrorMsg('The remote device disconnected.');
          cleanup();
          break;
        }

        case 'error': {
          setViewerState('failed');
          setErrorMsg(typeof msg.message === 'string' ? msg.message : 'Signaling error.');
          cleanup();
          break;
        }

        default:
          break;
      }
    };

    ws.onerror = () => {
      setViewerState('failed');
      setErrorMsg('WebSocket error. Server may be unreachable.');
    };

    ws.onclose = () => {
      if (viewerState === 'connected') {
        setViewerState('disconnected');
        setErrorMsg('Connection to signaling server lost.');
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  function disconnect() {
    cleanup();
    setViewerState('idle');
    setStatusMsg('');
    setErrorMsg('');
  }

  // ---------------------------------------------------------------------------
  // Input forwarding
  // ---------------------------------------------------------------------------

  function sendInput(payload: Record<string, unknown>) {
    const dc = inputDcRef.current;
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify(payload));
    }
  }

  function toRemoteCoords(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const { w, h } = remoteScreenRef.current;
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * h),
    };
  }

  function remoteButton(b: number): string {
    if (b === 2) return 'right';
    if (b === 1) return 'middle';
    if (b === 3) return 'back';
    if (b === 4) return 'forward';
    return 'left';
  }

  function onCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!canvasRef.current) return;
    sendInput({ type: 'mousemove', ...toRemoteCoords(e) });
  }

  function onCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!canvasRef.current) return;
    sendInput({ type: 'mousedown', button: remoteButton(e.button), ...toRemoteCoords(e) });
  }

  function onCanvasMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!canvasRef.current) return;
    sendInput({ type: 'mouseup', button: remoteButton(e.button), ...toRemoteCoords(e) });
  }

  function onCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    sendInput({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  }

  // Touch event handlers — map to mouse events for mobile/tablet support
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);

  function toRemoteTouchCoords(touch: React.Touch, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = remoteScreenRef.current;
    return {
      x: Math.round(((touch.clientX - rect.left) / rect.width) * w),
      y: Math.round(((touch.clientY - rect.top) / rect.height) * h),
    };
  }

  function onCanvasTouchStart(e: React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = toRemoteTouchCoords(e.touches[0], canvas);
    lastTouchRef.current = coords;
    sendInput({ type: 'mousemove', ...coords });
    sendInput({ type: 'mousedown', button: 'left', ...coords });
  }

  function onCanvasTouchMove(e: React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = toRemoteTouchCoords(e.touches[0], canvas);
    lastTouchRef.current = coords;
    sendInput({ type: 'mousemove', ...coords });
  }

  function onCanvasTouchEnd(e: React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const last = lastTouchRef.current;
    if (!last) return;
    sendInput({ type: 'mouseup', button: 'left', ...last });
    lastTouchRef.current = null;
  }

  function onCanvasKeyDown(e: ReactKeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    // Ctrl+V or Cmd+V: push local clipboard to remote
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      navigator.clipboard.readText().then((text) => {
        if (text) sendInput({ type: 'clipboard', text });
      }).catch(() => {});
      return;
    }
    sendInput({ type: 'keydown', key: e.key, code: e.code, modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey } });
  }

  function onCanvasKeyUp(e: ReactKeyboardEvent<HTMLCanvasElement>) {
    e.preventDefault();
    sendInput({ type: 'keyup', key: e.key, code: e.code, modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey } });
  }

  function pushClipboard() {
    navigator.clipboard.readText().then((text) => {
      if (text) sendInput({ type: 'clipboard', text });
    }).catch(() => {});
  }

  function pullClipboard() {
    sendInput({ type: 'request_clipboard' });
  }

  function sendKeysCombo(combo: string) {
    sendInput({ type: 'send_keys', combo });
    setShowSendKeys(false);
  }

  function switchMonitor(displayId: number) {
    setSelectedMonitor(displayId);
    sendInput({ type: 'switch_monitor', displayId });
  }

  function toggleAudio() {
    const el = audioElRef.current;
    if (el) el.muted = audioEnabled; // audioEnabled is current value before toggle
    setAudioEnabled((prev) => !prev);
  }

  // ---------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // Auto-focus canvas when session becomes connected so keyboard events work immediately
  useEffect(() => {
    if (viewerState === 'connected') {
      setTimeout(() => canvasRef.current?.focus(), 100);
    }
  }, [viewerState]);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => { cleanup(); };
  }, [cleanup]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    connect();
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const isIdle = viewerState === 'idle';
  const isConnecting = viewerState === 'connecting';
  const isConnected = viewerState === 'connected';
  const isFailed = viewerState === 'failed';
  const isDisconnected = viewerState === 'disconnected';

  return (
    // NOTE: This page is in the (dashboard) group which enforces auth via layout.tsx.
    // If you want unauthenticated access, move this page to a top-level public route.
    <div className="space-y-0 animate-fade-in h-full">
      {/* Page header — only shown when not connected */}
      {!isConnected && (
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
              <Tv2 size={18} className="text-accent" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-dark-text">Remote Viewer</h1>
              <p className="text-sm text-dark-muted">Control any device from your browser — no install required</p>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* IDLE: Connect Form                                                  */}
      {/* ------------------------------------------------------------------ */}
      {isIdle && (
        <div className="flex justify-center pt-4">
          <div className="w-full max-w-md">
            <div className="bg-dark-surface border border-dark-border rounded-2xl p-8 shadow-2xl">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
                  <Monitor size={20} className="text-accent" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-dark-text">Connect to Device</h2>
                  <p className="text-xs text-dark-muted">Enter the device credentials to start a session</p>
                </div>
              </div>

              <form onSubmit={handleFormSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
                    Device ID
                  </label>
                  <input
                    type="text"
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    placeholder="e.g. ABCD-1234"
                    required
                    autoFocus
                    className="input-base font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Session or permanent password"
                      required
                      className="input-base pr-9"
                    />
                    <Lock size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-muted/50 pointer-events-none" />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!deviceId.trim() || !password.trim()}
                  className="btn-primary w-full flex items-center justify-center gap-2 mt-2"
                >
                  <Wifi size={15} />
                  Connect
                </button>
              </form>

              <p className="text-center text-xs text-dark-muted/50 mt-5">
                End-to-end encrypted via WebRTC. Password never leaves your browser.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* CONNECTING: Spinner + status                                        */}
      {/* ------------------------------------------------------------------ */}
      {isConnecting && (
        <div className="flex flex-col items-center justify-center py-28 gap-5">
          <div className="relative">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Monitor size={28} className="text-accent" />
            </div>
            <Loader2
              size={60}
              className="text-accent/40 animate-spin absolute -inset-1"
              strokeWidth={1}
            />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-dark-text">{statusMsg}</p>
            <p className="text-xs text-dark-muted mt-1">Connecting to <span className="font-mono text-accent">{deviceId}</span></p>
          </div>
          <button
            onClick={disconnect}
            className="btn-secondary flex items-center gap-2 text-xs mt-2"
          >
            <WifiOff size={13} />
            Cancel
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* CONNECTED: Canvas + Toolbar                                         */}
      {/* ------------------------------------------------------------------ */}
      {isConnected && (
        <div
          ref={containerRef}
          className="fixed inset-0 flex flex-col bg-black z-40"
        >
          {/* Toolbar */}
          <div className={clsx(
            'flex-shrink-0 h-10 flex items-center justify-between px-4 gap-4',
            'bg-dark-surface/95 border-b border-dark-border/60 backdrop-blur-sm',
          )}>
            {/* Left: device + codec */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="text-xs font-medium text-dark-text font-mono">{deviceId}</span>
              </div>
              {stats.codec && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                  {stats.codec}
                </span>
              )}
            </div>

            {/* Center: FPS */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-dark-muted">FPS</span>
              <span className={clsx(
                'text-xs font-bold font-mono tabular-nums',
                stats.fps >= 30 ? 'text-success' : stats.fps >= 15 ? 'text-warning' : 'text-danger'
              )}>
                {stats.fps}
              </span>
            </div>

            {/* Right: controls */}
            <div className="flex items-center gap-1">
              {/* Monitor selector */}
              {remoteMonitors.length > 1 && (
                <select
                  value={selectedMonitor}
                  onChange={(e) => switchMonitor(Number(e.target.value))}
                  title="Switch monitor"
                  className="h-7 px-1.5 rounded-lg text-[11px] bg-dark-surface border border-dark-border text-dark-text hover:border-accent/50 transition-colors cursor-pointer"
                >
                  {remoteMonitors.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.isMain ? 'Main' : `Display ${m.id}`} ({m.width}×{m.height})
                    </option>
                  ))}
                </select>
              )}

              <button
                onClick={pushClipboard}
                title="Push local clipboard → remote (Ctrl+V)"
                className="p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-colors"
              >
                <ClipboardPaste size={14} />
              </button>
              <button
                onClick={pullClipboard}
                title="Pull remote clipboard → local"
                className="p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-colors"
              >
                <ClipboardCopy size={14} />
              </button>

              {/* Send Keys dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowSendKeys((v) => !v)}
                  title="Send key combos"
                  className={clsx(
                    'p-1.5 rounded-lg transition-colors',
                    showSendKeys
                      ? 'text-accent bg-accent/15'
                      : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
                  )}
                >
                  <Keyboard size={14} />
                </button>
                {showSendKeys && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowSendKeys(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-dark-surface border border-dark-border rounded-xl shadow-2xl py-1 overflow-hidden">
                      {[
                        { label: 'Ctrl+Alt+Del', combo: 'ctrl_alt_del' },
                        { label: 'Lock Screen', combo: 'lock' },
                        { label: 'Start / Spotlight', combo: 'spotlight_or_start' },
                        { label: 'Show Desktop', combo: 'show_desktop' },
                        { label: 'Task Manager', combo: 'task_mgr' },
                      ].map(({ label, combo }) => (
                        <button
                          key={combo}
                          onClick={() => sendKeysCombo(combo)}
                          className="w-full text-left px-3 py-1.5 text-xs text-dark-text hover:bg-dark-border/40 transition-colors"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Audio toggle */}
              <button
                onClick={toggleAudio}
                title={audioEnabled ? 'Mute remote audio' : 'Unmute remote audio'}
                className={clsx(
                  'p-1.5 rounded-lg transition-colors',
                  audioEnabled
                    ? 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
                    : 'text-warning bg-warning/10 hover:bg-warning/20'
                )}
              >
                {audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>

              <button
                onClick={takeScreenshot}
                title="Take screenshot"
                className="p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-colors"
              >
                <Camera size={14} />
              </button>
              <button
                onClick={toggleRecording}
                title={isRecording ? 'Stop recording' : 'Start recording'}
                className={clsx(
                  'p-1.5 rounded-lg transition-colors',
                  isRecording
                    ? 'text-danger bg-danger/15 hover:bg-danger/25'
                    : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
                )}
              >
                {isRecording ? <VideoOff size={14} /> : <Video size={14} />}
              </button>
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                className="p-1.5 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 transition-colors"
              >
                {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                onClick={disconnect}
                title="Disconnect"
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-danger hover:bg-danger/10 border border-transparent hover:border-danger/20 transition-all"
              >
                <Unplug size={13} />
                Disconnect
              </button>
            </div>
          </div>

          {/* Canvas area */}
          <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full object-contain cursor-crosshair outline-none"
              tabIndex={0}
              onMouseMove={onCanvasMouseMove}
              onMouseDown={onCanvasMouseDown}
              onMouseUp={onCanvasMouseUp}
              onWheel={onCanvasWheel}
              onKeyDown={onCanvasKeyDown}
              onKeyUp={onCanvasKeyUp}
              onTouchStart={onCanvasTouchStart}
              onTouchMove={onCanvasTouchMove}
              onTouchEnd={onCanvasTouchEnd}
              onContextMenu={(e) => e.preventDefault()}
            />

            {/* Frozen overlay */}
            {frozen && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm animate-fade-in">
                <AlertTriangle size={36} className="text-warning" />
                <div className="text-center">
                  <p className="text-sm font-semibold text-dark-text">Display frozen</p>
                  <p className="text-xs text-dark-muted mt-1">No frames received for {FREEZE_TIMEOUT_MS / 1000}s</p>
                </div>
                <button
                  onClick={() => { disconnect(); setTimeout(connect, 100); }}
                  className="btn-secondary flex items-center gap-2 text-xs"
                >
                  <RefreshCw size={13} />
                  Reconnect
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* FAILED / DISCONNECTED: Error + retry                               */}
      {/* ------------------------------------------------------------------ */}
      {(isFailed || isDisconnected) && (
        <div className="flex justify-center pt-4">
          <div className="w-full max-w-md">
            <div className="bg-dark-surface border border-dark-border rounded-2xl p-8 shadow-2xl text-center">
              <div className="w-14 h-14 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center mx-auto mb-4">
                {isFailed ? (
                  <AlertTriangle size={24} className="text-danger" />
                ) : (
                  <WifiOff size={24} className="text-danger" />
                )}
              </div>

              <h2 className="text-base font-bold text-dark-text mb-1">
                {isFailed ? 'Connection Failed' : 'Disconnected'}
              </h2>
              <p className="text-sm text-dark-muted mb-1">
                {errorMsg || (isDisconnected ? 'The session ended.' : 'Something went wrong.')}
              </p>
              <p className="text-xs text-dark-muted/60 font-mono mb-6">{deviceId}</p>

              <div className="flex flex-col gap-2">
                <button
                  onClick={connect}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  <RefreshCw size={14} />
                  Try Again
                </button>
                <button
                  onClick={() => { setViewerState('idle'); setErrorMsg(''); }}
                  className="btn-secondary w-full"
                >
                  Change Device
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-dark-muted">Loading…</div>}>
      <ViewerInner />
    </Suspense>
  );
}
