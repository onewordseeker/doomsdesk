import {
  app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut,
  systemPreferences, dialog, shell, Tray, Menu, nativeImage, screen
} from 'electron'

// Chromium flags — must be set before app.ready
// Reduce renderer memory footprint and disable features we don't use
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,HeavyAdIntervention,BackForwardCache')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --optimize-for-size')
app.commandLine.appendSwitch('disable-http-cache')
// Prefer hardware video decode/encode — reduces CPU and memory vs software codecs
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,WebRtcHideLocalIpsWithMdns')
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Video-BalancedDegradation/Enabled/')
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { SignalingClient } from './signaling-client'
import { injectInput, startInputWorker, stopInputWorker, InputEvent } from './input'
import { getConfig, setConfig, getDeviceId, getPermanentPassword } from './config'

// ── Crash logging ──────────────────────────────────────────────────────────────

function crashLog(msg: string): void {
  try {
    const dir = join(app.getPath('logs'), 'DoomsDesk')
    mkdirSync(dir, { recursive: true })
    const line = `[${new Date().toISOString()}] ${msg}\n`
    writeFileSync(join(dir, 'crash.log'), line, { flag: 'a' })
    console.error(line.trim())
  } catch { /* ignore */ }
}

process.on('uncaughtException', (err) => {
  crashLog(`uncaughtException: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  crashLog(`unhandledRejection: ${String(reason)}`)
})

// ── State ──────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let sessionWindow: BrowserWindow | null = null
let sessionWindowReady = false
const pendingSessionMessages: object[] = []
let tray: Tray | null = null
let signalingClient: SignalingClient | null = null

const activeSessions = new Map<string, { role: 'controller' | 'agent'; peerId: string }>()

// ── App setup ──────────────────────────────────────────────────────────────────

// Register deep link protocol: doomsdesk://
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('doomsdesk', process.execPath, [process.argv[1]])
  }
} else {
  app.setAsDefaultProtocolClient('doomsdesk')
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', (_event, argv) => {
  handleDeepLink(argv.find((a) => a.startsWith('doomsdesk://')) ?? '')
  mainWindow?.show()
})

app.on('open-url', (_event, url) => {
  handleDeepLink(url)
})

// ── Window creation ────────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0F1117',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // needed for desktopCapturer in renderer
    },
  })

  win.once('ready-to-show', () => {
    const { startMinimized } = getConfig()
    if (!startMinimized) win.show()
  })

  win.on('close', (e) => {
    if (tray) {
      e.preventDefault()
      win.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function startControllerSession(peerId: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  sessionWindowReady = false
  sessionWindow = mainWindow  // Route signaling to main window

  // Expand to full session dimensions
  mainWindow.setMinimumSize(800, 600)
  mainWindow.setSize(1280, 800, true)
  mainWindow.show()

  // Main window is already loaded — just wait for Session component to mount
  ipcMain.once('session-renderer-ready', () => {
    console.log(`[main] session renderer ready — flushing ${pendingSessionMessages.length} buffered messages`)
    sessionWindowReady = true
    for (const m of pendingSessionMessages) mainWindow?.webContents.send('signaling-message', m)
    pendingSessionMessages.length = 0
  })

  mainWindow.webContents.send('start-session', { peerId, role: 'controller' })
}

function createSessionWindow(peerId: string, role: 'controller' | 'agent'): BrowserWindow {
  // Only agent sessions get a separate floating window.
  // Controller sessions are handled in the main window via startControllerSession().
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize
  const bw = 400
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: bw,
    height: 58,
    x: Math.floor((sw - bw) / 2),
    y: 8,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    backgroundColor: '#111827',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  }

  const win = new BrowserWindow({ show: false, ...winOpts })

  // Hide the main window behind the agent banner
  mainWindow?.hide()

  win.loadFile(join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => win.show())

  sessionWindowReady = false

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => win.webContents.send('start-session', { peerId, role }), 250)
  })

  ipcMain.once('session-renderer-ready', () => {
    console.log(`[main] session renderer ready — flushing ${pendingSessionMessages.length} buffered messages`)
    sessionWindowReady = true
    for (const m of pendingSessionMessages) win.webContents.send('signaling-message', m)
    pendingSessionMessages.length = 0
  })

  win.on('closed', () => {
    sessionWindow = null
    sessionWindowReady = false
    pendingSessionMessages.length = 0
    signalingClient?.send({ type: 'disconnect', targetId: peerId })
    activeSessions.delete(peerId)
    updateTrayForSession(false, '')
    unregisterSessionShortcut()
    stopInputWorker()
    mainWindow?.show()
    mainWindow?.webContents.send('session-ended')
  })

  return win
}

// ── Session helpers ───────────────────────────────────────────────────────────

function endSession(): void {
  if (sessionWindow === mainWindow) {
    // Controller session lives inside the main window — navigate back, don't close
    sessionWindow = null
    sessionWindowReady = false
    pendingSessionMessages.length = 0
    unregisterSessionShortcut()
    stopInputWorker()
    mainWindow?.webContents.send('session-ended')
  } else {
    // Agent banner window — close it (the closed handler does the cleanup)
    sessionWindow?.close()
    mainWindow?.webContents.send('session-ended')
  }
}

function registerSessionShortcut(): void {
  try {
    // Ctrl+Shift+Q (or Cmd+Shift+Q on Mac) force-ends the session from any app
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
      console.log('[shortcut] force-ending session')
      endSession()
    })
  } catch {/* non-fatal */}
}

function unregisterSessionShortcut(): void {
  try { globalShortcut.unregister('CommandOrControl+Shift+Q') } catch {}
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray(): Tray | null {
  try {
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png'
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, iconFile)
      : join(__dirname, '../../resources', iconFile)
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.warn('[tray] icon empty, skipping tray')
      return null
    }
    const t = new Tray(icon)
    t.setToolTip('DoomsDesk')
    t.setContextMenu(buildTrayMenu(false, ''))
    t.on('double-click', () => mainWindow?.show())
    return t
  } catch (err) {
    console.warn('[tray] failed to create:', err)
    return null
  }
}

function buildTrayMenu(sharing: boolean, peerId: string): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = sharing
    ? [
        { label: `Sharing screen with ${peerId}`, enabled: false },
        { label: 'Stop sharing', click: () => { sessionWindow?.close() } },
        { type: 'separator' },
      ]
    : [
        { label: 'Open DoomsDesk', click: () => mainWindow?.show() },
        { type: 'separator' },
      ]
  items.push({ label: 'Quit', click: () => { tray = null; app.quit() } })
  return Menu.buildFromTemplate(items)
}

function updateTrayForSession(sharing: boolean, peerId: string): void {
  if (!tray) return
  tray.setToolTip(sharing ? `DoomsDesk — sharing screen with ${peerId}` : 'DoomsDesk')
  tray.setContextMenu(buildTrayMenu(sharing, peerId))
}

// ── Deep link handling ────────────────────────────────────────────────────────

function handleDeepLink(url: string): void {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'connect') {
      const id = parsed.searchParams.get('id')
      if (id) mainWindow?.webContents.send('deep-link-connect', id)
    }
  } catch {
    /* ignore */
  }
}

// ── macOS permissions ─────────────────────────────────────────────────────────

async function requestMacPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return
  // Accessibility is needed for mouse/keyboard injection on the agent side
  const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false)
  if (!accessibilityGranted) {
    console.log('[permissions] Accessibility not granted — input injection will be limited')
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {

  // Config
  ipcMain.handle('get-config', () => getConfig())
  ipcMain.handle('set-config', (_e, partial) => {
    setConfig(partial)
    if ('permanentPassword' in partial) {
      signalingClient?.updatePermanentPassword(partial.permanentPassword as string)
    }
  })
  ipcMain.handle('get-device-id', () => getDeviceId())
  ipcMain.handle('get-random-password', () => signalingClient?.getRandomPassword() ?? '')
  ipcMain.handle('is-server-connected', () => signalingClient?.isConnected() ?? false)

  // Screen capture sources
  ipcMain.handle('get-screen-sources', async () => {
    // NOTE: do NOT pre-check systemPreferences.getMediaAccessStatus('screen') —
    // it returns wrong values for unsigned apps on macOS and blocks valid captures.
    // Let desktopCapturer.getSources() itself fail if permission is truly missing.
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 },
      })
      if (sources.length === 0) {
        throw new Error(
          'No screens found. On macOS go to System Settings → Privacy & Security → Screen Recording and enable DoomsDesk, then restart the app.'
        )
      }
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // If it's the "no screens" error we threw, re-throw as-is
      if (msg.startsWith('No screens found')) throw err
      // Otherwise it's a system-level failure — open Settings and re-throw with context
      if (process.platform === 'darwin') {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      }
      throw new Error(`Screen capture failed: ${msg}\n\nOn macOS: System Settings → Privacy & Security → Screen Recording → enable DoomsDesk → restart app.`)
    }
  })

  // Input injection (agent receives remote input)
  ipcMain.on('inject-input', (_e, event: InputEvent) => {
    injectInput(event).catch((err) =>
      console.warn('[input] inject failed:', err.message)
    )
  })

  // Signaling passthrough: renderer → main → WS server
  ipcMain.on('send-signaling', (_e, msg) => {
    signalingClient?.send(msg)
  })

  // Controller initiates connection
  ipcMain.handle('connect-to-peer', async (_e, targetId: string, password: string) => {
    signalingClient?.send({ type: 'connect', targetId, password })
    return { ok: true }
  })

  // Agent: approve/reject incoming connection
  ipcMain.handle('respond-to-connection', (_e, sourceId: string, approved: boolean) => {
    signalingClient?.send({ type: 'approve', targetId: sourceId, approved })
  })

  // Window controls
  ipcMain.on('open-session-window', (_e, { peerId, role }) => {
    if (!sessionWindow) {
      if (role === 'controller') {
        startControllerSession(peerId)
      } else {
        sessionWindow = createSessionWindow(peerId, role)
      }
    }
  })

  ipcMain.on('close-session-window', () => {
    endSession()
  })

  ipcMain.on('session-fullscreen-toggle', () => {
    if (sessionWindow) {
      sessionWindow.setFullScreen(!sessionWindow.isFullScreen())
    }
  })

  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

  // Agent (hidden window) reports errors → show as dialog so user can see what went wrong
  ipcMain.on('agent-error', (_e, msg: string) => {
    console.error('[agent-error]', msg)
    dialog.showErrorBox('Screen sharing failed', msg)
  })

  // Approval dialog for incoming connections (shown on agent side)
  ipcMain.handle('show-approval-dialog', async (_e, sourceId: string) => {
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      title: 'Incoming Connection',
      message: `Device ${sourceId} wants to control this computer`,
      detail: 'Do you want to allow this connection?',
    })
    return result.response === 0 // 0 = Allow
  })
}

// ── Signaling message routing ─────────────────────────────────────────────────

function setupSignalingRouting(): void {
  if (!signalingClient) return

  signalingClient.on('message', async (msg: { type: string; [k: string]: unknown }) => {
    // Route WebRTC signaling messages to the session window (buffered until ready)
    const isSignaling = ['offer', 'answer', 'ice'].includes(msg.type)
    if (isSignaling) {
      console.log(`[main] signaling ${msg.type} → sessionWindow=${!!sessionWindow} ready=${sessionWindowReady}`)
      if (sessionWindow && !sessionWindow.isDestroyed()) {
        if (sessionWindowReady) {
          sessionWindow.webContents.send('signaling-message', msg)
        } else {
          pendingSessionMessages.push(msg)
          console.log(`[main] buffered ${msg.type} (window not ready yet)`)
        }
      } else {
        console.warn(`[main] no session window to deliver ${msg.type}`)
      }
      return
    }

    // Non-WebRTC messages go to the main window too
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('signaling-message', msg)
    }

    switch (msg.type) {
      case 'incoming': {
        // No-password path: show approval dialog in main window, then send approve/deny
        const sourceId = msg.sourceId as string
        const result = await dialog.showMessageBox(mainWindow!, {
          type: 'question',
          buttons: ['Allow', 'Deny'],
          defaultId: 0,
          cancelId: 1,
          title: 'Incoming Connection',
          message: `Device ${sourceId} wants to control this computer`,
          detail: 'Do you want to allow this connection?',
        })
        const approved = result.response === 0
        signalingClient?.send({ type: 'approve', targetId: sourceId, approved })
        // Agent session window opens when we receive 'session_started'
        break
      }

      case 'session_started': {
        const controllerId = msg.controllerId as string
        console.log(`[main] session_started — agent session for controller ${controllerId}`)
        activeSessions.set(controllerId, { role: 'agent', peerId: controllerId })
        if (!sessionWindow) sessionWindow = createSessionWindow(controllerId, 'agent')
        updateTrayForSession(true, controllerId)
        startInputWorker()
        registerSessionShortcut()
        break
      }

      case 'connect_result': {
        const approved = msg.approved as boolean
        const peerId = msg.peerId as string
        if (approved && peerId) {
          console.log(`[main] connect_result approved — controller session for agent ${peerId}`)
          activeSessions.set(peerId, { role: 'controller', peerId })
          // Controller sessions live inside the main window — no new window needed
          if (!sessionWindow) startControllerSession(peerId)
          registerSessionShortcut()
        } else if (!approved) {
          mainWindow?.webContents.send('connect-rejected', { reason: msg.reason })
        }
        break
      }

      case 'peer_disconnected': {
        endSession()
        break
      }
    }
  })

  signalingClient.on('disconnected', () => {
    mainWindow?.webContents.send('server-disconnected')
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await requestMacPermissions()
  registerIpcHandlers()

  mainWindow = createMainWindow()

  try {
    tray = createTray()
  } catch (err) {
    console.warn('[main] tray creation failed (non-fatal):', err)
  }

  try {
    const cfg = getConfig()
    signalingClient = new SignalingClient(cfg.serverUrl, getDeviceId(), getPermanentPassword())
    setupSignalingRouting()
    signalingClient.connect()
  } catch (err) {
    console.error('[main] signaling init failed:', err)
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow()
    } else {
      mainWindow.show()
    }
  })
}).catch((err) => {
  console.error('[main] app.whenReady failed:', err)
  dialog.showErrorBox('DoomsDesk failed to start', String(err))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  signalingClient?.disconnect()
})
