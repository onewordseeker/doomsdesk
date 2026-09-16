import React, { useRef, useEffect, useCallback, useState } from 'react'

interface Props {
  framesChannel: RTCDataChannel | null
  dataChannel: RTCDataChannel | null
  remoteScreenSize: { width: number; height: number }
  zoom: number
  stretch: boolean
  connState: 'connecting' | 'connected' | 'failed' | 'disconnected'
  recording?: boolean
  onRecordingChunk?: (blob: Blob) => void
  pointerLockEnabled?: boolean
  keyPassthrough?: boolean
  onLocalZoom?: (delta: number) => void
}

export default function RemoteDisplay({ framesChannel, dataChannel, remoteScreenSize, zoom, stretch, connState, recording, onRecordingChunk, pointerLockEnabled = false, keyPassthrough = true, onLocalZoom }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dcRef = useRef(dataChannel)
  const lastMoveSentRef = useRef(0)
  const heldModsRef = useRef({ ctrl: false, shift: false, alt: false, meta: false })
  const wheelAccRef = useRef(0)  // accumulated vertical scroll for trackpad sub-tick events
  const wheelAccXRef = useRef(0) // accumulated horizontal scroll
  const pointerLockedRef = useRef(false)
  const [frozen, setFrozen] = useState(false)
  const [hasFrames, setHasFrames] = useState(false)
  const [pointerLocked, setPointerLocked] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])

  useEffect(() => { dcRef.current = dataChannel }, [dataChannel])

  // Pointer lock lifecycle
  useEffect(() => {
    const onChange = () => {
      const locked = document.pointerLockElement === canvasRef.current
      pointerLockedRef.current = locked
      setPointerLocked(locked)
    }
    document.addEventListener('pointerlockchange', onChange)
    return () => document.removeEventListener('pointerlockchange', onChange)
  }, [])

  // Exit pointer lock when disabled from toolbar
  useEffect(() => {
    if (!pointerLockEnabled && pointerLockedRef.current) {
      document.exitPointerLock()
    }
  }, [pointerLockEnabled])

  // Session recording via canvas.captureStream
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !onRecordingChunk) return

    if (recording) {
      try {
        const stream = canvas.captureStream(30)
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264')
          ? 'video/webm;codecs=h264'
          : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : 'video/webm'
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
        recChunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) recChunksRef.current.push(e.data)
        }
        recorder.onstop = () => {
          const blob = new Blob(recChunksRef.current, { type: mimeType })
          onRecordingChunk(blob)
          recChunksRef.current = []
        }
        recorder.start(1000) // collect chunks every second
        recorderRef.current = recorder
      } catch (e) {
        console.warn('[recording] MediaRecorder failed:', e)
      }
    } else {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop()
        recorderRef.current = null
      }
    }
  }, [recording, onRecordingChunk])

  // Decode and render incoming H.264 Annex B frames via WebCodecs VideoDecoder
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !framesChannel) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let lastFrameAt = 0
    let hasReceivedFrame = false
    let frameCount = 0
    let lastFpsLog = performance.now()
    let decodedMs = 0 // rolling avg decode time (recv→draw)

    // Resize canvas to match decoded frame on first frame / resolution change
    // avc1.640033 = H.264 High Profile Level 5.1 — accepts any H.264 High output
    // VideoToolbox uses AutoLevel so we must allow up to 5.1 here
    const H264_CODEC = 'avc1.640033'

    const decoder = new VideoDecoder({
      output: (frame) => {
        const drawStart = performance.now()
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width  = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx.drawImage(frame, 0, 0)
        frame.close()
        decodedMs = decodedMs * 0.9 + (performance.now() - drawStart) * 0.1
        frameCount++
        const now = performance.now()
        if (now - lastFpsLog > 3000) {
          const fps = (frameCount / ((now - lastFpsLog) / 1000)).toFixed(1)
          const dc = dcRef.current
          if (dc?.readyState === 'open') {
            dc.send(JSON.stringify({ type: 'stats', fps: parseFloat(fps), decodeMs: Math.round(decodedMs) }))
          }
          frameCount = 0
          lastFpsLog = now
        }
      },
      error: (err) => {
        console.warn('[VideoDecoder] error — resetting:', err)
        try {
          decoder.reset()
          decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
        } catch {}
      },
    })

    try {
      decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
    } catch (err) {
      console.error('[VideoDecoder] configure failed:', err)
      return
    }

    framesChannel.binaryType = 'arraybuffer'

    const onMessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return
      hasReceivedFrame = true
      lastFrameAt = performance.now()
      setHasFrames(true)
      setFrozen(false)

      const data = new Uint8Array(e.data)

      // Scan Annex B start codes to detect NAL type — key if SPS(7)/PPS(8)/IDR(5) present
      let isKey = false
      for (let i = 0; i < data.length - 5; i++) {
        if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
          const nalType = data[i + 4] & 0x1f
          if (nalType === 5 || nalType === 7 || nalType === 8) { isKey = true; break }
        }
      }

      if (decoder.state !== 'closed') {
        try {
          decoder.decode(new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: Math.round(performance.now() * 1000), // μs
            data: e.data,
          }))
        } catch (err) {
          console.warn('[VideoDecoder] decode error:', err)
        }
      }
    }

    framesChannel.addEventListener('message', onMessage)

    // Stall watchdog: if frames stop arriving for 8s, show overlay and request capture restart
    const stallId = setInterval(() => {
      if (!hasReceivedFrame) return
      if (performance.now() - lastFrameAt > 5000) {
        setFrozen(true)
        lastFrameAt = performance.now()
        const dc = dcRef.current
        if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'restart_capture' }))
      }
    }, 2000)

    return () => {
      clearInterval(stallId)
      framesChannel.removeEventListener('message', onMessage)
      try { decoder.close() } catch {}
    }
  }, [framesChannel])

  // Reset hasFrames when channel changes
  useEffect(() => {
    if (!framesChannel) setHasFrames(false)
  }, [framesChannel])

  function toRemote(e: React.MouseEvent): { x: number; y: number } {
    const el = canvasRef.current
    if (!el || !remoteScreenSize.width) return { x: 0, y: 0 }
    const { width: sw, height: sh } = remoteScreenSize

    if (stretch) {
      return {
        x: Math.max(0, Math.min(sw - 1, Math.round((e.nativeEvent.offsetX / el.offsetWidth) * sw))),
        y: Math.max(0, Math.min(sh - 1, Math.round((e.nativeEvent.offsetY / el.offsetHeight) * sh))),
      }
    }

    const rect = el.getBoundingClientRect()
    const contentAspect = el.width && el.height ? el.width / el.height : sw / sh
    const elAspect = rect.width / rect.height
    let contentLeft: number, contentTop: number, contentWidth: number, contentHeight: number
    if (contentAspect > elAspect) {
      contentWidth = rect.width; contentHeight = rect.width / contentAspect
      contentLeft = rect.left; contentTop = rect.top + (rect.height - contentHeight) / 2
    } else {
      contentHeight = rect.height; contentWidth = rect.height * contentAspect
      contentLeft = rect.left + (rect.width - contentWidth) / 2; contentTop = rect.top
    }
    return {
      x: Math.max(0, Math.min(sw - 1, Math.round((e.clientX - contentLeft) * (sw / contentWidth)))),
      y: Math.max(0, Math.min(sh - 1, Math.round((e.clientY - contentTop) * (sh / contentHeight)))),
    }
  }

  function sendInput(event: unknown) {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify(event))
  }

  function releaseModifiers() {
    const h = heldModsRef.current
    if (h.ctrl)  sendInput({ type: 'keyup', key: 'Control', code: 'ControlLeft',  modifiers: {} })
    if (h.shift) sendInput({ type: 'keyup', key: 'Shift',   code: 'ShiftLeft',    modifiers: {} })
    if (h.alt)   sendInput({ type: 'keyup', key: 'Alt',     code: 'AltLeft',      modifiers: {} })
    if (h.meta)  sendInput({ type: 'keyup', key: 'Meta',    code: 'MetaLeft',     modifiers: {} })
    heldModsRef.current = { ctrl: false, shift: false, alt: false, meta: false }
  }

  useEffect(() => {
    const flush = () => {
      releaseModifiers()
      sendInput({ type: 'mouseup', x: 0, y: 0, button: 'left' })
    }
    const onVis = () => { if (document.hidden) flush() }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const now = Date.now()
    if (now - lastMoveSentRef.current < 16) return // ~60hz mouse move
    lastMoveSentRef.current = now
    if (pointerLockedRef.current) {
      if (e.movementX !== 0 || e.movementY !== 0) {
        sendInput({ type: 'mousemove_rel', dx: e.movementX, dy: e.movementY })
      }
    } else {
      const { x, y } = toRemote(e)
      sendInput({ type: 'mousemove', x, y })
    }
  }, [dataChannel, remoteScreenSize, stretch])

  function remoteButton(b: number): string {
    if (b === 1) return 'middle'
    if (b === 2) return 'right'
    if (b === 3) return 'back'
    if (b === 4) return 'forward'
    return 'left'
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    containerRef.current?.focus()
    // Request pointer lock on left click when enabled
    if (pointerLockEnabled && !pointerLockedRef.current && e.button === 0) {
      canvasRef.current?.requestPointerLock()
    }
    const button = remoteButton(e.button)
    if (!pointerLockedRef.current) {
      const { x, y } = toRemote(e)
      sendInput({ type: 'mousedown', x, y, button })
    } else {
      sendInput({ type: 'mousedown', x: 0, y: 0, button })
    }
  }, [dataChannel, remoteScreenSize, stretch, pointerLockEnabled])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const button = remoteButton(e.button)
    if (pointerLockedRef.current) {
      sendInput({ type: 'mouseup', x: 0, y: 0, button })
    } else {
      const { x, y } = toRemote(e)
      sendInput({ type: 'mouseup', x, y, button })
    }
  }, [dataChannel, remoteScreenSize, stretch])

  const onContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault() }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    // Ctrl/Cmd + scroll → local zoom (trackpad pinch, or Ctrl+scroll)
    if (e.ctrlKey || e.metaKey) {
      onLocalZoom?.(e.deltaY < 0 ? 0.1 : -0.1)
      return
    }
    let dy = e.deltaY
    let dx = e.deltaX
    if (e.deltaMode === 0) {
      // Pixel mode (trackpad): accumulate until we have at least one line-equivalent (20px)
      wheelAccRef.current += dy
      const lines = Math.trunc(wheelAccRef.current / 20)
      wheelAccRef.current -= lines * 20
      dy = lines * 20

      wheelAccXRef.current += dx
      const xlines = Math.trunc(wheelAccXRef.current / 20)
      wheelAccXRef.current -= xlines * 20
      dx = xlines * 20

      if (lines === 0 && xlines === 0) return
    }
    sendInput({ type: 'wheel', deltaX: dx, deltaY: dy })
  }, [dataChannel, onLocalZoom])

  const onDblClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = toRemote(e)
    sendInput({ type: 'dblclick', x, y })
  }, [dataChannel, remoteScreenSize, stretch])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!keyPassthrough) return
    e.preventDefault()
    if (e.key === 'Control') heldModsRef.current.ctrl = true
    else if (e.key === 'Shift') heldModsRef.current.shift = true
    else if (e.key === 'Alt')   heldModsRef.current.alt  = true
    else if (e.key === 'Meta')  heldModsRef.current.meta = true
    sendInput({
      type: 'keydown', key: e.key, code: e.code,
      modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    })
  }, [dataChannel, keyPassthrough])

  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!keyPassthrough) return
    e.preventDefault()
    if (e.key === 'Control') heldModsRef.current.ctrl = false
    else if (e.key === 'Shift') heldModsRef.current.shift = false
    else if (e.key === 'Alt')   heldModsRef.current.alt  = false
    else if (e.key === 'Meta')  heldModsRef.current.meta = false
    sendInput({
      type: 'keyup', key: e.key, code: e.code,
      modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    })
  }, [dataChannel, keyPassthrough])

  const onMouseLeave = useCallback((e: React.MouseEvent) => {
    if (e.buttons !== 0) {
      const { x, y } = toRemote(e)
      // e.buttons is a bitmask: 1=left, 2=right, 4=middle, 8=back, 16=forward
      const button = e.buttons === 2 ? 'right' : e.buttons === 4 ? 'middle' : e.buttons === 8 ? 'back' : e.buttons === 16 ? 'forward' : 'left'
      sendInput({ type: 'mouseup', x, y, button })
    }
  }, [dataChannel, remoteScreenSize, stretch])

  const canvasStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: stretch ? 'fill' : 'contain',
    display: hasFrames ? 'block' : 'none',
    ...(zoom !== 1 && !stretch ? { transform: `scale(${zoom})`, transformOrigin: 'center center' } : {}),
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 flex items-center justify-center bg-black overflow-hidden relative focus:outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={onDblClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        className="cursor-crosshair select-none"
      />

      {frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-center px-6">
            <div className="w-8 h-8 border-2 border-slate-600 border-t-yellow-400 rounded-full animate-spin" />
            <span className="text-yellow-400 text-sm font-semibold">Video stream paused</span>
            <span className="text-slate-400 text-xs leading-snug">
              Network interruption or elevated window on remote.<br />
              Resuming automatically…
            </span>
          </div>
        </div>
      )}

      {!hasFrames && connState !== 'failed' && connState !== 'disconnected' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
          <div className="w-12 h-12 border-2 border-slate-600 border-t-brand rounded-full animate-spin" />
          <span className="text-sm">Connecting…</span>
          <span className="text-xs text-slate-600">Waiting for screen stream from remote device</span>
        </div>
      )}

      {/* Pointer lock indicator */}
      {pointerLocked && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="flex items-center gap-2 bg-black/80 border border-brand/30 rounded-full px-3 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
            <span className="text-xs text-brand font-medium">Pointer captured — Press Escape to release</span>
          </div>
        </div>
      )}

      {/* Key pass-through disabled indicator */}
      {!keyPassthrough && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="flex items-center gap-2 bg-black/80 border border-amber-500/40 rounded-full px-3 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-xs text-amber-400 font-medium">Keys local — Ctrl/⌘ / to re-enable remote keys</span>
          </div>
        </div>
      )}
    </div>
  )
}
