import Database from 'better-sqlite3';
import path from 'path';

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'doomsdesk.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name         TEXT NOT NULL,
      plan         TEXT NOT NULL DEFAULT 'free',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                      TEXT PRIMARY KEY,
      user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id               TEXT NOT NULL UNIQUE,
      name                    TEXT NOT NULL,
      permanent_password_hash TEXT,
      last_seen               INTEGER,
      created_at              INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                   TEXT PRIMARY KEY,
      controller_device_id TEXT NOT NULL,
      target_device_id     TEXT NOT NULL,
      started_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at             INTEGER,
      duration_seconds     INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme         TEXT NOT NULL DEFAULT 'dark',
      notifications INTEGER NOT NULL DEFAULT 1,
      auto_answer   INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_devices_user_id   ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_devices  ON sessions(controller_device_id, target_device_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started  ON sessions(started_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT,
      device_id  TEXT,
      action     TEXT NOT NULL,
      resource   TEXT,
      detail     TEXT,
      ip         TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS teams (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan       TEXT NOT NULL DEFAULT 'free',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',
      invited_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      key_hash    TEXT NOT NULL,
      key_prefix  TEXT NOT NULL,
      last_used   INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface DbUser {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  plan: string;
  created_at: number;
}

export interface DbDevice {
  id: string;
  user_id: string;
  device_id: string;
  name: string;
  permanent_password_hash: string | null;
  last_seen: number | null;
  created_at: number;
}

export interface DbSession {
  id: string;
  controller_device_id: string;
  target_device_id: string;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number | null;
}

export interface DbUserSettings {
  user_id: string;
  theme: string;
  notifications: number;
  auto_answer: number;
  updated_at: number;
}

export interface DbAuditLog {
  id: number;
  user_id: string | null;
  device_id: string | null;
  action: string;
  resource: string | null;
  detail: string | null;
  ip: string | null;
  created_at: number;
}

export interface DbTeam {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  created_at: number;
}

export interface DbTeamMember {
  team_id: string;
  user_id: string;
  role: string;
  invited_at: number;
}

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

export function createUser(id: string, email: string, passwordHash: string, name: string): DbUser {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)`
  ).run(id, email, passwordHash, name);

  db.prepare(
    `INSERT INTO user_settings (user_id) VALUES (?)`
  ).run(id);

  return getUserById(id)!;
}

export function getUserById(id: string): DbUser | undefined {
  return getDb().prepare<[string], DbUser>(
    `SELECT * FROM users WHERE id = ?`
  ).get(id);
}

export function getUserByEmail(email: string): DbUser | undefined {
  return getDb().prepare<[string], DbUser>(
    `SELECT * FROM users WHERE email = ?`
  ).get(email);
}

export function updateUserName(id: string, name: string): DbUser | undefined {
  const db = getDb();
  const result = db.prepare(
    `UPDATE users SET name = ? WHERE id = ?`
  ).run(name, id);
  if (result.changes === 0) return undefined;
  return getUserById(id);
}

export function updateUserPassword(id: string, passwordHash: string): boolean {
  const result = getDb().prepare(
    `UPDATE users SET password_hash = ? WHERE id = ?`
  ).run(passwordHash, id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Device queries
// ---------------------------------------------------------------------------

export function createDevice(
  id: string,
  userId: string,
  deviceId: string,
  name: string,
  permanentPasswordHash: string | null
): DbDevice {
  const db = getDb();
  db.prepare(
    `INSERT INTO devices (id, user_id, device_id, name, permanent_password_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, deviceId, name, permanentPasswordHash);
  return getDeviceByRowId(id)!;
}

export function getDeviceByRowId(id: string): DbDevice | undefined {
  return getDb().prepare<[string], DbDevice>(
    `SELECT * FROM devices WHERE id = ?`
  ).get(id);
}

export function getDeviceByDeviceId(deviceId: string): DbDevice | undefined {
  return getDb().prepare<[string], DbDevice>(
    `SELECT * FROM devices WHERE device_id = ?`
  ).get(deviceId);
}

export function getDevicesByUserId(userId: string): DbDevice[] {
  return getDb().prepare<[string], DbDevice>(
    `SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId);
}

export function updateDevice(
  id: string,
  userId: string,
  name: string,
  permanentPasswordHash: string | null
): DbDevice | undefined {
  const db = getDb();
  const result = db.prepare(
    `UPDATE devices SET name = ?, permanent_password_hash = ? WHERE id = ? AND user_id = ?`
  ).run(name, permanentPasswordHash, id, userId);

  if (result.changes === 0) return undefined;
  return getDeviceByRowId(id);
}

export function touchDeviceLastSeen(deviceId: string): void {
  getDb().prepare(
    `UPDATE devices SET last_seen = unixepoch() WHERE device_id = ?`
  ).run(deviceId);
}

export function deleteDevice(id: string, userId: string): boolean {
  const result = getDb().prepare(
    `DELETE FROM devices WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Session queries
// ---------------------------------------------------------------------------

export function createSession(
  id: string,
  controllerDeviceId: string,
  targetDeviceId: string
): DbSession {
  getDb().prepare(
    `INSERT INTO sessions (id, controller_device_id, target_device_id) VALUES (?, ?, ?)`
  ).run(id, controllerDeviceId, targetDeviceId);
  return getSessionById(id)!;
}

export function endSession(id: string): void {
  getDb().prepare(
    `UPDATE sessions
     SET ended_at = unixepoch(),
         duration_seconds = unixepoch() - started_at
     WHERE id = ? AND ended_at IS NULL`
  ).run(id);
}

export function getSessionById(id: string): DbSession | undefined {
  return getDb().prepare<[string], DbSession>(
    `SELECT * FROM sessions WHERE id = ?`
  ).get(id);
}

export function getSessions(
  page: number,
  limit: number
): { sessions: DbSession[]; total: number } {
  const db = getDb();
  const offset = (page - 1) * limit;
  const sessions = db.prepare<[number, number], DbSession>(
    `SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  const { total } = db.prepare<[], { total: number }>(
    `SELECT COUNT(*) AS total FROM sessions`
  ).get()!;
  return { sessions, total };
}

// Sessions visible to a user (where their devices were involved)
export function getSessionsForUser(
  userId: string,
  page: number,
  limit: number
): { sessions: DbSession[]; total: number } {
  const db = getDb();
  const offset = (page - 1) * limit;

  const sessions = db.prepare<[string, string, number, number], DbSession>(`
    SELECT s.*
    FROM sessions s
    WHERE s.controller_device_id IN (SELECT device_id FROM devices WHERE user_id = ?)
       OR s.target_device_id     IN (SELECT device_id FROM devices WHERE user_id = ?)
    ORDER BY s.started_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, limit, offset);

  const { total } = db.prepare<[string, string], { total: number }>(`
    SELECT COUNT(*) AS total
    FROM sessions s
    WHERE s.controller_device_id IN (SELECT device_id FROM devices WHERE user_id = ?)
       OR s.target_device_id     IN (SELECT device_id FROM devices WHERE user_id = ?)
  `).get(userId, userId)!;

  return { sessions, total };
}

export function getActiveSessionsForUser(userId: string): number {
  const result = getDb().prepare<[string, string], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM sessions s
    WHERE (s.controller_device_id IN (SELECT device_id FROM devices WHERE user_id = ?)
       OR s.target_device_id     IN (SELECT device_id FROM devices WHERE user_id = ?))
    AND s.ended_at IS NULL
  `).get(userId, userId);
  return result?.count ?? 0;
}

export function getSessionsForUserSince(
  userId: string,
  sinceUnix: number
): number {
  const result = getDb().prepare<[string, string, number], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM sessions s
    WHERE (s.controller_device_id IN (SELECT device_id FROM devices WHERE user_id = ?)
       OR s.target_device_id     IN (SELECT device_id FROM devices WHERE user_id = ?))
    AND s.started_at >= ?
  `).get(userId, userId, sinceUnix);
  return result?.count ?? 0;
}

// ---------------------------------------------------------------------------
// User settings queries
// ---------------------------------------------------------------------------

export function getUserSettings(userId: string): DbUserSettings | undefined {
  return getDb().prepare<[string], DbUserSettings>(
    `SELECT * FROM user_settings WHERE user_id = ?`
  ).get(userId);
}

export function upsertUserSettings(
  userId: string,
  theme: string,
  notifications: boolean,
  autoAnswer: boolean
): DbUserSettings {
  getDb().prepare(`
    INSERT INTO user_settings (user_id, theme, notifications, auto_answer, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      theme         = excluded.theme,
      notifications = excluded.notifications,
      auto_answer   = excluded.auto_answer,
      updated_at    = unixepoch()
  `).run(userId, theme, notifications ? 1 : 0, autoAnswer ? 1 : 0);

  return getUserSettings(userId)!;
}

// ---------------------------------------------------------------------------
// Audit log queries
// ---------------------------------------------------------------------------

export function createAuditLog(
  userId: string | null,
  deviceId: string | null,
  action: string,
  resource?: string,
  detail?: string,
  ip?: string
): void {
  getDb().prepare(
    `INSERT INTO audit_logs (user_id, device_id, action, resource, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId ?? null,
    deviceId ?? null,
    action,
    resource ?? null,
    detail ?? null,
    ip ?? null
  );
}

export function getAuditLogs(
  userId: string,
  page: number,
  limit: number
): { logs: DbAuditLog[]; total: number } {
  const db = getDb();
  const offset = (page - 1) * limit;

  const logs = db.prepare<[string, number, number], DbAuditLog>(
    `SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(userId, limit, offset);

  const { total } = db.prepare<[string], { total: number }>(
    `SELECT COUNT(*) AS total FROM audit_logs WHERE user_id = ?`
  ).get(userId)!;

  return { logs, total };
}

// ---------------------------------------------------------------------------
// Team queries
// ---------------------------------------------------------------------------

export function createTeam(id: string, name: string, ownerId: string): DbTeam {
  const db = getDb();
  db.prepare(
    `INSERT INTO teams (id, name, owner_id) VALUES (?, ?, ?)`
  ).run(id, name, ownerId);

  // Auto-add the creator as owner member
  db.prepare(
    `INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`
  ).run(id, ownerId);

  return getTeamById(id)!;
}

export function getTeamById(id: string): DbTeam | undefined {
  return getDb().prepare<[string], DbTeam>(
    `SELECT * FROM teams WHERE id = ?`
  ).get(id);
}

export function getTeamsByUserId(userId: string): DbTeam[] {
  return getDb().prepare<[string], DbTeam>(`
    SELECT t.*
    FROM teams t
    INNER JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId);
}

export function addTeamMember(teamId: string, userId: string, role: string): void {
  getDb().prepare(
    `INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(teamId, userId, role);
}

export function removeTeamMember(teamId: string, userId: string): boolean {
  const result = getDb().prepare(
    `DELETE FROM team_members WHERE team_id = ? AND user_id = ?`
  ).run(teamId, userId);
  return result.changes > 0;
}

export function updateMemberRole(teamId: string, userId: string, role: string): boolean {
  const result = getDb().prepare(
    `UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?`
  ).run(role, teamId, userId);
  return result.changes > 0;
}

export function getTeamMembers(teamId: string): (DbTeamMember & { email: string; name: string })[] {
  return getDb().prepare<[string], DbTeamMember & { email: string; name: string }>(`
    SELECT tm.*, u.email, u.name
    FROM team_members tm
    INNER JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.invited_at ASC
  `).all(teamId);
}

export function getMemberRole(teamId: string, userId: string): string | null {
  const row = getDb().prepare<[string, string], { role: string }>(
    `SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`
  ).get(teamId, userId);
  return row?.role ?? null;
}

export function updateTeamName(id: string, name: string): DbTeam | undefined {
  const result = getDb().prepare(
    `UPDATE teams SET name = ? WHERE id = ?`
  ).run(name, id);
  if (result.changes === 0) return undefined;
  return getTeamById(id);
}

export function deleteTeam(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM teams WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Role permission helpers
// ---------------------------------------------------------------------------

export function canManageTeam(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export function canViewTeam(role: string): boolean {
  return ['owner', 'admin', 'member', 'viewer'].includes(role);
}

// ---------------------------------------------------------------------------
// API key interfaces and queries
// ---------------------------------------------------------------------------

export interface DbApiKey {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used: number | null;
  created_at: number;
}

export function createApiKey(
  id: string,
  userId: string,
  name: string,
  keyHash: string,
  keyPrefix: string
): DbApiKey {
  getDb().prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, name, keyHash, keyPrefix);
  return getDb().prepare<[string], DbApiKey>(
    `SELECT * FROM api_keys WHERE id = ?`
  ).get(id)!;
}

export function getApiKeysByUserId(userId: string): DbApiKey[] {
  return getDb().prepare<[string], DbApiKey>(
    `SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId);
}

export function getApiKeyByHash(hash: string): DbApiKey | undefined {
  return getDb().prepare<[string], DbApiKey>(
    `SELECT * FROM api_keys WHERE key_hash = ?`
  ).get(hash);
}

export function revokeApiKey(id: string, userId: string): boolean {
  const result = getDb().prepare(
    `DELETE FROM api_keys WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  return result.changes > 0;
}

export function touchApiKeyLastUsed(id: string): void {
  getDb().prepare(
    `UPDATE api_keys SET last_used = unixepoch() WHERE id = ?`
  ).run(id);
}
