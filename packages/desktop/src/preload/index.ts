import { contextBridge, ipcRenderer } from 'electron'

// Typed IPC bridge — exposed as window.dd in renderer
const api = {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (partial: Record<string, unknown>) => ipcRenderer.invoke('set-config', partial),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  getRandomPassword: () => ipcRenderer.invoke('get-random-password'),
  isServerConnected: () => ipcRenderer.invoke('is-server-connected'),

  // Screen capture
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Input injection (agent side)
  injectInput: (event: unknown) => ipcRenderer.send('inject-input', event),

  // Signaling
  sendSignaling: (msg: unknown) => ipcRenderer.send('send-signaling', msg),
  onSignalingMessage: (cb: (msg: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, msg: unknown) => cb(msg)
    ipcRenderer.on('signaling-message', handler)
    return () => ipcRenderer.removeListener('signaling-message', handler)
  },

  // Connection
  connectToPeer: (targetId: string, password: string) =>
    ipcRenderer.invoke('connect-to-peer', targetId, password),
  respondToConnection: (sourceId: string, approved: boolean) =>
    ipcRenderer.invoke('respond-to-connection', sourceId, approved),
  showApprovalDialog: (sourceId: string) =>
    ipcRenderer.invoke('show-approval-dialog', sourceId),

  // Session window
  openSessionWindow: (peerId: string, role: 'controller' | 'agent') =>
    ipcRenderer.send('open-session-window', { peerId, role }),
  closeSessionWindow: () => ipcRenderer.send('close-session-window'),
  toggleFullscreen: () => ipcRenderer.send('session-fullscreen-toggle'),

  // Events from main
  onStartSession: (cb: (data: { peerId: string; role: 'controller' | 'agent' }) => void) => {
    const h = (_: Electron.IpcRendererEvent, data: unknown) => cb(data as { peerId: string; role: 'controller' | 'agent' })
    ipcRenderer.on('start-session', h)
    return () => ipcRenderer.removeListener('start-session', h)
  },
  onSessionEnded: (cb: () => void) => {
    ipcRenderer.on('session-ended', cb)
    return () => ipcRenderer.removeListener('session-ended', cb)
  },
  onDeepLinkConnect: (cb: (deviceId: string) => void) => {
    const h = (_: Electron.IpcRendererEvent, id: string) => cb(id)
    ipcRenderer.on('deep-link-connect', h)
    return () => ipcRenderer.removeListener('deep-link-connect', h)
  },
  onServerDisconnected: (cb: () => void) => {
    ipcRenderer.on('server-disconnected', cb)
    return () => ipcRenderer.removeListener('server-disconnected', cb)
  },

  // Signal main process that Session component is mounted and ready
  sessionReady: () => ipcRenderer.send('session-renderer-ready'),

  // Agent reports errors back to main (shown as dialog since agent window is hidden)
  reportAgentError: (msg: string) => ipcRenderer.send('agent-error', msg),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
}

contextBridge.exposeInMainWorld('dd', api)

declare global {
  interface Window { dd: typeof api }
}
