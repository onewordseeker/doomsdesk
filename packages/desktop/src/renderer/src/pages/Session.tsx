import React, { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import RemoteDisplay from '../components/RemoteDisplay'
import {
  Maximize2, Minimize2, ZoomIn, ZoomOut, Expand, Shrink,
  Clipboard, X, Monitor, MessageSquare, Send, Tv2,
  Upload, Download, Mic, MicOff, Lock, Activity, Camera, Circle, Gauge, Crosshair, HelpCircle
} from 'lucide-react'

interface Props {
  peerId: string
  role: 'controller' | 'agent'
  onEnd: () => void
}

interface MonitorInfo {
  id: number
  width: number
  height: number
  isMain: boolean
}

interface FileTransfer {
  id: string
  name: string
  size: number
  received: number
  direction: 'sending' | 'receiving'
  chunks: ArrayBuffer[]
  done: boolean
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

const FILE_CHUNK_SIZE = 65536  // 64 KB chunks

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
  const [renderStats, setRenderStats] = useState<{ fps: number; decodeMs: number; bps?: number } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<Array<{ from: 'me' | 'them'; text: string; ts: number }>>([])
  const [chatInput, setChatInput] = useState('')
  const [agentMonitors, setAgentMonitors] = useState<MonitorInfo[]>([])
  const [selectedMonitor, setSelectedMonitor] = useState<number>(0)
  const [fileTransfers, setFileTransfers] = useState<FileTransfer[]>([])
  const [showFiles, setShowFiles] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const [recording, setRecording] = useState(false)
  const [peerRtt, setPeerRtt] = useState<number | null>(null)
  const [showActionsMenu, setShowActionsMenu] = useState(false)
  const [qualityPreset, setQualityPreset] = useState<'auto' | 'lan' | 'wan' | 'low'>('auto')
  const [dragOver, setDragOver] = useState(false)
  const [pointerLockEnabled, setPointerLockEnabled] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [remoteAudioEl] = useState(() => {
    const el = document.createElement('audio')
    el.autoplay = true
    return el
  })

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const fileDcRef = useRef<RTCDataChannel | null>(null)
  const frameWsRef = useRef<WebSocket | null>(null)
  const agentCleanupRef = useRef<(() => void) | null>(null)
  const origScreenRef = useRef<{ width: number; height: number } | null>(null)
  const durationRef = useRef<ReturnType<typeof setInterval>>()
  const screenCheckRef = useRef<ReturnType<typeof setInterval>>()
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const pendingTransfersRef = useRef<Map<string, FileTransfer>>(new Map())
  const micStreamRef = useRef<MediaStream | null>(null)
  const micSenderRef = useRef<RTCRtpSender | null>(null)

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

    // Receive remote audio track (agent's mic)
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        diag('remote audio track received')
        remoteAudioEl.srcObject = e.streams[0]
      }
    }

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

    // Connection timeout: fail after 30s if we never reach 'connected'
    let connected = false
    const connTimeout = setTimeout(() => {
      if (!connected && pc.connectionState !== 'connected') {
        diag('connection timed out after 30s')
        setConnState('failed')
        setInitError('Connection timed out — check TURN server and firewall')
      }
    }, 30_000)

    pc.onconnectionstatechange = () => {
      diag(`RTC: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        connected = true
        clearTimeout(connTimeout)
        setConnState('connected')
      } else if (pc.connectionState === 'disconnected') {
        setConnState('disconnected')
        // Attempt ICE restart after a brief pause
        setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            diag('ICE restart attempted')
            try { pc.restartIce() } catch {}
          }
        }, 3000)
      } else if (pc.connectionState === 'failed') {
        clearTimeout(connTimeout)
        setConnState('failed')
      }
    }

    if (role === 'agent') {
      await setupAgentSide(pc)
    } else {
      await setupControllerSide(pc)
    }
  }

  async function setupAgentSide(pc: RTCPeerConnection) {
    diag('setting up agent data channels')

    const framesDc = pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 })
    const inputDc = pc.createDataChannel('input')
    const fileDc = pc.createDataChannel('files')
    setDataChannel(inputDc)
    dcRef.current = inputDc
    fileDcRef.current = fileDc

    const agentCleanups: Array<() => void> = []

    let framesSent = 0
    let framesSkipped = 0
    let currentBps = 4_000_000
    let qualityPinBps = 0          // 0 = adaptive; >0 = fixed bitrate
    let stableWindows = 0
    let consecutiveErrors = 0
    let captureRestarting = false

    async function connectFrameWs() {
      const port = await invoke<number>('start_native_capture')
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.binaryType = 'arraybuffer'

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        if (ev.data.byteLength === 0) return
        consecutiveErrors = 0
        if (framesDc.readyState !== 'open') return
        if (framesDc.bufferedAmount > 262144) { framesSkipped++; return }
        framesDc.send(ev.data)
        framesSent++
      }

      ws.onerror = () => diag('frame WS error')
      ws.onclose = () => diag('frame WS closed')
      frameWsRef.current = ws
      diag(`capture WS on port ${port}`)
    }

    function doRestartCapture(reason: string) {
      if (captureRestarting) return
      captureRestarting = true
      diag(`${reason} — restarting capture`)
      currentBps = 4_000_000
      consecutiveErrors = 0
      invoke('set_capture_bitrate', { bps: 4_000_000 }).catch(() => {})
      frameWsRef.current?.close()
      frameWsRef.current = null
      invoke('stop_native_capture').catch(() => {})
      setTimeout(async () => {
        await connectFrameWs()
        captureRestarting = false
      }, 500)
    }

    // File DC: agent receives files from controller
    fileDc.binaryType = 'arraybuffer'
    fileDc.onopen = () => diag('file DC open')
    fileDc.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'file_start') {
          pendingTransfersRef.current.set(msg.id, {
            id: msg.id, name: msg.name, size: msg.size,
            received: 0, direction: 'receiving', chunks: [], done: false,
          })
          setFileTransfers((prev) => [...prev, {
            id: msg.id, name: msg.name, size: msg.size,
            received: 0, direction: 'receiving', chunks: [], done: false,
          }])
          setShowFiles(true)
          diag(`file receiving: ${msg.name} (${(msg.size / 1024).toFixed(0)} KB)`)
        } else if (msg.type === 'file_end') {
          const t = pendingTransfersRef.current.get(msg.id)
          if (!t) return
          const blob = new Blob(t.chunks)
          const data = new Uint8Array(await blob.arrayBuffer())
          invoke('save_received_file', { name: t.name, data: Array.from(data) }).catch(() => {})
          t.done = true
          pendingTransfersRef.current.delete(msg.id)
          setFileTransfers((prev) => prev.map((f) => f.id === msg.id ? { ...f, done: true } : f))
          diag(`file received: ${t.name}`)
        }
      } else if (ev.data instanceof ArrayBuffer) {
        // Chunk: first 36 bytes are the transfer ID (UUID as ASCII), rest is data
        const idBuf = ev.data.slice(0, 36)
        const chunk = ev.data.slice(36)
        const id = new TextDecoder().decode(idBuf)
        const t = pendingTransfersRef.current.get(id)
        if (!t) return
        t.chunks.push(chunk)
        t.received += chunk.byteLength
        setFileTransfers((prev) => prev.map((f) => f.id === id ? { ...f, received: t.received } : f))
      }
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
        } else if (msg.type === 'switch_monitor') {
          const id = (msg as any).displayId as number ?? 0
          diag(`switch monitor → ${id}`)
          // Just update the display ID — capture loop auto-adapts on next frame,
          // encoder recreates itself if resolution changes, no pipeline restart needed
          invoke('set_capture_monitor', { displayId: id }).catch(() => {})
          // Send updated screen_info after a short delay for the new monitor's dimensions
          setTimeout(async () => {
            try {
              const monitors = await invoke<MonitorInfo[]>('list_monitors')
              const mon = monitors.find((m) => m.id === id) ?? monitors.find((m) => m.isMain) ?? monitors[0]
              if (mon) {
                const capW = Math.min(mon.width, 1920)
                const capH = Math.round(mon.height * (capW / mon.width))
                const d = dcRef.current
                if (d?.readyState === 'open') d.send(JSON.stringify({ type: 'screen_info', width: capW, height: capH }))
              }
            } catch {}
          }, 200)
        } else if (msg.type === 'request_clipboard') {
          navigator.clipboard.readText().then((text) => {
            if (inputDc.readyState === 'open') {
              inputDc.send(JSON.stringify({ type: 'agent_clipboard', text }))
            }
          }).catch(() => {})
        } else if (msg.type === 'screenshot') {
          // Capture a PNG of the current display and send via files DC
          invoke<string>('capture_screenshot_png').then((b64) => {
            const dc = fileDcRef.current
            if (!dc || dc.readyState !== 'open') return
            const binary = atob(b64)
            const buf = new ArrayBuffer(binary.length)
            const view = new Uint8Array(buf)
            for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
            const id = crypto.randomUUID()
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const name = `screenshot-${ts}.png`
            dc.send(JSON.stringify({ type: 'file_start', id, name, size: buf.byteLength }))
            const idBytes = new TextEncoder().encode(id.padEnd(36, ' ').slice(0, 36))
            let offset = 0
            const sendChunk = () => {
              if (offset >= buf.byteLength) { dc.send(JSON.stringify({ type: 'file_end', id })); return }
              const slice = buf.slice(offset, offset + FILE_CHUNK_SIZE)
              const packet = new Uint8Array(36 + slice.byteLength)
              packet.set(idBytes, 0)
              packet.set(new Uint8Array(slice), 36)
              dc.send(packet.buffer)
              offset += slice.byteLength
              setTimeout(sendChunk, dc.bufferedAmount > 1_048_576 ? 50 : 0)
            }
            sendChunk()
          }).catch((e) => diag(`screenshot err: ${e}`))
        } else if (msg.type === 'set_quality') {
          const presetBps: Record<string, number> = { lan: 16_000_000, wan: 4_000_000, low: 2_000_000 }
          qualityPinBps = presetBps[msg.preset as string] ?? 0
          if (qualityPinBps > 0) {
            currentBps = qualityPinBps
            invoke('set_capture_bitrate', { bps: currentBps }).catch(() => {})
            diag(`quality preset: ${msg.preset} (${(qualityPinBps / 1e6).toFixed(0)} Mbps fixed)`)
          } else {
            diag('quality preset: auto (adaptive)')
          }
        } else if (msg.type === 'ping') {
          if (inputDc.readyState === 'open') inputDc.send(JSON.stringify({ type: 'pong', t: msg.t }))
        } else if (msg.type === 'chat') {
          diag(`[chat] ${msg.text ?? ''}`)
        } else {
          invoke('inject_input', { event: msg })
        }
      } catch {}
    }

    inputDc.onopen = async () => {
      diag('input DC open — starting input worker')
      invoke('start_input_worker').catch(() => {})
      try {
        const monitors = await invoke<MonitorInfo[]>('list_monitors')
        // Use physical pixel dimensions of the primary (or first) monitor
        const primary = monitors.find((m) => m.isMain) ?? monitors[0]
        const capW = primary ? Math.min(primary.width, 1920) : window.screen.width
        const capH = primary ? Math.round(primary.height * (capW / primary.width)) : window.screen.height
        inputDc.send(JSON.stringify({ type: 'screen_info', width: capW, height: capH }))
        inputDc.send(JSON.stringify({ type: 'monitor_list', monitors }))
      } catch {
        inputDc.send(
          JSON.stringify({ type: 'screen_info', width: window.screen.width, height: window.screen.height })
        )
      }
    }

    framesDc.onopen = () => diag('frames DC open')
    framesDc.onclose = () => diag('frames DC closed')

    setRemoteScreenSize({ width: window.screen.width, height: window.screen.height })
    origScreenRef.current = { width: window.screen.width, height: window.screen.height }

    // Adaptive bitrate — 2 Mbps floor, 8 Mbps ceiling
    const bitrateInterval = setInterval(() => {
      const total = framesSent + framesSkipped
      if (total === 0) return
      const skipRate = framesSkipped / total
      const mbps = (currentBps / 1_000_000).toFixed(1)
      diag(`sent=${framesSent} skip=${framesSkipped} skip%=${Math.round(skipRate * 100)} bps=${mbps}M`)

      if (qualityPinBps > 0) {
        // Fixed quality preset — pin bitrate, skip adaptive logic
        if (currentBps !== qualityPinBps) {
          currentBps = qualityPinBps
          invoke('set_capture_bitrate', { bps: currentBps }).catch(() => {})
          diag(`bitrate pinned ${(currentBps / 1_000_000).toFixed(1)} Mbps`)
        }
      } else if (skipRate > 0.05) {
        const factor = skipRate > 0.5 ? 0.5 : skipRate > 0.2 ? 0.7 : 0.85
        currentBps = Math.max(2_000_000, Math.round(currentBps * factor))
        invoke('set_capture_bitrate', { bps: currentBps }).catch(() => {})
        stableWindows = 0
        diag(`bitrate ↓ ${(currentBps / 1_000_000).toFixed(1)} Mbps`)
      } else if (skipRate === 0) {
        stableWindows++
        if (stableWindows >= 2 && currentBps < 16_000_000) {
          currentBps = Math.min(16_000_000, Math.round(currentBps * 1.2))
          invoke('set_capture_bitrate', { bps: currentBps }).catch(() => {})
          stableWindows = 0
          diag(`bitrate ↑ ${(currentBps / 1_000_000).toFixed(1)} Mbps`)
        }
      } else {
        stableWindows = 0
      }
      // Inform controller of current bitrate
      const d = dcRef.current
      if (d?.readyState === 'open') {
        d.send(JSON.stringify({ type: 'bitrate_info', bps: currentBps }))
      }
      framesSent = 0
      framesSkipped = 0
    }, 3000)
    agentCleanups.push(() => clearInterval(bitrateInterval))

    const errUnsub = await listen<string>('screen-frame-error', () => {
      framesSkipped++
      consecutiveErrors++
      if (consecutiveErrors >= 30) doRestartCapture('capture failing (30 consecutive errors)')
    })
    agentCleanups.push(errUnsub)

    agentCleanupRef.current = () => {
      agentCleanups.forEach((f) => f())
      frameWsRef.current?.close()
      frameWsRef.current = null
    }

    await connectFrameWs()

    let lastW = window.screen.width, lastH = window.screen.height
    screenCheckRef.current = setInterval(async () => {
      const w = window.screen.width, h = window.screen.height
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h
        doRestartCapture(`display changed: ${w}x${h}`)
        const d = dcRef.current
        if (d?.readyState === 'open') {
          try {
            const monitors = await invoke<MonitorInfo[]>('list_monitors')
            const primary = monitors.find((m) => m.isMain) ?? monitors[0]
            const capW = primary ? Math.min(primary.width, 1920) : w
            const capH = primary ? Math.round(primary.height * (capW / primary.width)) : h
            d.send(JSON.stringify({ type: 'screen_info', width: capW, height: capH }))
          } catch {
            d.send(JSON.stringify({ type: 'screen_info', width: w, height: h }))
          }
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
        dc.binaryType = 'arraybuffer'
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
            } else if (msg.type === 'monitor_list') {
              setAgentMonitors(msg.monitors ?? [])
            } else if (msg.type === 'agent_clipboard') {
              navigator.clipboard.writeText(msg.text ?? '').catch(() => {})
              diag(`remote clipboard pulled (${(msg.text ?? '').length} chars)`)
            } else if (msg.type === 'stats') {
              setRenderStats((prev) => ({ ...prev, fps: msg.fps, decodeMs: msg.decodeMs }))
            } else if (msg.type === 'bitrate_info') {
              setRenderStats((prev) => prev ? { ...prev, bps: msg.bps } : { fps: 0, decodeMs: 0, bps: msg.bps })
            } else if (msg.type === 'pong') {
              if (msg.t) setPeerRtt(Date.now() - msg.t)
            } else if (msg.type === 'chat') {
              setChatMessages((prev) => [...prev, { from: 'them', text: msg.text ?? '', ts: Date.now() }])
              setChatOpen(true)
            }
          } catch {}
        }
        // Send pings every 5s to measure peer RTT
        const pingId = setInterval(() => {
          if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'ping', t: Date.now() }))
        }, 5000)
        dc.onclose = () => { diag('input DC closed'); clearInterval(pingId) }
      } else if (dc.label === 'files') {
        dc.binaryType = 'arraybuffer'
        fileDcRef.current = dc
        dc.onopen = () => diag('file DC open')
        dc.onmessage = (ev) => {
          // Controller receives files from agent (future: reverse direction)
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data)
              if (msg.type === 'file_start') {
                pendingTransfersRef.current.set(msg.id, {
                  id: msg.id, name: msg.name, size: msg.size,
                  received: 0, direction: 'receiving', chunks: [], done: false,
                })
                setFileTransfers((prev) => [...prev, {
                  id: msg.id, name: msg.name, size: msg.size,
                  received: 0, direction: 'receiving', chunks: [], done: false,
                }])
                setShowFiles(true)
              } else if (msg.type === 'file_end') {
                const t = pendingTransfersRef.current.get(msg.id)
                if (!t) return
                const blob = new Blob(t.chunks)
                blob.arrayBuffer().then((ab) => {
                  const data = Array.from(new Uint8Array(ab))
                  invoke('save_received_file', { name: t.name, data }).catch(() => {})
                })
                t.done = true
                pendingTransfersRef.current.delete(msg.id)
                setFileTransfers((prev) => prev.map((f) => f.id === msg.id ? { ...f, done: true } : f))
              }
            } catch {}
          } else if (ev.data instanceof ArrayBuffer) {
            const id = new TextDecoder().decode(ev.data.slice(0, 36))
            const chunk = ev.data.slice(36)
            const t = pendingTransfersRef.current.get(id)
            if (!t) return
            t.chunks.push(chunk)
            t.received += chunk.byteLength
            setFileTransfers((prev) => prev.map((f) => f.id === id ? { ...f, received: t.received } : f))
          }
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

  // Send a file to the remote (controller → agent)
  async function sendFile(file: File) {
    const dc = fileDcRef.current
    if (!dc || dc.readyState !== 'open') return
    const id = crypto.randomUUID()
    const name = file.name
    const size = file.size

    diag(`sending file: ${name} (${(size / 1024).toFixed(0)} KB)`)
    setFileTransfers((prev) => [...prev, { id, name, size, received: 0, direction: 'sending', chunks: [], done: false }])
    setShowFiles(true)

    dc.send(JSON.stringify({ type: 'file_start', id, name, size }))

    const buf = await file.arrayBuffer()
    let offset = 0
    const idBytes = new TextEncoder().encode(id.padEnd(36, ' ').slice(0, 36))

    while (offset < size) {
      const slice = buf.slice(offset, offset + FILE_CHUNK_SIZE)
      const packet = new Uint8Array(36 + slice.byteLength)
      packet.set(idBytes, 0)
      packet.set(new Uint8Array(slice), 36)

      // Respect back-pressure
      while (dc.bufferedAmount > 1_048_576) {
        await new Promise((r) => setTimeout(r, 50))
      }

      dc.send(packet.buffer)
      offset += slice.byteLength

      const sent = offset
      setFileTransfers((prev) => prev.map((f) => f.id === id ? { ...f, received: sent } : f))
    }

    dc.send(JSON.stringify({ type: 'file_end', id }))
    setFileTransfers((prev) => prev.map((f) => f.id === id ? { ...f, done: true } : f))
    diag(`file sent: ${name}`)
  }

  async function toggleMic() {
    const pc = pcRef.current
    if (!pc) return

    if (micActive) {
      // Mute / remove mic
      micSenderRef.current?.track?.stop()
      if (micSenderRef.current) {
        try { pc.removeTrack(micSenderRef.current) } catch {}
      }
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
      micSenderRef.current = null
      setMicActive(false)
      diag('mic off')
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
        micStreamRef.current = stream
        const track = stream.getAudioTracks()[0]
        micSenderRef.current = pc.addTrack(track, stream)
        setMicActive(true)
        diag('mic on')
        // Renegotiate so the remote receives the audio track
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        invoke('send_signaling', { msg: { type: 'offer', targetId: peerId, sdp: offer.sdp } })
      } catch (e) {
        diag(`mic error: ${e}`)
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
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
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

  function sendChat(text: string) {
    const dc = dcRef.current
    if (!text.trim() || !dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({ type: 'chat', text: text.trim() }))
    setChatMessages((prev) => [...prev, { from: 'me', text: text.trim(), ts: Date.now() }])
    setChatInput('')
  }

  function switchMonitor(displayId: number) {
    setSelectedMonitor(displayId)
    const dc = dcRef.current
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'switch_monitor', displayId }))
    }
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
    try { await getCurrentWindow().setFullscreen(newFs) } catch {}
    if (newFs) {
      hideTimerRef.current = setTimeout(() => setToolbarHidden(true), 3000)
    } else {
      setToolbarHidden(false)
    }
  }, [fullscreen])

  // Paste handler: if clipboard contains an image, send it as a file
  useEffect(() => {
    if (role !== 'controller') return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const ext = item.type.split('/')[1] ?? 'png'
            const namedFile = new File([file], `paste-${ts}.${ext}`, { type: item.type })
            sendFile(namedFile)
          }
          break
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [role])

  // F11 toggles fullscreen; Ctrl+= zoom in; Ctrl+- zoom out; Ctrl+0 reset zoom
  // Click outside closes actions menu
  useEffect(() => {
    if (role !== 'controller') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); toggleFullscreen() }
      else if (e.key === 'Escape') { setShowActionsMenu(false); setShowShortcuts(false) }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'm') { e.preventDefault(); toggleMic() }
      else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault(); setZoom((z) => Math.min(3, z + 0.25))
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault(); setZoom((z) => Math.max(0.5, z - 0.25))
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [role, toggleFullscreen])

  function sendDisplayResolution(preset: DisplayPreset) {
    setDisplayPreset(preset)
    if (dataChannel?.readyState === 'open') {
      dataChannel.send(
        JSON.stringify({ type: 'set_display_resolution', width: preset.width, height: preset.height })
      )
    }
  }

  async function handleRecordingDone(blob: Blob) {
    setRecording(false)
    // Save via Tauri dialog
    const ab = await blob.arrayBuffer()
    const data = Array.from(new Uint8Array(ab))
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    invoke('save_received_file', { name: `session-${ts}.webm`, data }).catch(() => {})
  }

  function sendSpecialKey(combo: string) {
    const dc = dcRef.current
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'send_keys', combo }))
  }

  function applyQualityPreset(preset: typeof qualityPreset) {
    setQualityPreset(preset)
    const dc = dcRef.current
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'set_quality', preset }))
  }

  function pickAndSendFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const files = Array.from(input.files ?? [])
      for (const file of files) await sendFile(file)
    }
    input.click()
  }

  if (role === 'agent') {
    return (
      <div className="flex items-center justify-between h-screen px-4 bg-bg border border-surface-border select-none">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white leading-tight">Being controlled</p>
            <p className="text-xs text-slate-500 font-mono leading-tight truncate">{peerId}</p>
          </div>
        </div>
        <button
          onClick={handleEnd}
          className="ml-3 shrink-0 px-3 py-1.5 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors"
        >
          End
        </button>
      </div>
    )
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
          {renderStats && (
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {renderStats.fps?.toFixed(0) ?? 0} fps · {renderStats.decodeMs ?? 0} ms
              {renderStats.bps != null && ` · ${(renderStats.bps / 1_000_000).toFixed(1)}M`}
              {peerRtt !== null && ` · ${peerRtt}ms`}
            </span>
          )}
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

          {agentMonitors.length > 1 && (
            <>
              <span title="Remote monitors" className="text-slate-500">
                <Tv2 size={14} />
              </span>
              <select
                value={selectedMonitor}
                onChange={(e) => switchMonitor(Number(e.target.value))}
                className="text-xs bg-surface text-slate-300 border border-surface-border rounded px-1.5 py-0.5 cursor-pointer"
              >
                {agentMonitors.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.isMain ? '★ ' : ''}{m.width}×{m.height}
                  </option>
                ))}
              </select>
              <div className="w-px h-4 bg-surface-border mx-1" />
            </>
          )}

          <span className="text-xs text-slate-600 font-mono" title="Remote display resolution">
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
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>

          <div className="w-px h-4 bg-surface-border mx-1" />

          {/* Quality preset */}
          <span title="Stream quality" className="text-slate-500 shrink-0">
            <Gauge size={14} />
          </span>
          <select
            value={qualityPreset}
            onChange={(e) => applyQualityPreset(e.target.value as typeof qualityPreset)}
            title="Stream quality preset"
            className="text-xs bg-surface text-slate-300 border border-surface-border rounded px-1.5 py-0.5 cursor-pointer"
          >
            <option value="auto">Auto</option>
            <option value="lan">LAN (16 Mbps)</option>
            <option value="wan">WAN (4 Mbps)</option>
            <option value="low">Low (2 Mbps)</option>
          </select>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn
            onClick={() =>
              navigator.clipboard.readText().then((text) => {
                const dc = dcRef.current
                if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'clipboard', text }))
              })
            }
            title="Push local clipboard → remote"
          >
            <Clipboard size={14} />
          </ToolBtn>
          <ToolBtn
            onClick={() => {
              const dc = dcRef.current
              if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'request_clipboard' }))
            }}
            title="Pull remote clipboard → local"
          >
            <Clipboard size={14} style={{ transform: 'scaleX(-1)' }} />
          </ToolBtn>

          <ToolBtn onClick={pickAndSendFile} title="Send file to remote">
            <Upload size={14} />
          </ToolBtn>

          {fileTransfers.length > 0 && (
            <ToolBtn onClick={() => setShowFiles((v) => !v)} title="File transfers" active={showFiles}>
              <Download size={14} />
            </ToolBtn>
          )}

          <ToolBtn onClick={toggleMic} title={micActive ? 'Mute mic' : 'Enable mic'} active={micActive}>
            {micActive ? <Mic size={14} /> : <MicOff size={14} />}
          </ToolBtn>
          <ToolBtn
            onClick={() => setRecording((v) => !v)}
            title={recording ? 'Stop recording' : 'Record session'}
            active={recording}
          >
            <Circle size={14} className={recording ? 'fill-red-500 text-red-500' : ''} />
          </ToolBtn>
          <ToolBtn
            onClick={() => setPointerLockEnabled((v) => !v)}
            title={pointerLockEnabled ? 'Disable pointer lock (gaming mode)' : 'Enable pointer lock (gaming mode — click remote to lock pointer)'}
            active={pointerLockEnabled}
          >
            <Crosshair size={14} />
          </ToolBtn>

          {/* Remote actions dropdown */}
          <div className="relative">
            <ToolBtn onClick={() => setShowActionsMenu((v) => !v)} title="Remote actions" active={showActionsMenu}>
              <Activity size={14} />
            </ToolBtn>
            {showActionsMenu && (
              <div className="absolute top-full right-0 mt-1 bg-surface border border-surface-border rounded-lg shadow-xl z-30 py-1 min-w-[160px]">
                <button
                  onClick={() => { sendSpecialKey('lock'); setShowActionsMenu(false) }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-elevated transition-colors"
                >
                  <Lock size={12} /> Lock Screen
                </button>
                <button
                  onClick={() => { sendSpecialKey('task_mgr'); setShowActionsMenu(false) }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-elevated transition-colors"
                >
                  <Activity size={12} /> Task Manager
                </button>
                <button
                  onClick={() => { sendSpecialKey('ctrl_alt_del'); setShowActionsMenu(false) }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-elevated transition-colors"
                >
                  <Lock size={12} /> Ctrl+Alt+Del
                </button>
                <button
                  onClick={() => {
                    const dc = dcRef.current
                    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'screenshot' }))
                    setShowActionsMenu(false)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-elevated transition-colors"
                >
                  <Camera size={12} /> Screenshot
                </button>
              </div>
            )}
          </div>

          <ToolBtn onClick={() => setChatOpen((v) => !v)} title="Chat" active={chatOpen}>
            <MessageSquare size={14} />
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </ToolBtn>

          <div className="w-px h-4 bg-surface-border mx-1" />

          <ToolBtn onClick={() => setShowDiag((v) => !v)} title="Toggle diagnostics" active={showDiag}>
            <Monitor size={14} />
          </ToolBtn>

          {/* Keyboard shortcuts help */}
          <div className="relative">
            <ToolBtn onClick={() => setShowShortcuts((v) => !v)} title="Keyboard shortcuts" active={showShortcuts}>
              <HelpCircle size={14} />
            </ToolBtn>
            {showShortcuts && (
              <div className="absolute top-full right-0 mt-1 bg-surface border border-surface-border rounded-lg shadow-xl z-30 py-2 px-3 w-56">
                <p className="text-xs font-semibold text-slate-300 mb-2">Keyboard Shortcuts</p>
                <div className="space-y-1 text-xs text-slate-400 font-mono">
                  {[
                    ['F11', 'Toggle fullscreen'],
                    ['Ctrl/⌘ +', 'Zoom in'],
                    ['Ctrl/⌘ -', 'Zoom out'],
                    ['Ctrl/⌘ 0', 'Reset zoom'],
                    ['Ctrl/⌘ M', 'Toggle mic'],
                    ['Esc', 'Exit pointer lock / menus'],
                  ].map(([key, desc]) => (
                    <div key={key} className="flex justify-between gap-3">
                      <span className="bg-black/40 px-1.5 rounded shrink-0">{key}</span>
                      <span className="text-right text-slate-500">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

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
            <p className="text-red-400 text-sm font-medium mb-2">
              {connState === 'failed' ? 'Connection failed' : 'Session failed to start'}
            </p>
            <p className="text-slate-400 text-xs font-mono mb-5">
              {initError || 'ICE negotiation failed — the devices could not reach each other'}
            </p>
            <button
              onClick={handleEnd}
              className="px-5 py-2 bg-surface border border-surface-border text-slate-300 text-sm rounded-lg hover:border-slate-500 transition-colors"
            >
              ← Back to Home
            </button>
          </div>
        </div>
      )}

      {/* File transfers panel */}
      {showFiles && fileTransfers.length > 0 && (
        <div className="absolute top-12 right-0 z-20 w-72 bg-black/90 border border-slate-700 rounded-bl-lg">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700">
            <span className="text-xs text-slate-400 font-mono">File Transfers</span>
            <button onClick={() => setShowFiles(false)} className="text-slate-500 hover:text-white">
              <X size={12} />
            </button>
          </div>
          <div className="p-2 space-y-2 max-h-48 overflow-y-auto">
            {fileTransfers.map((ft) => (
              <div key={ft.id} className="text-xs">
                <div className="flex justify-between text-slate-400 mb-0.5">
                  <span className="truncate max-w-[160px]">{ft.name}</span>
                  <span className="text-slate-500 ml-2">
                    {ft.done ? '✓' : `${Math.round((ft.received / ft.size) * 100)}%`}
                  </span>
                </div>
                <div className="w-full bg-surface rounded-full h-1">
                  <div
                    className={`h-1 rounded-full transition-all ${ft.done ? 'bg-emerald-500' : 'bg-brand'}`}
                    style={{ width: `${Math.min(100, (ft.received / ft.size) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
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

      {chatOpen && (
        <div className="absolute bottom-0 left-0 z-20 w-80 max-h-72 bg-black/90 border border-slate-700 rounded-tr-lg flex flex-col">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700 shrink-0">
            <span className="text-xs text-slate-400 font-mono">Chat</span>
            <button onClick={() => setChatOpen(false)} className="text-slate-500 hover:text-white">
              <X size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-xs">
            {chatMessages.length === 0 ? (
              <span className="text-slate-600">No messages yet…</span>
            ) : (
              chatMessages.map((m, i) => (
                <div key={i} className={`flex flex-col ${m.from === 'me' ? 'items-end' : 'items-start'}`}>
                  <span className={`px-2 py-1 rounded-lg max-w-[90%] break-words ${
                    m.from === 'me' ? 'bg-brand/20 text-brand' : 'bg-surface text-slate-300'
                  }`}>
                    {m.text}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-1 p-1.5 border-t border-slate-700 shrink-0">
            <input
              className="flex-1 bg-surface text-slate-200 text-xs rounded px-2 py-1 outline-none border border-transparent focus:border-brand/50"
              placeholder="Type a message…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(chatInput) } }}
            />
            <button onClick={() => sendChat(chatInput)} className="p-1.5 text-slate-400 hover:text-brand">
              <Send size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Disconnected/reconnecting overlay */}
      {connState === 'disconnected' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="flex items-center gap-2 bg-black/70 border border-yellow-500/30 rounded-lg px-4 py-2">
            <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
            <span className="text-yellow-400 text-xs font-medium">Reconnecting…</span>
          </div>
        </div>
      )}

      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand/10 border-2 border-brand/50 border-dashed pointer-events-none rounded-sm">
          <div className="flex flex-col items-center gap-2">
            <Upload size={32} className="text-brand" />
            <span className="text-brand text-sm font-medium">Drop to send file</span>
          </div>
        </div>
      )}

      <div
        className="flex flex-col flex-1 min-h-0 relative"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const files = Array.from(e.dataTransfer.files)
          files.forEach((f) => sendFile(f))
        }}
      >
        <RemoteDisplay
          framesChannel={framesChannel}
          dataChannel={dataChannel}
          remoteScreenSize={remoteScreenSize}
          zoom={zoom}
          stretch={stretch}
          connState={connState}
          recording={recording}
          onRecordingChunk={handleRecordingDone}
          pointerLockEnabled={pointerLockEnabled}
        />
      </div>
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
