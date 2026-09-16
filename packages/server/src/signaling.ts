import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import {
  getDeviceByDeviceId,
  touchDeviceLastSeen,
  createSession,
  endSession,
  createAuditLog,
} from './db.js';
import { wsConnectLimiter } from './ratelimit.js';

// ---------------------------------------------------------------------------
// Message type definitions (Client → Server)
// ---------------------------------------------------------------------------

interface MsgRegister   { type: 'register';    deviceId: string; permanentPassword?: string; randomPassword?: string }
interface MsgConnect    { type: 'connect';     targetId: string; password?: string }
interface MsgApprove    { type: 'approve';     targetId: string; approved: boolean }
interface MsgOffer      { type: 'offer';       targetId: string; sdp: string }
interface MsgAnswer     { type: 'answer';      targetId: string; sdp: string }
interface MsgIce        { type: 'ice';         targetId: string; candidate: object }
interface MsgDisconnect { type: 'disconnect';  targetId: string }
interface MsgPing       { type: 'ping' }

type ClientMessage =
  | MsgRegister
  | MsgConnect
  | MsgApprove
  | MsgOffer
  | MsgAnswer
  | MsgIce
  | MsgDisconnect
  | MsgPing;

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface PeerState {
  deviceId: string;
  /** deviceId of the peer this socket is currently talking to (if any) */
  peerId: string | null;
  /** active session id for the current peer link */
  sessionId: string | null;
  /** hashed permanent password sent on register (for in-memory validation) */
  permanentPasswordHash: string | null;
  /** plain random/session password sent on register */
  randomPassword: string;
  /** remote IP address of this WebSocket connection */
  remoteIp: string;
}

// ---------------------------------------------------------------------------
// Signaling server
// ---------------------------------------------------------------------------

export class SignalingServer {
  private wss: WebSocketServer;

  /** deviceId → WebSocket (only registered, live sockets) */
  private online = new Map<string, WebSocket>();

  /** WebSocket → PeerState (all connected sockets) */
  private state = new WeakMap<WebSocket, PeerState>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    console.log(`[signaling] WebSocket server listening on port ${port}`);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteIp =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';

    const state: PeerState = {
      deviceId: '',
      peerId: null,
      sessionId: null,
      permanentPasswordHash: null,
      randomPassword: '',
      remoteIp,
    };
    this.state.set(ws, state);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        this.handleMessage(ws, state, msg);
      } catch {
        this.send(ws, { type: 'error', message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => this.onClose(ws, state));
    ws.on('error', (err) => {
      console.error(`[signaling] ws error (${state.deviceId}):`, err.message);
    });
  }

  private onClose(ws: WebSocket, state: PeerState): void {
    if (state.deviceId) {
      this.online.delete(state.deviceId);
      console.log(`[signaling] device offline: ${state.deviceId}`);
      createAuditLog(
        null,
        state.deviceId,
        'device_disconnected',
        'device',
        undefined,
        state.remoteIp
      );
    }

    // End active session and notify peer
    if (state.peerId && state.sessionId) {
      endSession(state.sessionId);
      createAuditLog(
        null,
        state.deviceId,
        'session_ended',
        'session',
        `sessionId=${state.sessionId} peer=${state.peerId}`,
        state.remoteIp
      );
      const peerWs = this.online.get(state.peerId);
      if (peerWs) {
        this.send(peerWs, { type: 'peer_disconnected' });
        const peerState = this.state.get(peerWs);
        if (peerState) {
          peerState.peerId = null;
          peerState.sessionId = null;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message dispatcher
  // -------------------------------------------------------------------------

  private handleMessage(ws: WebSocket, state: PeerState, msg: ClientMessage): void {
    switch (msg.type) {
      case 'register':    return this.onRegister(ws, state, msg);
      case 'connect':     return this.onConnect(ws, state, msg);
      case 'approve':     return this.onApprove(ws, state, msg);
      case 'offer':       return this.onOffer(ws, state, msg);
      case 'answer':      return this.onAnswer(ws, state, msg);
      case 'ice':         return this.onIce(ws, state, msg);
      case 'disconnect':  return this.onDisconnect(ws, state, msg);
      case 'ping':        return this.send(ws, { type: 'pong' });
      default:
        this.send(ws, { type: 'error', message: `Unknown message type` });
    }
  }

  // -------------------------------------------------------------------------
  // Handler: register
  // -------------------------------------------------------------------------

  private onRegister(ws: WebSocket, state: PeerState, msg: MsgRegister): void {
    const { deviceId } = msg;

    if (!deviceId || typeof deviceId !== 'string') {
      return this.send(ws, { type: 'error', message: 'deviceId is required' });
    }

    // Kick any existing socket for this deviceId (device reconnected)
    const existing = this.online.get(deviceId);
    if (existing && existing !== ws) {
      this.send(existing, { type: 'error', message: 'Replaced by new connection' });
      existing.close();
    }

    state.deviceId = deviceId;
    state.randomPassword = msg.randomPassword ?? '';
    state.permanentPasswordHash = msg.permanentPassword
      ? bcrypt.hashSync(msg.permanentPassword, 10)
      : null;
    this.online.set(deviceId, ws);
    touchDeviceLastSeen(deviceId);

    console.log(`[signaling] device online: ${deviceId}`);
    createAuditLog(
      null,
      deviceId,
      'device_connected',
      'device',
      undefined,
      state.remoteIp
    );
    this.send(ws, { type: 'registered', deviceId, randomPassword: state.randomPassword });
  }

  // -------------------------------------------------------------------------
  // Handler: connect (controller requests access to agent)
  // -------------------------------------------------------------------------

  private onConnect(ws: WebSocket, state: PeerState, msg: MsgConnect): void {
    if (!state.deviceId) {
      return this.send(ws, { type: 'error', message: 'Not registered' });
    }

    // Rate-limit connection attempts: 5 per minute per source device
    const rateLimitKey = `connect:${state.deviceId}`;
    if (!wsConnectLimiter.check(rateLimitKey, 5, 60_000)) {
      const retryMs = wsConnectLimiter.retryAfterMs(rateLimitKey);
      return this.send(ws, {
        type: 'error',
        message: `Too many connection attempts. Retry in ${Math.ceil(retryMs / 1000)}s.`,
      });
    }

    const targetWs = this.online.get(msg.targetId);
    if (!targetWs) {
      return this.send(ws, {
        type: 'connect_result',
        approved: false,
        reason: 'Target device is offline',
      });
    }

    const agentState = this.state.get(targetWs)!;

    if (msg.password) {
      // Try random (session) password first
      if (agentState.randomPassword && agentState.randomPassword === msg.password) {
        return this.establishSession(ws, state, targetWs, msg.targetId);
      }
      // Try in-memory permanent password hash (set via app)
      if (agentState.permanentPasswordHash && bcrypt.compareSync(msg.password, agentState.permanentPasswordHash)) {
        return this.establishSession(ws, state, targetWs, msg.targetId);
      }
      // Try DB permanent password (set via web console)
      const dbDevice = getDeviceByDeviceId(msg.targetId);
      if (dbDevice?.permanent_password_hash && bcrypt.compareSync(msg.password, dbDevice.permanent_password_hash)) {
        return this.establishSession(ws, state, targetWs, msg.targetId);
      }
      // Wrong password — log auth failure
      createAuditLog(
        null,
        state.deviceId,
        'auth_failed',
        `device:${msg.targetId}`,
        'Incorrect password on connect attempt',
        state.remoteIp
      );
      return this.send(ws, { type: 'connect_result', approved: false, reason: 'Incorrect password' });
    }

    // No password: forward approval request to agent
    this.send(targetWs, { type: 'incoming', sourceId: state.deviceId });
    // Controller waits — agent will respond with `approve`
  }

  // -------------------------------------------------------------------------
  // Handler: approve (agent accepts or rejects the incoming request)
  // -------------------------------------------------------------------------

  private onApprove(ws: WebSocket, state: PeerState, msg: MsgApprove): void {
    if (!state.deviceId) {
      return this.send(ws, { type: 'error', message: 'Not registered' });
    }

    const controllerWs = this.online.get(msg.targetId);
    if (!controllerWs) {
      return; // Controller went offline; nothing to do
    }

    if (!msg.approved) {
      return this.send(controllerWs, {
        type: 'connect_result',
        approved: false,
        reason: 'Remote host declined',
      });
    }

    this.establishSession(controllerWs, this.state.get(controllerWs)!, ws, state.deviceId);
  }

  // -------------------------------------------------------------------------
  // Establish a session between controller and agent
  // -------------------------------------------------------------------------

  private establishSession(
    controllerWs: WebSocket,
    controllerState: PeerState,
    agentWs: WebSocket,
    agentDeviceId: string
  ): void {
    const agentState = this.state.get(agentWs)!;
    const sessionId = uuidv4();

    // Record in DB
    createSession(sessionId, controllerState.deviceId, agentDeviceId);

    // Update in-memory state
    controllerState.peerId = agentDeviceId;
    controllerState.sessionId = sessionId;
    agentState.peerId = controllerState.deviceId;
    agentState.sessionId = sessionId;

    console.log(
      `[signaling] session ${sessionId}: ${controllerState.deviceId} → ${agentDeviceId}`
    );

    createAuditLog(
      null,
      controllerState.deviceId,
      'session_started',
      'session',
      `sessionId=${sessionId} target=${agentDeviceId}`,
      controllerState.remoteIp
    );

    // Notify controller (session approved, with agent's device ID for WebRTC targeting)
    this.send(controllerWs, { type: 'connect_result', approved: true, peerId: agentDeviceId });
    // Notify agent (session started, so it can open session window)
    this.send(agentWs, { type: 'session_started', controllerId: controllerState.deviceId });
  }

  // -------------------------------------------------------------------------
  // Handler: offer
  // -------------------------------------------------------------------------

  private onOffer(ws: WebSocket, state: PeerState, msg: MsgOffer): void {
    const targetWs = this.online.get(msg.targetId);
    if (!targetWs) {
      return this.send(ws, { type: 'error', message: 'Target not found' });
    }
    this.send(targetWs, { type: 'offer', sourceId: state.deviceId, sdp: msg.sdp });
  }

  // -------------------------------------------------------------------------
  // Handler: answer
  // -------------------------------------------------------------------------

  private onAnswer(ws: WebSocket, state: PeerState, msg: MsgAnswer): void {
    const targetWs = this.online.get(msg.targetId);
    if (!targetWs) {
      return this.send(ws, { type: 'error', message: 'Target not found' });
    }
    this.send(targetWs, { type: 'answer', sourceId: state.deviceId, sdp: msg.sdp });
  }

  // -------------------------------------------------------------------------
  // Handler: ice
  // -------------------------------------------------------------------------

  private onIce(ws: WebSocket, state: PeerState, msg: MsgIce): void {
    const targetWs = this.online.get(msg.targetId);
    if (!targetWs) {
      return; // ICE trickle: silently drop if peer is gone
    }
    this.send(targetWs, {
      type: 'ice',
      sourceId: state.deviceId,
      candidate: msg.candidate,
    });
  }

  // -------------------------------------------------------------------------
  // Handler: disconnect
  // -------------------------------------------------------------------------

  private onDisconnect(ws: WebSocket, state: PeerState, msg: MsgDisconnect): void {
    const targetWs = this.online.get(msg.targetId);

    if (state.sessionId) {
      const endedSessionId = state.sessionId;
      endSession(endedSessionId);
      createAuditLog(
        null,
        state.deviceId,
        'session_ended',
        'session',
        `sessionId=${endedSessionId} peer=${msg.targetId}`,
        state.remoteIp
      );
      state.sessionId = null;
    }

    if (targetWs) {
      const targetState = this.state.get(targetWs);
      if (targetState) {
        if (targetState.sessionId) {
          endSession(targetState.sessionId);
          targetState.sessionId = null;
        }
        targetState.peerId = null;
      }
      this.send(targetWs, { type: 'peer_disconnected' });
    }

    state.peerId = null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, payload: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  /** Returns the set of currently online device IDs (for REST /devices status) */
  public isOnline(deviceId: string): boolean {
    return this.online.has(deviceId);
  }

  public onlineCount(): number {
    return this.online.size;
  }
}
