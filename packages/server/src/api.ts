import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
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
} from './db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  toPublicUser,
  type AuthRequest,
} from './auth.js';
import type { SignalingServer } from './signaling.js';

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
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const user = getUserByEmail(email.toLowerCase());
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = signToken(user);
    res.json({ token, user: toPublicUser(user) });
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
    res.status(204).send();
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
