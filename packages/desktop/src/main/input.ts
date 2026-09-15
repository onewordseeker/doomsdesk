import { spawn, ChildProcess } from 'child_process'
import { execSync } from 'child_process'
import { platform } from 'os'
import { join } from 'path'
import { app } from 'electron'

export interface InputEvent {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'click' | 'keydown' | 'keyup' | 'wheel' | 'clipboard'
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  key?: string
  code?: string
  deltaX?: number
  deltaY?: number
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
  text?: string
}

const IS_MAC = platform() === 'darwin'
const IS_WIN = platform() === 'win32'

let worker: ChildProcess | null = null
let workerReady = false
const queue: string[] = []

function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, '../../resources', name)
}

function findPython3(): string {
  const candidates = [
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
    'python3',
  ]
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 2000 }); return p } catch {}
  }
  return 'python3'
}

function spawnWorker(): ChildProcess | null {
  try {
    if (IS_MAC) {
      const script = resourcePath('input-worker.py')
      const py = findPython3()
      console.log(`[input] spawning Python3 worker: ${py} ${script}`)
      return spawn(py, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    }
    if (IS_WIN) {
      const script = resourcePath('input-worker.ps1')
      console.log(`[input] spawning PowerShell worker: ${script}`)
      return spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
    }
  } catch (err) {
    console.error('[input] failed to spawn worker:', err)
  }
  return null
}

function ensureWorker(): void {
  if (worker) return

  worker = spawnWorker()
  if (!worker) return

  worker.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes('READY')) {
      console.log('[input] worker ready — flushing', queue.length, 'queued events')
      workerReady = true
      for (const line of queue) worker?.stdin?.write(line)
      queue.length = 0
    }
  })

  worker.stderr?.on('data', (d: Buffer) =>
    console.warn('[input-worker stderr]', d.toString().slice(0, 300))
  )

  worker.on('exit', (code) => {
    console.log('[input] worker exited, code:', code)
    worker = null
    workerReady = false
  })

  worker.on('error', (err) => {
    console.error('[input] worker error:', err.message)
    worker = null
    workerReady = false
  })
}

export function startInputWorker(): void {
  ensureWorker()
}

export function stopInputWorker(): void {
  if (worker) {
    worker.kill()
    worker = null
    workerReady = false
    queue.length = 0
  }
}

export async function injectInput(event: InputEvent): Promise<void> {
  if (!IS_MAC && !IS_WIN) return
  ensureWorker()
  if (!worker) return

  const line = JSON.stringify(event) + '\n'
  if (workerReady) {
    worker.stdin?.write(line)
  } else {
    queue.push(line)
  }
}
