import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import {
  createUser,
  getUserByEmail,
  getUserById,
  getDevicesByUserId,
  createDevice,
  getDeviceByRowId,
  getDeviceByDeviceId,
  updateDevice,
  deleteDevice,
  getSessionById,
  getSessionsForUser,
  getActiveSessionsForUser,
  getSessionsForUserSince,
  getUserSettings,
  upsertUserSettings,
  updateUserName,
  updateUserPassword,
  createAuditLog,
  getAuditLogs,
  createTeam,
  getTeamById,
  getTeamsByUserId,
  addTeamMember,
  removeTeamMember,
  updateMemberRole,
  getTeamMembers,
  getMemberRole,
  updateTeamName,
  deleteTeam,
  canManageTeam,
  createApiKey,
  getApiKeysByUserId,
  revokeApiKey,
  setTotpSecret,
  enableTotp,
  disableTotp,
  savePendingTotp,
  getPendingTotp,
  deletePendingTotp,
} from './db.js';
import * as OTPAuth from 'otpauth';
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  toPublicUser,
  hashApiKey,
  generateApiKey,
  type AuthRequest,
} from './auth.js';
import {
  generateState,
  validateState,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  buildGithubAuthUrl,
  exchangeGithubCode,
} from './oauth.js';
import { loginLimiter } from './ratelimit.js';
import type { SignalingServer } from './signaling.js';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Plans (hardcoded — no Stripe yet)
// ---------------------------------------------------------------------------

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    maxConcurrent: 1,
    maxDevices: 3,
    features: [
      '1 concurrent connection',
      '3 devices',
      'Session history 7 days',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 12,
    maxConcurrent: 5,
    maxDevices: 10,
    features: [
      '5 concurrent connections',
      '10 devices',
      '30 day history',
      'Priority relay',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    price: 49,
    maxConcurrent: 20,
    maxDevices: -1,
    features: [
      '20 concurrent connections',
      'Unlimited devices',
      '90 day history',
      'Dedicated relay',
      'Team management',
    ],
  },
];

// ---------------------------------------------------------------------------
// Router factory — receives reference to signaling server for online status
// ---------------------------------------------------------------------------

export function createApiRouter(signaling: SignalingServer): Router {
  const router = Router();

  // =========================================================================
  // Auth
  // =========================================================================

  /** POST /api/auth/register */
  router.post('/auth/register', async (req: Request, res: Response) => {
    const { email, password, name } = req.body as {
      email?: string;
      password?: string;
      name?: string;
    };

    if (!email || !password || !name) {
      res.status(400).json({ error: 'email, password and name are required' });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const existing = getUserByEmail(email.toLowerCase());
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = createUser(uuidv4(), email.toLowerCase(), passwordHash, name.trim());
    const token = signToken(user);

    res.status(201).json({ token, user: toPublicUser(user) });
  });

  /** POST /api/auth/login */
  router.post('/auth/login', async (req: Request, res: Response) => {
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';

    // 10 login attempts per hour per IP
    if (!loginLimiter.check(`login:${ip}`, 10, 60 * 60 * 1000)) {
      const retryMs = loginLimiter.retryAfterMs(`login:${ip}`);
      res.status(429).json({
        error: `Too many login attempts. Retry in ${Math.ceil(retryMs / 1000)}s.`,
      });
      return;
    }

    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const user = getUserByEmail(email.toLowerCase());
    if (!user) {
      createAuditLog(null, null, 'auth_failed', 'login', `email=${email}`, ip);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      createAuditLog(user.id, null, 'auth_failed', 'login', 'bad password', ip);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // If TOTP is enabled, return a short-lived pre-auth token instead of the full JWT
    if (user.totp_enabled) {
      const preAuthToken = signToken(user, '5m');
      res.json({ totpRequired: true, preAuthToken });
      return;
    }

    const token = signToken(user);
    createAuditLog(user.id, null, 'login', 'auth', undefined, ip);
    res.json({ token, user: toPublicUser(user) });
  });

  /** POST /api/auth/logout */
  router.post('/auth/logout', requireAuth, (req: AuthRequest, res: Response) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'logout', 'auth', undefined, ip);
    res.status(204).end();
  });

  /** GET /api/auth/me */
  router.get('/auth/me', requireAuth, (req: AuthRequest, res: Response) => {
    const user = getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  /** PATCH /api/auth/me */
  router.patch('/auth/me', requireAuth, async (req: AuthRequest, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const updated = updateUserName(req.userId!, name.trim());
    if (!updated) {
      res.status(500).json({ error: 'Update failed' });
      return;
    }
    res.json({ user: toPublicUser(updated) });
  });

  /** POST /api/auth/password */
  router.post('/auth/password', requireAuth, async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'currentPassword and newPassword are required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    const user = getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const ok = await verifyPassword(currentPassword, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const newHash = await hashPassword(newPassword);
    updateUserPassword(req.userId!, newHash);
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'password_changed', 'auth', undefined, ip);
    res.status(204).send();
  });

  // =========================================================================
  // OAuth SSO — Google & GitHub
  //
  // Users created via OAuth have password_hash = 'oauth'. This is intentional:
  // they can only sign in through OAuth flows and cannot use the password login
  // endpoint (verifyPassword against 'oauth' will always return false).
  // =========================================================================

  /** GET /api/auth/oauth/google — redirect to Google consent screen */
  router.get('/auth/oauth/google', (_req: Request, res: Response) => {
    const state = generateState('google');
    res.redirect(buildGoogleAuthUrl(state));
  });

  /** GET /api/auth/oauth/google/callback — handle Google redirect */
  router.get('/auth/oauth/google/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query as { code?: string; state?: string };

    // validateState validates and consumes the CSRF state token.
    // It returns null if the state is missing, expired, or for a different provider.
    if (!code || !state || validateState(state, 'google') === false) {
      res.redirect(`${WEB_URL}/login?error=oauth_failed`);
      return;
    }

    try {
      const { email, name } = await exchangeGoogleCode(code);

      let user = getUserByEmail(email.toLowerCase());
      if (!user) {
        user = createUser(uuidv4(), email.toLowerCase(), 'oauth', name);
      }

      const token = signToken(user);
      res.redirect(`${WEB_URL}/auth/callback?token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error('[oauth:google]', err);
      res.redirect(`${WEB_URL}/login?error=oauth_failed`);
    }
  });

  /** GET /api/auth/oauth/github — redirect to GitHub consent screen */
  router.get('/auth/oauth/github', (_req: Request, res: Response) => {
    const state = generateState('github');
    res.redirect(buildGithubAuthUrl(state));
  });

  /** GET /api/auth/oauth/github/callback — handle GitHub redirect */
  router.get('/auth/oauth/github/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query as { code?: string; state?: string };

    // validateState validates and consumes the CSRF state token.
    // It returns null if the state is missing, expired, or for a different provider.
    if (!code || !state || validateState(state, 'github') === false) {
      res.redirect(`${WEB_URL}/login?error=oauth_failed`);
      return;
    }

    try {
      const { email, name } = await exchangeGithubCode(code);

      let user = getUserByEmail(email.toLowerCase());
      if (!user) {
        user = createUser(uuidv4(), email.toLowerCase(), 'oauth', name);
      }

      const token = signToken(user);
      res.redirect(`${WEB_URL}/auth/callback?token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error('[oauth:github]', err);
      res.redirect(`${WEB_URL}/login?error=oauth_failed`);
    }
  });

  // =========================================================================
  // API Keys
  // =========================================================================

  /** GET /api/keys — list the authenticated user's API keys (never exposes hash) */
  router.get('/keys', requireAuth, (req: AuthRequest, res: Response) => {
    const keys = getApiKeysByUserId(req.userId!).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      lastUsed: k.last_used,
      createdAt: k.created_at,
    }));
    res.json({ keys });
  });

  /** POST /api/keys — create a new API key; full key returned ONCE */
  router.post('/keys', requireAuth, (req: AuthRequest, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    // Store first 8 chars as the visible prefix (e.g. "dd_abc1")
    const keyPrefix = rawKey.slice(0, 8);
    const id = uuidv4();

    const apiKey = createApiKey(id, req.userId!, name.trim(), keyHash, keyPrefix);
    const ipk = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'api_key_created', 'api_key', name.trim(), ipk);

    res.status(201).json({
      key: rawKey,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.key_prefix,
        createdAt: apiKey.created_at,
      },
    });
  });

  /** DELETE /api/keys/:id — revoke an API key */
  router.delete('/keys/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const deleted = revokeApiKey(req.params.id, req.userId!);
    if (!deleted) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    const ipr = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'api_key_revoked', 'api_key', req.params.id, ipr);
    res.status(204).send();
  });

  // =========================================================================
  // TOTP / 2FA
  // =========================================================================

  /**
   * POST /api/auth/totp/verify-login
   * Exchange a pre-auth token + TOTP code for a full 30-day JWT.
   * Body: { preAuthToken: string; code: string }
   */
  router.post('/auth/totp/verify-login', async (req: Request, res: Response) => {
    const { preAuthToken, code } = req.body as { preAuthToken?: string; code?: string };
    if (!preAuthToken || !code) {
      res.status(400).json({ error: 'preAuthToken and code are required' });
      return;
    }
    let payload: import('./auth.js').JwtPayload;
    try {
      payload = (await import('./auth.js')).verifyToken(preAuthToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired pre-auth token' });
      return;
    }
    const user = getUserById(payload.sub);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      res.status(401).json({ error: 'TOTP not configured' });
      return;
    }
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6 });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      res.status(401).json({ error: 'Invalid TOTP code' });
      return;
    }
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    const token = (await import('./auth.js')).signToken(user);
    createAuditLog(user.id, null, 'login', 'auth', 'totp', ip);
    res.json({ token, user: toPublicUser(user) });
  });

  /**
   * GET /api/auth/totp/setup
   * Generates a new TOTP secret, stores it as pending, returns QR URI.
   */
  router.get('/auth/totp/setup', requireAuth, (req: AuthRequest, res: Response) => {
    const user = getUserById(req.userId!);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'DoomsDesk',
      label: user.email,
      secret,
      digits: 6,
      period: 30,
    });
    savePendingTotp(user.id, secret.base32);
    res.json({ uri: totp.toString(), secret: secret.base32 });
  });

  /**
   * POST /api/auth/totp/setup/confirm
   * Confirms the pending TOTP by verifying a code, then enables 2FA.
   * Body: { code: string }
   */
  router.post('/auth/totp/setup/confirm', requireAuth, (req: AuthRequest, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code is required' }); return; }
    const pendingSecret = getPendingTotp(req.userId!);
    if (!pendingSecret) { res.status(400).json({ error: 'No pending TOTP setup' }); return; }
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(pendingSecret), digits: 6 });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) { res.status(401).json({ error: 'Invalid code' }); return; }
    setTotpSecret(req.userId!, pendingSecret);
    enableTotp(req.userId!);
    deletePendingTotp(req.userId!);
    const ipte = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'totp_enabled', 'auth', undefined, ipte);
    res.json({ enabled: true });
  });

  /**
   * DELETE /api/auth/totp
   * Disables 2FA. Requires current TOTP code or password as confirmation.
   * Body: { code: string } — current TOTP code
   */
  router.delete('/auth/totp', requireAuth, (req: AuthRequest, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code is required' }); return; }
    const user = getUserById(req.userId!);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      res.status(400).json({ error: '2FA is not enabled' }); return;
    }
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6 });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) { res.status(401).json({ error: 'Invalid TOTP code' }); return; }
    disableTotp(req.userId!);
    const iptd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, null, 'totp_disabled', 'auth', undefined, iptd);
    res.json({ enabled: false });
  });

  /**
   * GET /api/auth/totp/status
   * Returns whether 2FA is enabled for the authenticated user.
   */
  router.get('/auth/totp/status', requireAuth, (req: AuthRequest, res: Response) => {
    const user = getUserById(req.userId!);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ enabled: user.totp_enabled === 1 });
  });

  // =========================================================================
  // Devices
  // =========================================================================

  /** GET /api/devices */
  router.get('/devices', requireAuth, (req: AuthRequest, res: Response) => {
    const devices = getDevicesByUserId(req.userId!).map((d) => ({
      id: d.id,
      deviceId: d.device_id,
      name: d.name,
      lastSeen: d.last_seen,
      createdAt: d.created_at,
      online: signaling.isOnline(d.device_id),
      hasPermanentPassword: d.permanent_password_hash !== null,
    }));
    res.json({ devices });
  });

  /** POST /api/devices */
  router.post('/devices', requireAuth, async (req: AuthRequest, res: Response) => {
    const { deviceId, name, permanentPassword } = req.body as {
      deviceId?: string;
      name?: string;
      permanentPassword?: string;
    };

    if (!deviceId || !name) {
      res.status(400).json({ error: 'deviceId and name are required' });
      return;
    }

    if (getDeviceByDeviceId(deviceId)) {
      res.status(409).json({ error: 'Device ID is already registered' });
      return;
    }

    const hash = permanentPassword ? await hashPassword(permanentPassword) : null;
    const device = createDevice(uuidv4(), req.userId!, deviceId, name.trim(), hash);

    res.status(201).json({
      device: {
        id: device.id,
        deviceId: device.device_id,
        name: device.name,
        lastSeen: device.last_seen,
        createdAt: device.created_at,
        online: signaling.isOnline(device.device_id),
        hasPermanentPassword: device.permanent_password_hash !== null,
      },
    });
  });

  /** GET /api/devices/:id */
  router.get('/devices/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const device = getDeviceByRowId(req.params.id);
    if (!device || device.user_id !== req.userId) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({
      device: {
        id: device.id,
        deviceId: device.device_id,
        name: device.name,
        lastSeen: device.last_seen,
        createdAt: device.created_at,
        online: signaling.isOnline(device.device_id),
        hasPermanentPassword: device.permanent_password_hash !== null,
      },
    });
  });

  /** PUT /api/devices/:id */
  router.put('/devices/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    const { name, permanentPassword } = req.body as {
      name?: string;
      permanentPassword?: string | null;
    };

    const existing = getDeviceByRowId(req.params.id);
    if (!existing || existing.user_id !== req.userId) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const newName = (name ?? existing.name).trim();

    // null explicitly passed → clear password; undefined → keep existing hash
    let newHash: string | null;
    if (permanentPassword === null) {
      newHash = null;
    } else if (typeof permanentPassword === 'string') {
      newHash = await hashPassword(permanentPassword);
    } else {
      newHash = existing.permanent_password_hash;
    }

    const updated = updateDevice(req.params.id, req.userId!, newName, newHash);
    if (!updated) {
      res.status(500).json({ error: 'Update failed' });
      return;
    }

    res.json({
      device: {
        id: updated.id,
        deviceId: updated.device_id,
        name: updated.name,
        lastSeen: updated.last_seen,
        createdAt: updated.created_at,
        online: signaling.isOnline(updated.device_id),
        hasPermanentPassword: updated.permanent_password_hash !== null,
      },
    });
  });

  /** DELETE /api/devices/:id */
  router.delete('/devices/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const existing = getDeviceByRowId(req.params.id);
    if (!existing || existing.user_id !== req.userId) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const deleted = deleteDevice(req.params.id, req.userId!);
    if (!deleted) {
      res.status(500).json({ error: 'Delete failed' });
      return;
    }
    const ip2 = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    createAuditLog(req.userId!, existing.id, 'device_deleted', 'device', existing.device_id, ip2);
    res.status(204).send();
  });

  // =========================================================================
  // Sessions
  // =========================================================================

  /** GET /api/sessions?page=1&limit=20 */
  router.get('/sessions', requireAuth, (req: AuthRequest, res: Response) => {
    const page  = Math.max(1, parseInt((req.query.page  as string) ?? '1',  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));

    const { sessions, total } = getSessionsForUser(req.userId!, page, limit);

    res.json({
      sessions: sessions.map(formatSession),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  });

  /** GET /api/sessions/:id */
  router.get('/sessions/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ session: formatSession(session) });
  });

  // =========================================================================
  // Dashboard
  // =========================================================================

  /** GET /api/dashboard/stats */
  router.get('/dashboard/stats', requireAuth, (req: AuthRequest, res: Response) => {
    const devices = getDevicesByUserId(req.userId!);
    const onlineDevices = devices.filter((d) => signaling.isOnline(d.device_id)).length;

    const startOfMonth = Math.floor(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000
    );

    const { sessions: recentSessions } = getSessionsForUser(req.userId!, 1, 5);
    const sessionsThisMonth = getSessionsForUserSince(req.userId!, startOfMonth);
    const activeSessions = getActiveSessionsForUser(req.userId!);

    res.json({
      totalDevices: devices.length,
      onlineDevices,
      activeSessions,
      sessionsThisMonth,
      recentSessions: recentSessions.map(formatSession),
    });
  });

  // =========================================================================
  // Billing
  // =========================================================================

  /** GET /api/billing/plans */
  router.get('/billing/plans', (_req: Request, res: Response) => {
    res.json({ plans: PLANS });
  });

  /** GET /api/billing/me */
  router.get('/billing/me', requireAuth, (req: AuthRequest, res: Response) => {
    const user = getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const plan = PLANS.find((p) => p.id === user.plan) ?? PLANS[0];
    const devices = getDevicesByUserId(req.userId!);
    const onlineCount = signaling.onlineCount();

    res.json({
      plan,
      usage: {
        devicesRegistered: devices.length,
        devicesOnline: onlineCount,
        maxDevices: plan.maxDevices,
        maxConcurrent: plan.maxConcurrent,
      },
    });
  });

  // =========================================================================
  // Settings
  // =========================================================================

  /** GET /api/settings */
  router.get('/settings', requireAuth, (req: AuthRequest, res: Response) => {
    const settings = getUserSettings(req.userId!);
    if (!settings) {
      res.status(404).json({ error: 'Settings not found' });
      return;
    }
    res.json({ settings: formatSettings(settings) });
  });

  /** PUT /api/settings */
  router.put('/settings', requireAuth, (req: AuthRequest, res: Response) => {
    const existing = getUserSettings(req.userId!);
    if (!existing) {
      res.status(404).json({ error: 'Settings not found' });
      return;
    }

    const {
      theme         = existing.theme,
      notifications = Boolean(existing.notifications),
      autoAnswer    = Boolean(existing.auto_answer),
    } = req.body as {
      theme?: string;
      notifications?: boolean;
      autoAnswer?: boolean;
    };

    const validThemes = ['dark', 'light', 'system'];
    if (!validThemes.includes(theme)) {
      res.status(400).json({ error: `theme must be one of: ${validThemes.join(', ')}` });
      return;
    }

    const updated = upsertUserSettings(req.userId!, theme, notifications, autoAnswer);
    res.json({ settings: formatSettings(updated) });
  });

  // =========================================================================
  // Audit logs
  // =========================================================================

  /** GET /api/audit?page=1&limit=20 */
  router.get('/audit', requireAuth, (req: AuthRequest, res: Response) => {
    const page  = Math.max(1, parseInt((req.query.page  as string) ?? '1',  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));

    const { logs, total } = getAuditLogs(req.userId!, page, limit);

    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        userId: l.user_id,
        deviceId: l.device_id,
        action: l.action,
        resource: l.resource,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  });

  // =========================================================================
  // Teams
  // =========================================================================

  /** POST /api/teams */
  router.post('/teams', requireAuth, (req: AuthRequest, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const team = createTeam(uuidv4(), name.trim(), req.userId!);
    res.status(201).json({ team: formatTeam(team) });
  });

  /** GET /api/teams */
  router.get('/teams', requireAuth, (req: AuthRequest, res: Response) => {
    const teams = getTeamsByUserId(req.userId!);
    res.json({ teams: teams.map(formatTeam) });
  });

  /** GET /api/teams/:id */
  router.get('/teams/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const role = getMemberRole(team.id, req.userId!);
    if (!role) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    res.json({ team: formatTeam(team) });
  });

  /** PUT /api/teams/:id */
  router.put('/teams/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const role = getMemberRole(team.id, req.userId!);
    if (!role || !canManageTeam(role)) {
      res.status(403).json({ error: 'Forbidden: owner or admin required' });
      return;
    }

    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const updated = updateTeamName(team.id, name.trim());
    if (!updated) {
      res.status(500).json({ error: 'Update failed' });
      return;
    }

    res.json({ team: formatTeam(updated) });
  });

  /** DELETE /api/teams/:id */
  router.delete('/teams/:id', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    if (team.owner_id !== req.userId) {
      res.status(403).json({ error: 'Forbidden: owner only' });
      return;
    }

    deleteTeam(team.id);
    res.status(204).send();
  });

  /** GET /api/teams/:id/members */
  router.get('/teams/:id/members', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const role = getMemberRole(team.id, req.userId!);
    if (!role) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const members = getTeamMembers(team.id);
    res.json({
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        invitedAt: m.invited_at,
      })),
    });
  });

  /** POST /api/teams/:id/members — invite by email */
  router.post('/teams/:id/members', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const actorRole = getMemberRole(team.id, req.userId!);
    if (!actorRole || !canManageTeam(actorRole)) {
      res.status(403).json({ error: 'Forbidden: owner or admin required' });
      return;
    }

    const { email, role = 'member' } = req.body as { email?: string; role?: string };
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const validRoles = ['admin', 'member', 'viewer'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      return;
    }

    const invitee = getUserByEmail(email.toLowerCase());
    if (!invitee) {
      res.status(404).json({ error: 'No user found with that email address' });
      return;
    }

    // Prevent downgrading the owner via this endpoint
    const existingRole = getMemberRole(team.id, invitee.id);
    if (existingRole === 'owner') {
      res.status(400).json({ error: 'Cannot change the owner role' });
      return;
    }

    addTeamMember(team.id, invitee.id, role);
    res.status(201).json({
      member: {
        userId: invitee.id,
        email: invitee.email,
        name: invitee.name,
        role,
      },
    });
  });

  /** PUT /api/teams/:id/members/:userId */
  router.put('/teams/:id/members/:userId', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const actorRole = getMemberRole(team.id, req.userId!);
    if (!actorRole || !canManageTeam(actorRole)) {
      res.status(403).json({ error: 'Forbidden: owner or admin required' });
      return;
    }

    const { role } = req.body as { role?: string };
    const validRoles = ['admin', 'member', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      return;
    }

    const targetRole = getMemberRole(team.id, req.params.userId);
    if (!targetRole) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (targetRole === 'owner') {
      res.status(400).json({ error: 'Cannot change the owner role' });
      return;
    }

    updateMemberRole(team.id, req.params.userId, role);
    res.json({ userId: req.params.userId, role });
  });

  /** DELETE /api/teams/:id/members/:userId */
  router.delete('/teams/:id/members/:userId', requireAuth, (req: AuthRequest, res: Response) => {
    const team = getTeamById(req.params.id);
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const actorRole = getMemberRole(team.id, req.userId!);
    if (!actorRole || !canManageTeam(actorRole)) {
      // Allow self-removal
      if (req.params.userId !== req.userId) {
        res.status(403).json({ error: 'Forbidden: owner or admin required' });
        return;
      }
    }

    const targetRole = getMemberRole(team.id, req.params.userId);
    if (!targetRole) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (targetRole === 'owner') {
      res.status(400).json({ error: 'Cannot remove the team owner' });
      return;
    }

    removeTeamMember(team.id, req.params.userId);
    res.status(204).send();
  });

  // =========================================================================
  // Billing — Stripe integration
  // =========================================================================

  /**
   * POST /api/billing/checkout
   *
   * Creates a Stripe Checkout Session and returns the session URL.
   * The client redirects the user to that URL to complete payment.
   *
   * TODO: Replace the stub body with the real Stripe SDK call once
   *       `stripe` npm package is added (pin to ^14.x).
   *
   *   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });
   *   const session = await stripe.checkout.sessions.create({
   *     mode: 'subscription',
   *     customer_email: user.email,
   *     line_items: [{ price: priceId, quantity: 1 }],
   *     success_url: `${process.env.APP_URL}/billing?success=1`,
   *     cancel_url:  `${process.env.APP_URL}/billing?cancelled=1`,
   *     metadata: { userId: user.id },
   *   });
   *   res.json({ url: session.url });
   */
  router.post('/billing/checkout', requireAuth, (req: AuthRequest, res: Response) => {
    const { priceId } = req.body as { priceId?: string };
    if (!priceId) {
      res.status(400).json({ error: 'priceId is required' });
      return;
    }

    const user = getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // TODO: Integrate with Stripe Checkout (see JSDoc above)
    res.status(501).json({
      error: 'Stripe integration pending — set STRIPE_SECRET_KEY and install the stripe package',
    });
  });

  /**
   * POST /api/billing/portal
   *
   * Returns a Stripe Customer Portal URL so the user can manage their
   * subscription, update payment methods, or cancel.
   *
   * TODO: Replace the stub body once Stripe SDK is available:
   *
   *   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });
   *   const session = await stripe.billingPortal.sessions.create({
   *     customer: user.stripe_customer_id,   // stored on the users table
   *     return_url: `${process.env.APP_URL}/billing`,
   *   });
   *   res.json({ url: session.url });
   */
  router.post('/billing/portal', requireAuth, (_req: AuthRequest, res: Response) => {
    // TODO: Integrate with Stripe Customer Portal (see JSDoc above)
    res.status(501).json({
      error: 'Stripe integration pending — set STRIPE_SECRET_KEY and install the stripe package',
    });
  });

  /**
   * POST /api/billing/webhook
   *
   * Receives Stripe webhook events. Verifies the `stripe-signature` header
   * using HMAC-SHA256 (manual implementation — no Stripe SDK required).
   *
   * Relevant events handled:
   *  - checkout.session.completed  → activate subscription / update plan
   *  - customer.subscription.updated → plan change (upgrade/downgrade)
   *  - customer.subscription.deleted → revert to free plan
   *
   * NOTE: Express must receive the raw body for signature verification.
   * Mount this route with `express.raw({ type: 'application/json' })` before
   * the global `express.json()` middleware, or use the `rawBody` trick in
   * index.ts. The router is mounted after `express.json()`, so the raw body
   * arrives here as `req.body` already parsed. In production you should
   * mount this endpoint separately with express.raw().
   */
  router.post(
    '/billing/webhook',
    (req: Request, res: Response) => {
      const sig     = req.headers['stripe-signature'] as string | undefined;
      const secret  = process.env.STRIPE_WEBHOOK_SECRET ?? '';

      if (!sig || !secret) {
        res.status(400).json({ error: 'Missing stripe-signature or webhook secret' });
        return;
      }

      // Re-serialise the parsed body so we can verify the signature.
      // In production, wire up express.raw() for this route for exact byte-for-byte
      // fidelity. This is sufficient for dev / staging where the payload is ASCII-safe.
      const payload = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

      if (!verifyStripeWebhook(payload, sig, secret)) {
        res.status(400).json({ error: 'Webhook signature verification failed' });
        return;
      }

      const event = JSON.parse(payload.toString()) as { type: string; data: { object: Record<string, unknown> } };

      switch (event.type) {
        case 'checkout.session.completed': {
          // TODO: Extract metadata.userId, look up / create Stripe customer,
          //       update user.plan and store stripe_customer_id in the DB.
          console.log('[billing] checkout.session.completed', event.data.object['id']);
          break;
        }
        case 'customer.subscription.updated': {
          // TODO: Map the Stripe price ID back to a plan ('free'|'pro'|'business')
          //       and update the user row accordingly.
          console.log('[billing] customer.subscription.updated', event.data.object['id']);
          break;
        }
        case 'customer.subscription.deleted': {
          // TODO: Revert the user to the free plan.
          console.log('[billing] customer.subscription.deleted', event.data.object['id']);
          break;
        }
        default:
          // Unhandled event type — acknowledge receipt so Stripe doesn't retry
          break;
      }

      res.json({ received: true });
    }
  );

  return router;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSession(s: {
  id: string;
  controller_device_id: string;
  target_device_id: string;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number | null;
}) {
  return {
    id: s.id,
    controllerDeviceId: s.controller_device_id,
    targetDeviceId: s.target_device_id,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    durationSeconds: s.duration_seconds,
  };
}

function formatSettings(s: {
  user_id: string;
  theme: string;
  notifications: number;
  auto_answer: number;
  updated_at: number;
}) {
  return {
    theme: s.theme,
    notifications: Boolean(s.notifications),
    autoAnswer: Boolean(s.auto_answer),
    updatedAt: s.updated_at,
  };
}

function formatTeam(t: {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  created_at: number;
}) {
  return {
    id: t.id,
    name: t.name,
    ownerId: t.owner_id,
    plan: t.plan,
    createdAt: t.created_at,
  };
}

// ---------------------------------------------------------------------------
// Stripe webhook signature verification (no SDK required)
// ---------------------------------------------------------------------------

function verifyStripeWebhook(payload: Buffer, sig: string, secret: string): boolean {
  const parts = sig.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  if (!timestampPart) return false;

  const timestamp = timestampPart.slice(2);
  const v1Sigs = parts
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));

  if (v1Sigs.length === 0) return false;

  const signedPayload = `${timestamp}.${payload.toString()}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  return v1Sigs.some((candidate) => {
    try {
      const candidateBuf = Buffer.from(candidate, 'hex');
      // Lengths must match for timingSafeEqual
      if (candidateBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(candidateBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}
