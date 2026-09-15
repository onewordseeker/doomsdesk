import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { getUserById, type DbUser } from './db.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JWT_SECRET =
  process.env.JWT_SECRET ?? 'doomsdesk-dev-secret-change-in-production';

const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Password utilities
// ---------------------------------------------------------------------------

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ---------------------------------------------------------------------------
// JWT utilities
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string; // user id
  email: string;
}

export function signToken(user: Pick<DbUser, 'id' | 'email'>): string {
  const payload: JwtPayload = { sub: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    // Verify user still exists
    const user = getUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Public user shape (strip password_hash before sending to client)
// ---------------------------------------------------------------------------

export function toPublicUser(user: DbUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    createdAt: user.created_at,
  };
}
