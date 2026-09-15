import React, { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import RemoteDisplay from '../components/RemoteDisplay'
import {
  Maximize2, Minimize2, ZoomIn, ZoomOut, Expand, Shrink,
  Clipboard, X, Monitor
} from 'lucide-react'

interface Props {
  peerId: string
  role: 'controller' | 'agent'
  onEnd: () => void
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:72.62.66.94:3478',
      'turn:72.62.66.94:3478?transport=tcp',
    ],
    username: 'doomsdesk',
    credential: 'turn123',
  },
]

const DISPLAY_PRESETS = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '1366×768',          width: 1366, height: 768  },
  { label: '720p (1280×720)',   width: 1280, height: 720  },
  { label: '1024×768',          width: 1024, height: 768  },
] as const

type DisplayPreset = typeof DISPLAY_PRESETS[number]
type ConnState = 'connecting' | 'connected' | 'failed' | 'disconnected'

export default function Session({ peerId, role, onEnd }: Props) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [initError, setInitError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [stretch, setStretch] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbarHidden, setToolbarHidden] = useState(false)
  const [remoteScreenSize, setRemoteScreenSize] = useState({ width: 1920, height: 1080 })
  const [displayPreset, setDisplayPreset] = useState<DisplayPreset>(DISPLAY_PRESETS[0])
  const [sessionDuration, setSessionDuration] = useState(0)
  const [diagLines, setDiagLines] = useState<string[]>([])
  const [showDiag, setShowDiag] = useState(true)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const origScreenRef = useRef<{ width: number; height: number } | null>(null)
  const durationRef = useRef<ReturnType<typeof setInterval>>()
  const screenCheckRef = useRef<ReturnType<typeof setInterval>>()
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>()

  function diag(msg: string) {
    const ts = new Date().toISOString().slice(11, 23)
    console.log(`[diag] ${msg}`)
    setDiagLines((prev) => [...prev.slice(-40), `${ts} ${msg}`])
    if (role === 'agent') {
      invoke('forward_agent_log', { msg: `[AGT] ${ts} ${msg}` }).catch(() => {})
    }
  }

  useEffect(() => {
    console.log('[session] mounted — role:', role, 'peerId:', peerId)
    diag(`role=${role} peer=${peerId}`)
    invoke('session_ready')

    initSession().catch((err) => {
      const msg = String(err?.message ?? err)
      console.error('[session] initSession failed:', msg)
      diag(`INIT ERROR: ${msg}`)
      if (role !== 'agent') setInitError(msg)
    })
    durationRef.current = setInterval(() => setSessionDuration((d) => d + 1), 1000)

    const unsubSignal = listen<Record<string, unknown>>('signaling-message', (e) => {
      const t = (e.payload as any).type
      if (t && t !== 'pong' && t !== 'registered') diag(`SIG ← ${t}`)
      handleSignalingMessage(e.payload)
    })
    const unsubEnd = listen<void>('session-ended', () => {
      cleanup()
      onEnd()
    })
    const unsubAgentLog = role === 'controller'
      ? listen<string>('agent-log', (e) => {
          setDiagLines((prev) => [...prev.slice(-40), e.payload])
        })
      : Promise.resolve(() => {})

    return () => {
      unsubSignal.then((f) => f())
      unsubEnd.then((f) => f())
      unsubAgentLog.then((f) => f())
      cleanup()
    }
  }, [])

  async function initSession() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        const t = candidate.type ?? 'unknown'
        diag(`ICE send: ${t} ${candidate.protocol ?? ''} ${candidate.address ?? ''}`)
        invoke('send_signaling', {
          msg: { type: 'ice', targetId: peerId, candidate: candidate.toJSON() },
        })
      } else {
        diag('ICE gathering complete')
      }
    }

    pc.oniceconnectionstatechange = () => { diag(`ICE conn: ${pc.iceConnectionState}`) }
    pc.onicegatheringstatechange = () => { diag(`ICE gather: ${pc.iceGatheringState}`) }

    pc.onconnectionstatechange = () => {
      diag(`RTC: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        setConnState('connected')
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video') {
            const params = sender.getParameters()
            if (!params.encodings.length) params.encodings = [{}]
            params.encodings[0].maxBitrate = 15_000_000
            sender.setParameters(params).catch(() => {})
          }
        }
      } else if (pc.connectionState === 'failed') setConnState('failed')
      else if (pc.connectionState === 'disconnected') setConnState('disconnected')
    }

    if (role === 'agent') {
      await setupAgentSide(pc)
    } else {
      await setupControllerSide(pc)
    }
  }

  async function setupAgentSide(pc: RTCPeerConnection) {
    diag('starting canvas screen capture')

    const canvas = document.createElement('canvas')
    canvas.width = window.screen.width
    canvas.height = window.screen.height
    const ctx = canvas.getContext('2d', { alpha: false })!

    const stream = (canvas as any).captureStream(30) as MediaStream
    streamRef.current = stream

    let transceiver: RTCRtpTransceiver | null = null
    for (const track of stream.getTracks()) {
      if (track.kind === 'video') {
        transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [stream],
          sendEncodings: [{ maxBitrate: 15_000_000, maxFramerate: 30 }],
        })
      } else {
        pc.addTrack(track, stream)
      }
    }

    // Prefer H264: hardware-accelerated via VideoToolbox (macOS) and MediaFoundation (Windows)
    try {
      const caps = RTCRtpSender.getCapabilities?.('video')
      if (transceiver?.setCodecPreferences && caps) {
        const h264 = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264')
        const rest = caps.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264')
        if (h264.length) transceiver.setCodecPreferences([...h264, ...rest])
        diag(`codec pref: H264 x${h264.length} (${h264[0]?.sdpFmtpLine ?? ''})`)
      }
    } catch {}

    diag('canvas stream added to PC')
    setRemoteScreenSize({ width: window.screen.width, height: window.screen.height })
    origScreenRef.current = { width: window.screen.width, height: window.screen.height }

    // RAF paint loop: canvas is updated on the display vsync, decoupled from IPC jitter.
    // createImageBitmap decodes JPEG off the main thread; the RAF callback draws it instantly.
    let latestBitmap: ImageBitmap | null = null
    let frameSeq = 0
    let rafId = 0
    const rafPaint = () => {
      if (latestBitmap) {
        if (canvas.width !== latestBitmap.width || canvas.height !== latestBitmap.height) {
          canvas.width = latestBitmap.width
          canvas.height = latestBitmap.height
        }
        ctx.drawImage(latestBitmap, 0, 0)
        latestBitmap.close()
        latestBitmap = null
      }
      rafId = requestAnimationFrame(rafPaint)
    }
    rafId = requestAnimationFrame(rafPaint)

    const agentCleanups: Array<() => void> = [() => cancelAnimationFrame(rafId)]

    const frameUnsub = await listen<string>('screen-frame', async (e) => {
      const mySeq = ++frameSeq
      try {
        const binaryStr = atob(e.payload)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob)
        if (mySeq < frameSeq) { bitmap.close(); return }
        latestBitmap?.close()
        latestBitmap = bitmap
      } catch {}
    })
    agentCleanups.push(frameUnsub)

    const errUnsub = await listen<string>('screen-frame-error', () => {
      diag('native capture failed — check Screen Recording permission in System Settings')
    })
    agentCleanups.push(errUnsub)

    ;(streamRef as any)._agentCleanup = () => agentCleanups.forEach(f => f())

    await invoke('start_native_capture')
    diag('native capture started')

    const dc = pc.createDataChannel('input')
    setDataChannel(dc)
    dcRef.current = dc

    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'set_display_resolution') {
          const { width, height } = msg as { width: number; height: number }
          diag(`display res → ${width}x${height}`)
          invoke('inject_input', { event: { type: 'set_display_resolution', width, height } })
        } else {
          invoke('inject_input', { event: msg })
        }
      } catch {}
    }

    dc.onopen = () => {
      diag('DC open — sending screen_info')
      dc.send(
        JSON.stringify({ type: 'screen_info', width: window.screen.width, height: window.screen.height })
      )
    }

    let lastW = window.screen.width, lastH = window.screen.height
    screenCheckRef.current = setInterval(() => {
      const w = window.screen.width, h = window.screen.height
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h
        diag(`display changed: ${w}x${h}`)
        const d = dcRef.current
        if (d?.readyState === 'open') {
          d.send(JSON.stringify({ type: 'screen_info', width: w, height: h }))
        }
      }
    }, 2000)

    await new Promise((r) => setTimeout(r, 200))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    diag('offer created, sending')
    invoke('send_signaling', { msg: { type: 'offer', targetId: peerId, sdp: offer.sdp } })
  }

  async function setupControllerSide(pc: RTCPeerConnection) {
    pc.ontrack = (e) => {
      diag(`track rx: ${e.track.kind} muted=${e.track.muted} state=${e.track.readyState}`)
      const stream = e.streams[0]
      if (stream) {
        diag(`stream: id=${stream.id.slice(0, 8)} active=${stream.active}`)
        e.track.onmute = () => diag('track MUTED')
        e.track.onunmute = () => diag('track UNMUTED')
        e.track.onended = () => diag('track ENDED')
        stream.onaddtrack = () => diag('stream addtrack')
        ;(stream as any).oninactive = () => diag('stream INACTIVE')
      }
      setRemoteStream(stream ?? e.streams[0])
    }

    pc.ondatachannel = (e) => {
      const dc = e.channel
      diag('DC received')
      setDataChannel(dc)
      dc.onopen = () => diag('DC open')
      dc.onclose = () => diag('DC closed')
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'screen_info') {
            diag(`screen_info: ${msg.width}x${msg.height}`)
            setRemoteScreenSize({ width: msg.width, height: msg.height })
          }
        } catch {}
      }
    }
  }

  async function handleSignalingMessage(msg: Record<string, unknown>) {
    const pc = pcRef.current
    if (!pc) return

    switch (msg.type) {
      case 'offer':
        if (role === 'controller') {
          diag('got offer → creating answer')
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp as string })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          invoke('send_signaling', {
            msg: { type: 'answer', targetId: peerId, sdp: answer.sdp },
          })
          diag('answer sent')
        }
        break
      case 'answer':
        if (role === 'agent') {
          diag('got answer → setRemoteDesc')
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp as string })
        }
        break
      case 'ice': {
        if (msg.candidate) {
          const c = msg.candidate as RTCIceCandidateInit
          const cand = c.candidate ?? ''
          diag(`ICE rx: ${cand.slice(0, 70) || '(empty!)'}`)
          if (cand) {
            pc.addIceCandidate(c).catch((e) => diag(`addIceCandidate err: ${e}`))
          }
        }
        break
      }
    }
  }

  function cleanup() {
    clearInterval(durationRef.current)
    clearInterval(screenCheckRef.current)
    if (role === 'agent') {
      invoke('stop_native_capture').catch(() => {})
      ;(streamRef.current as any)?._agentCleanup?.()
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    setRemoteStream(null)
  }

  function formatDuration(s: number) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  function handleEnd() {
    invoke('send_signaling', { msg: { type: 'disconnect', targetId: peerId } })
    invoke('close_session') // Rust closes the agent window if it exists
    cleanup()
    onEnd()
  }

  function handleMouseMoveOnContainer() {
    setToolbarHidden(false)
    clearTimeout(hideTimerRef.current)
    if (fullscreen) {
      hideTimerRef.current = setTimeout(() => setToolbarHidden(true), 3000)
    }
  }

  const toggleFullscreen = useCallback(async () => {
    const newFs = !fullscreen
    setFullscreen(newFs)
    try {
      await getCurrentWindow().setFullscreen(newFs)
    } catch {}
    if (newFs) {
      hideTimerRef.current = setTimeout(() => setToolbarHidden(true), 3000)
    } else {
      setToolbarHidden(false)
    }
  }, [fullscreen])

  function sendDisplayResolution(preset: DisplayPreset) {
    setDisplayPreset(preset)
    if (dataChannel?.readyState === 'open') {
      dataChannel.send(
        JSON.stringify({ type: 'set_display_resolution', width: preset.width, height: preset.height })
      )
    }
  }

  // Agent runs in a hidden background window — no UI needed
  if (role === 'agent') {
    return null
  }

  return (
    <div
      className="flex flex-col h-screen bg-black"
      onMouseMove={handleMouseMoveOnContainer}
    >
      {/* Toolbar */}
      <div
        className={`flex items-center gap-2 px-3 py-2 bg-bg/95 backdrop-blur border-b border-surface-border transition-all duration-300 shrink-0 ${
          fullscreen && toolbarHidden ? '-translate-y-full opacity-0 absolute w-full' : ''
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                connState === 'connected'
                  ? 'bg-emerald-400 glow-green'
                  : connState === 'failed'
                  ? 'bg-red-500'
                  : connState === 'disconnected'
                  ? 'bg-yellow-500'
                  : 'bg-slate-500 animate-pulse'
              }`}
            />
            <span className="text-xs text-slate-400 font-mono">{peerId}</span>
          </div>
          <span className="text-xs text-slate-600">·</span>
          <span className="text-xs text-slate-500 font-mono">{formatDuration(sessionDuration)}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-surface text-slate-400">Controller</span>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <ToolBtn onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title="Zoom out">
            <ZoomOut size={14} />
          </ToolBtn>
          <span className="text-xs text-slate-500 w-8 text-center">{Math.round(zoom * 100)}%</span>
          <ToolBtn onClick={() => setZoom((z) => Math.min(3, z + 0.25))} title="Zoom in">
            <ZoomIn size={14} />
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn onClick={() => setStretch((s) => !s)} title="Stretch to fit" active={stretch}>
            {stretch ? <Shrink size={14} /> : <Expand size={14} />}
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          {/* Remote resolution readout + display resolution picker */}
          <span
            className="text-xs text-slate-600 font-mono"
            title="Current remote display resolution"
          >
            {remoteScreenSize.width}×{remoteScreenSize.height}
          </span>
          <select
            value={displayPreset.label}
            onChange={(e) => {
              const preset = DISPLAY_PRESETS.find((p) => p.label === e.target.value)
              if (preset) sendDisplayResolution(preset)
            }}
            title="Set remote display resolution"
            className="text-xs bg-surface text-slate-300 border border-surface-border rounded px-1.5 py-0.5 cursor-pointer ml-1"
          >
            {DISPLAY_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn
            onClick={() =>
              navigator.clipboard
                .readText()
                .then((text) => invoke('inject_input', { event: { type: 'clipboard', text } }))
            }
            title="Paste clipboard"
          >
            <Clipboard size={14} />
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn
            onClick={() => setShowDiag((v) => !v)}
            title="Toggle diagnostics"
            active={showDiag}
          >
            <Monitor size={14} />
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <button
            onClick={handleEnd}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors text-xs font-medium"
          >
            <X size={12} />
            End
          </button>
        </div>
      </div>

      {(initError || connState === 'failed') && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="text-center max-w-sm px-6">
            <p className="text-red-400 text-sm font-medium mb-1">
              {connState === 'failed' ? 'Connection failed' : 'Session failed to start'}
            </p>
            <p className="text-slate-400 text-xs font-mono">
              {initError || 'ICE negotiation failed — the devices could not reach each other'}
            </p>
          </div>
        </div>
      )}

      {showDiag && (
        <div className="absolute bottom-0 right-0 z-20 w-96 max-h-64 bg-black/90 border border-slate-700 rounded-tl-lg overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-2 py-1 border-b border-slate-700">
            <span className="text-xs text-slate-400 font-mono">Diagnostics</span>
            <button
              onClick={() => navigator.clipboard.writeText(diagLines.join('\n'))}
              className="text-xs text-slate-500 hover:text-white px-1"
            >
              Copy
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-0.5">
            {diagLines.length === 0 ? (
              <span className="text-slate-600">Waiting for events…</span>
            ) : (
              diagLines.map((l, i) => (
                <div
                  key={i}
                  className={`${
                    l.includes('ERROR') || l.includes('err') || l.includes('failed')
                      ? 'text-red-400'
                      : l.includes('connected') || l.includes('open') || l.includes('rx')
                      ? 'text-emerald-400'
                      : 'text-slate-400'
                  } leading-tight`}
                >
                  {l}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <RemoteDisplay
        stream={remoteStream}
        dataChannel={dataChannel}
        remoteScreenSize={remoteScreenSize}
        zoom={zoom}
        stretch={stretch}
        connState={connState}
      />
    </div>
  )
}

function ToolBtn({
  onClick,
  children,
  title,
  active = false,
}: {
  onClick: () => void
  children: React.ReactNode
  title: string
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg transition-colors ${
        active ? 'bg-brand/20 text-brand' : 'text-slate-400 hover:text-white hover:bg-surface'
      }`}
    >
      {children}
    </button>
  )
}
