import React, { useRef, useEffect, useCallback, useState } from 'react'

interface Props {
  framesChannel: RTCDataChannel | null
  dataChannel: RTCDataChannel | null
  remoteScreenSize: { width: number; height: number }
  zoom: number
  stretch: boolean
  connState: 'connecting' | 'connected' | 'failed' | 'disconnected'
}

export default function RemoteDisplay({ framesChannel, dataChannel, remoteScreenSize, zoom, stretch, connState }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dcRef = useRef(dataChannel)
  const lastMoveSentRef = useRef(0)
  const heldModsRef = useRef({ ctrl: false, shift: false, alt: false, meta: false })
  const [frozen, setFrozen] = useState(false)
  const [hasFrames, setHasFrames] = useState(false)

  useEffect(() => { dcRef.current = dataChannel }, [dataChannel])

  // Decode and render incoming JPEG frames from the data channel
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !framesChannel) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let latestBitmap: ImageBitmap | null = null
    let rafId = 0
    let lastFrameAt = 0 // 0 = no frame received yet
    let hasReceivedFrame = false
    let decodeGen = 0 // incremented per message; stale decodes discard their bitmap

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

    const onMessage = async (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      hasReceivedFrame = true
      lastFrameAt = performance.now()
      setHasFrames(true)
      setFrozen(false)
      const myGen = ++decodeGen
      try {
        // Decode base64 JPEG string → Blob → ImageBitmap (off main thread)
        const binaryStr = atob(e.data)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob)
        // Discard if a newer frame already decoded — prevents stale bitmap pileup
        if (myGen !== decodeGen) { bitmap.close(); return }
        latestBitmap?.close()
        latestBitmap = bitmap
      } catch {}
    }

    framesChannel.addEventListener('message', onMessage)

    // Stall watchdog: if frames stop arriving for 8s, show overlay and request capture restart
    const stallId = setInterval(() => {
      if (!hasReceivedFrame) return
      if (performance.now() - lastFrameAt > 8000) {
        setFrozen(true)
        lastFrameAt = performance.now()
        const dc = dcRef.current
        if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'restart_capture' }))
      }
    }, 2000)

    return () => {
      cancelAnimationFrame(rafId)
      clearInterval(stallId)
      framesChannel.removeEventListener('message', onMessage)
      latestBitmap?.close()
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
    const { x, y } = toRemote(e)
    sendInput({ type: 'mousemove', x, y })
  }, [dataChannel, remoteScreenSize, stretch])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    containerRef.current?.focus()
    const { x, y } = toRemote(e)
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    sendInput({ type: 'mousedown', x, y, button })
  }, [dataChannel, remoteScreenSize, stretch])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = toRemote(e)
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    sendInput({ type: 'mouseup', x, y, button })
  }, [dataChannel, remoteScreenSize, stretch])

  const onContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault() }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    sendInput({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })
  }, [dataChannel])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Control') heldModsRef.current.ctrl = true
    else if (e.key === 'Shift') heldModsRef.current.shift = true
    else if (e.key === 'Alt')   heldModsRef.current.alt  = true
    else if (e.key === 'Meta')  heldModsRef.current.meta = true
    sendInput({
      type: 'keydown', key: e.key, code: e.code,
      modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    })
  }, [dataChannel])

  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === 'Control') heldModsRef.current.ctrl = false
    else if (e.key === 'Shift') heldModsRef.current.shift = false
    else if (e.key === 'Alt')   heldModsRef.current.alt  = false
    else if (e.key === 'Meta')  heldModsRef.current.meta = false
    sendInput({
      type: 'keyup', key: e.key, code: e.code,
      modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
    })
  }, [dataChannel])

  const onMouseLeave = useCallback((e: React.MouseEvent) => {
    if (e.buttons !== 0) {
      const { x, y } = toRemote(e)
      const button = e.buttons === 2 ? 'right' : e.buttons === 4 ? 'middle' : 'left'
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
    </div>
  )
}
