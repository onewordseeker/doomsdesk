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
  const [framesChannel, setFramesChannel] = useState<RTCDataChannel | null>(null)
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
  const dcRef = useRef<RTCDataChannel | null>(null)
  const agentCleanupRef = useRef<(() => void) | null>(null)
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
      if (pc.connectionState === 'connected') setConnState('connected')
      else if (pc.connectionState === 'failed') setConnState('failed')
      else if (pc.connectionState === 'disconnected') setConnState('disconnected')
    }

    if (role === 'agent') {
      await setupAgentSide(pc)
    } else {
      await setupControllerSide(pc)
    }
  }

  async function setupAgentSide(pc: RTCPeerConnection) {
    diag('setting up agent data channels')

    const framesDc = pc.createDataChannel('frames')
    const inputDc = pc.createDataChannel('input')
    setDataChannel(inputDc)
    dcRef.current = inputDc

    const agentCleanups: Array<() => void> = []

    // Quality + capture state — declared early so all handlers can reference them
    let framesSent = 0
    let framesSkipped = 0
    let currentQuality = 60
    let stableWindows = 0
    let consecutiveErrors = 0
    let captureRestarting = false

    function doRestartCapture(reason: string) {
      if (captureRestarting) return
      captureRestarting = true
      diag(`${reason} — resetting quality, restarting capture`)
      currentQuality = 60
      consecutiveErrors = 0
      invoke('set_capture_quality', { quality: 60 }).catch(() => {})
      invoke('stop_native_capture').catch(() => {})
      // 500ms lets Windows display settle after a resolution change before we try to capture
      setTimeout(() => {
        invoke('start_native_capture').catch(() => {})
        captureRestarting = false
      }, 500)
    }

    inputDc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'set_display_resolution') {
          const { width, height } = msg as { width: number; height: number }
          diag(`display res → ${width}x${height}`)
          invoke('inject_input', { event: { type: 'set_display_resolution', width, height } })
        } else if (msg.type === 'restart_capture') {
          doRestartCapture('restart_capture from controller')
        } else {
          invoke('inject_input', { event: msg })
        }
      } catch {}
    }

    inputDc.onopen = () => {
      diag('input DC open — starting input worker, sending screen_info')
      invoke('start_input_worker').catch(() => {})
      inputDc.send(
        JSON.stringify({ type: 'screen_info', width: window.screen.width, height: window.screen.height })
      )
    }

    framesDc.onopen = () => diag('frames DC open')
    framesDc.onclose = () => diag('frames DC closed')

    setRemoteScreenSize({ width: window.screen.width, height: window.screen.height })
    origScreenRef.current = { width: window.screen.width, height: window.screen.height }

    // Auto-quality: adapt JPEG quality based on send/skip/error ratio every 3s
    const qualityInterval = setInterval(() => {
      const total = framesSent + framesSkipped
      if (total === 0) return
      const skipRate = framesSkipped / total
      diag(`sent=${framesSent} skip=${framesSkipped} skip%=${Math.round(skipRate * 100)} q=${currentQuality}`)
      if (skipRate > 0 && currentQuality > 40) {
        // Drop faster on high skip rates
        const drop = skipRate > 0.8 ? 25 : skipRate > 0.5 ? 15 : 10
        currentQuality = Math.max(40, currentQuality - drop)
        invoke('set_capture_quality', { quality: currentQuality }).catch(() => {})
        stableWindows = 0
        diag(`quality ↓ ${currentQuality}`)
      } else if (skipRate === 0) {
        stableWindows++
        if (stableWindows >= 2 && currentQuality < 85) {
          currentQuality = Math.min(85, currentQuality + 5)
          invoke('set_capture_quality', { quality: currentQuality }).catch(() => {})
          stableWindows = 0
          diag(`quality ↑ ${currentQuality}`)
        }
      } else {
        stableWindows = 0
      }
      framesSent = 0
      framesSkipped = 0
    }, 3000)
    agentCleanups.push(() => clearInterval(qualityInterval))

    // Forward Rust JPEG frames as raw base64 strings — zero decode cost on agent side
    const frameUnsub = await listen<string>('screen-frame', (e) => {
      consecutiveErrors = 0 // successful frame resets the error streak
      if (framesDc.readyState !== 'open') return
      if (framesDc.bufferedAmount > 524288) { framesSkipped++; return }
      try {
        framesDc.send(e.payload)
        framesSent++
      } catch { framesSkipped++ }
    })
    agentCleanups.push(frameUnsub)

    // Count Rust capture errors as skipped frames so quality adaptation still works
    // when the OS screen is unavailable (e.g. right after a resolution change on Windows).
    // After 30 consecutive errors (~1s) restart capture automatically.
    const errUnsub = await listen<string>('screen-frame-error', () => {
      framesSkipped++
      consecutiveErrors++
      if (consecutiveErrors >= 30) doRestartCapture('capture failing (30 consecutive errors)')
    })
    agentCleanups.push(errUnsub)

    agentCleanupRef.current = () => agentCleanups.forEach((f) => f())

    await invoke('start_native_capture')
    diag('native capture started')

    let lastW = window.screen.width, lastH = window.screen.height
    screenCheckRef.current = setInterval(() => {
      const w = window.screen.width, h = window.screen.height
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h
        // Resolution changed: restart capture so the new dimensions are picked up,
        // and reset quality since frame size has changed significantly
        doRestartCapture(`display changed: ${w}x${h}`)
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
    pc.ondatachannel = (e) => {
      const dc = e.channel
      diag(`DC received: ${dc.label}`)

      if (dc.label === 'frames') {
        setFramesChannel(dc)
        dc.onopen = () => diag('frames DC open')
        dc.onclose = () => diag('frames DC closed')
      } else if (dc.label === 'input') {
        setDataChannel(dc)
        dcRef.current = dc
        dc.onopen = () => diag('input DC open')
        dc.onclose = () => diag('input DC closed')
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
      invoke('stop_input_worker').catch(() => {})
      agentCleanupRef.current?.()
      agentCleanupRef.current = null
    }
    pcRef.current?.close()
    pcRef.current = null
    setFramesChannel(null)
    setDataChannel(null)
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
    invoke('close_session')
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
              navigator.clipboard.readText().then((text) => {
                const dc = dcRef.current
                if (dc?.readyState === 'open') {
                  dc.send(JSON.stringify({ type: 'clipboard', text }))
                }
              })
            }
            title="Paste clipboard to remote"
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
        framesChannel={framesChannel}
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
