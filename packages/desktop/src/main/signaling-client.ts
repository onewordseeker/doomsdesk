import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface SignalingMessage {
  type: string
  [key: string]: unknown
}

export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string
  private deviceId: string
  private permanentPassword: string
  private randomPassword: string
  private connected: boolean = false

  constructor(url: string, deviceId: string, permanentPassword: string) {
    super()
    this.url = url
    this.deviceId = deviceId
    this.permanentPassword = permanentPassword
    // Generate a fresh random 6-digit session password
    this.randomPassword = String(Math.floor(100000 + Math.random() * 900000))
  }

  connect(): void {
    if (this.ws) return
    console.log(`[signaling] Connecting to ${this.url}`)
    this.ws = new WebSocket(this.url)

    this.ws.on('open', () => {
      this.connected = true
      console.log('[signaling] Connected')
      this.send({
        type: 'register',
        deviceId: this.deviceId,
        permanentPassword: this.permanentPassword || undefined,
        randomPassword: this.randomPassword,
      })
    })

    this.ws.on('message', (data) => {
      try {
        const msg: SignalingMessage = JSON.parse(data.toString())
        if (msg.type === 'registered') {
          this.randomPassword = msg.randomPassword as string
          console.log(`[signaling] Registered — random pw: ${this.randomPassword}`)
        }
        this.emit('message', msg)
      } catch {
        console.warn('[signaling] Bad message:', data.toString().slice(0, 100))
      }
    })

    this.ws.on('close', () => {
      this.connected = false
      this.ws = null
      this.emit('disconnected')
      console.log('[signaling] Disconnected — retrying in 5s')
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    })

    this.ws.on('error', (err) => {
      console.error('[signaling] Error:', err.message)
    })
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  send(msg: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  getRandomPassword(): string {
    return this.randomPassword
  }

  isConnected(): boolean {
    return this.connected
  }

  updatePermanentPassword(pw: string): void {
    this.permanentPassword = pw
    if (this.connected) {
      this.send({
        type: 'register',
        deviceId: this.deviceId,
        permanentPassword: pw || undefined,
        randomPassword: this.randomPassword,
      })
    }
  }
}
