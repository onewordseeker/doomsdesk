import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Copy, Eye, EyeOff, RefreshCw, Settings, Globe, Wifi, WifiOff } from 'lucide-react'
import appIcon from '../assets/icon.png'

export default function Home() {
  const [deviceId, setDeviceId] = useState('---')
  const [randomPw, setRandomPw] = useState('------')
  const [permPw, setPermPw] = useState('')
  const [showPermPw, setShowPermPw] = useState(false)
  const [serverOnline, setServerOnline] = useState(false)
  const [connectId, setConnectId] = useState('')
  const [connectPw, setConnectPw] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<'id' | 'pw' | null>(null)
  const [activeTab, setActiveTab] = useState<'control' | 'receive'>('control')
  const [showSettings, setShowSettings] = useState(false)
  const [incomingConn, setIncomingConn] = useState<{ sourceId: string } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    load()
    pollRef.current = setInterval(load, 3000)

    const unsubSignal = listen<{ type: string; reason?: string; approved?: boolean; sourceId?: string }>(
      'signaling-message',
      (e) => {
        const msg = e.payload
        if (msg.type === 'connect_result' && !msg.approved) {
          setConnecting(false)
          setConnectError(msg.reason ?? 'Connection refused')
        }
        if (msg.type === 'incoming' && msg.sourceId) {
          setIncomingConn({ sourceId: msg.sourceId })
        }
      }
    )

    return () => {
      clearInterval(pollRef.current)
      unsubSignal.then((f) => f())
    }
  }, [])

  async function load() {
    const [id, pw, online, config] = await Promise.all([
      invoke<string>('get_device_id'),
      invoke<string>('get_random_password'),
      invoke<boolean>('is_server_connected'),
      invoke<{ permanentPassword: string }>('get_config'),
    ])
    setDeviceId(id)
    if (pw) setRandomPw(pw)
    setServerOnline(online)
    setPermPw(config.permanentPassword ?? '')
  }

  function formatId(id: string) {
    return id.replace(/-/g, ' ').replace(/(\d{3}) (\d{3}) (\d{3})/, '$1 $2 $3')
  }

  function copy(text: string, type: 'id' | 'pw') {
    navigator.clipboard.writeText(text)
    setCopyFeedback(type)
    setTimeout(() => setCopyFeedback(null), 1500)
  }

  async function handleConnect() {
    if (!connectId.trim()) return
    setConnecting(true)
    setConnectError('')
    // Normalize: strip non-digits, reformat as XXX-XXX-XXX to match server key
    const digits = connectId.replace(/\D/g, '')
    const cleanId =
      digits.length === 9
        ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`
        : digits
    await invoke('connect_to_peer', { targetId: cleanId, password: connectPw })
    setTimeout(() => setConnecting(false), 8000)
  }

  async function savePermPw() {
    await invoke('set_config', { partial: { permanentPassword: permPw } })
  }

  async function handleApprove(approved: boolean) {
    if (!incomingConn) return
    await invoke('respond_to_connection', { sourceId: incomingConn.sourceId, approved })
    setIncomingConn(null)
    if (approved) {
      // Start input worker so incoming controller can inject input
      await invoke('start_input_worker')
    }
  }

  return (
    <div className="flex flex-col h-screen bg-bg select-none">
      {/* Title bar */}
      <div className="drag-region flex items-center justify-between px-4 h-11 border-b border-surface-border shrink-0">
        <div className="flex items-center gap-2.5">
          <img src={appIcon} className="w-6 h-6 rounded-full" alt="DoomsDesk" />
          <span className="text-sm font-semibold tracking-wide text-white">DoomsDesk</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {serverOnline ? (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <Wifi size={12} /> Online
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-slate-500">
              <WifiOff size={12} /> Offline
            </span>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-surface transition-colors"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — My Device */}
        <div className="w-64 border-r border-surface-border flex flex-col p-5 gap-4 shrink-0">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-3 font-medium">Your Device ID</p>
            <div className="bg-surface rounded-xl p-4 border border-surface-border">
              <div className="flex items-center justify-between mb-1">
                <span className="text-2xl font-mono font-bold tracking-widest text-white">
                  {formatId(deviceId)}
                </span>
              </div>
              <button
                onClick={() => copy(deviceId.replace(/-/g, ''), 'id')}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand transition-colors mt-2"
              >
                <Copy size={11} />
                {copyFeedback === 'id' ? 'Copied!' : 'Copy ID'}
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-3 font-medium">Session Password</p>
            <div className="bg-surface rounded-xl p-4 border border-surface-border">
              <div className="font-mono text-xl font-bold tracking-widest text-white mb-1">
                {randomPw || '------'}
              </div>
              <p className="text-xs text-slate-500 mb-2">Valid for this session only</p>
              <button
                onClick={() => copy(randomPw, 'pw')}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand transition-colors"
              >
                <Copy size={11} />
                {copyFeedback === 'pw' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-3 font-medium">Permanent Password</p>
            <div className="relative">
              <input
                type={showPermPw ? 'text' : 'password'}
                value={permPw}
                onChange={(e) => setPermPw(e.target.value)}
                onBlur={savePermPw}
                placeholder="Set a permanent password"
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-white pr-8 focus:outline-none focus:border-brand transition-colors"
              />
              <button
                onClick={() => setShowPermPw(!showPermPw)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              >
                {showPermPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-xs text-slate-600 mt-1.5">Allow connections without approval</p>
          </div>

          {/* Open web console */}
          <button
            onClick={() => invoke('open_external', { url: 'https://doomsdesk.hamidentifier.cloud' })}
            className="mt-auto flex items-center gap-2 text-xs text-slate-500 hover:text-brand transition-colors"
          >
            <Globe size={12} />
            Open web console
          </button>
        </div>

        {/* Right panel — Connect */}
        <div className="flex-1 flex flex-col">
          {/* Tabs */}
          <div className="flex border-b border-surface-border px-5 pt-4 gap-0 shrink-0">
            {(['control', 'receive'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab
                    ? 'border-brand text-white'
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {tab === 'control' ? 'Control Remote' : 'Receive Help'}
              </button>
            ))}
          </div>

          <div className="flex-1 flex items-center justify-center p-8">
            {activeTab === 'control' ? (
              <div className="w-full max-w-sm">
                <h2 className="text-lg font-semibold text-white mb-1">Connect to Remote Device</h2>
                <p className="text-sm text-slate-500 mb-6">Enter the ID of the device you want to control</p>

                <div className="space-y-3">
                  <input
                    type="text"
                    value={connectId}
                    onChange={(e) => setConnectId(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    placeholder="Device ID  (e.g. 123 456 789)"
                    className="w-full bg-surface border border-surface-border rounded-xl px-4 py-3 text-white font-mono text-lg tracking-wider placeholder:text-slate-600 focus:outline-none focus:border-brand transition-colors"
                  />
                  <input
                    type="password"
                    value={connectPw}
                    onChange={(e) => setConnectPw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    placeholder="Password (optional)"
                    className="w-full bg-surface border border-surface-border rounded-xl px-4 py-3 text-white placeholder:text-slate-600 focus:outline-none focus:border-brand transition-colors"
                  />
                  <button
                    onClick={handleConnect}
                    disabled={connecting || !connectId.trim() || !serverOnline}
                    className="w-full bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2"
                  >
                    {connecting ? (
                      <>
                        <RefreshCw size={16} className="animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      'Connect'
                    )}
                  </button>
                  {connectError && (
                    <p className="text-xs text-center text-red-400">{connectError}</p>
                  )}
                  {!serverOnline && (
                    <p className="text-xs text-center text-amber-500">
                      Not connected to server — make sure the server is running
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center">
                <div className="w-20 h-20 rounded-2xl bg-surface border border-surface-border flex items-center justify-center mx-auto mb-6">
                  <img src={appIcon} className="w-12 h-12 rounded-full" alt="DoomsDesk" />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Ready to Receive</h2>
                <p className="text-sm text-slate-500 max-w-xs mx-auto">
                  Share your{' '}
                  <span className="text-white font-mono">{formatId(deviceId)}</span> and password
                  with the person helping you. They can then connect to your device.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Settings overlay */}
      {showSettings && <SettingsOverlay onClose={() => setShowSettings(false)} />}

      {/* Incoming connection modal */}
      {incomingConn && (
        <IncomingConnectionModal
          sourceId={incomingConn.sourceId}
          onApprove={handleApprove}
        />
      )}
    </div>
  )
}

function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const [config, setConfigState] = useState<Record<string, unknown>>({})
  const [serverUrl, setServerUrl] = useState('')

  useEffect(() => {
    invoke<Record<string, unknown>>('get_config').then((c) => {
      setConfigState(c)
      setServerUrl(c.serverUrl as string)
    })
  }, [])

  async function save() {
    await invoke('set_config', { partial: { serverUrl } })
    onClose()
  }

  return (
    <div
      className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-surface-border rounded-2xl p-6 w-96 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-white mb-4">Settings</h3>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Server URL</label>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="w-full bg-bg border border-surface-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand"
            />
          </div>
          <p className="text-xs text-slate-600">
            Device ID:{' '}
            <span className="text-slate-400 font-mono">{config.deviceId as string}</span>
          </p>
          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-surface-border text-slate-400 text-sm hover:border-slate-500 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="flex-1 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function IncomingConnectionModal({
  sourceId,
  onApprove,
}: {
  sourceId: string
  onApprove: (approved: boolean) => void
}) {
  return (
    <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface border border-surface-border rounded-2xl p-6 w-80 shadow-2xl">
        <h3 className="text-base font-semibold text-white mb-2">Incoming Connection</h3>
        <p className="text-sm text-slate-400 mb-5">
          Device <span className="font-mono text-white">{sourceId}</span> wants to control this
          computer.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => onApprove(false)}
            className="flex-1 py-2 rounded-lg border border-surface-border text-slate-400 text-sm hover:border-slate-500 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => onApprove(true)}
            className="flex-1 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
