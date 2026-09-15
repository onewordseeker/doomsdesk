// In production the web console proxies /api/* to the backend via next.config rewrites
const BASE_URL = typeof window !== 'undefined' ? '/api' : (process.env.API_URL || 'http://localhost:4000') + '/api';

// ─── Token helpers ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('doomsdesk_token');
}

export function setToken(token: string): void {
  localStorage.setItem('doomsdesk_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('doomsdesk_token');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  plan: string;
  createdAt: number;
}

export interface Device {
  id: string;
  deviceId: string;
  name: string;
  lastSeen: number | null;
  createdAt: number;
  online: boolean;
  hasPermanentPassword: boolean;
}

export interface Session {
  id: string;
  controllerDeviceId: string;
  targetDeviceId: string;
  startedAt: number;
  endedAt: number | null;
  durationSeconds: number | null;
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  maxConcurrent: number;
  maxDevices: number;
  features: string[];
}

export interface BillingInfo {
  plan: Plan;
  usage: {
    devicesRegistered: number;
    devicesOnline: number;
    maxDevices: number;
    maxConcurrent: number;
  };
}

export interface Settings {
  theme: string;
  notifications: boolean;
  autoAnswer: boolean;
  updatedAt: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DashboardStats {
  totalDevices: number;
  onlineDevices: number;
  activeSessions: number;
  sessionsThisMonth: number;
  recentSessions: Session[];
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {},
  requireAuth = true
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (requireAuth) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }));
    const error = new Error(errorBody.message || `HTTP ${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }

  // 204 No Content
  if (response.status === 204) return undefined as T;

  return response.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  return request<{ token: string; user: User }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, false);
}

export async function register(name: string, email: string, password: string): Promise<{ token: string; user: User }> {
  return request<{ token: string; user: User }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  }, false);
}

export async function getMe(): Promise<User> {
  const r = await request<{ user: User }>('/auth/me');
  return r.user;
}

export async function updateProfile(name: string): Promise<User> {
  const r = await request<{ user: User }>('/auth/me', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  return r.user;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function logout(): Promise<void> {
  clearToken();
}

// ─── Devices ──────────────────────────────────────────────────────────────────

export async function getDevices(): Promise<Device[]> {
  const r = await request<{ devices: Device[] }>('/devices');
  return r.devices;
}

export async function updateDevice(
  id: string,
  data: { name?: string; permanentPassword?: string | null }
): Promise<Device> {
  const r = await request<{ device: Device }>(`/devices/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return r.device;
}

export async function deleteDevice(id: string): Promise<void> {
  return request(`/devices/${id}`, { method: 'DELETE' });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function getSessions(
  page = 1,
  limit = 20
): Promise<PaginatedResponse<Session>> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const r = await request<{
    sessions: Session[];
    pagination: { page: number; limit: number; total: number; pages: number };
  }>(`/sessions?${params.toString()}`);
  return {
    data: r.sessions,
    total: r.pagination.total,
    page: r.pagination.page,
    limit: r.pagination.limit,
    totalPages: r.pagination.pages,
  };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function getDashboardStats(): Promise<DashboardStats> {
  return request<DashboardStats>('/dashboard/stats');
}

// ─── Billing ──────────────────────────────────────────────────────────────────

export async function getPlans(): Promise<Plan[]> {
  const r = await request<{ plans: Plan[] }>('/billing/plans', {}, false);
  return r.plans;
}

export async function getMyBilling(): Promise<BillingInfo> {
  return request<BillingInfo>('/billing/me');
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const r = await request<{ settings: Settings }>('/settings');
  return r.settings;
}

export async function updateSettings(
  data: Partial<Pick<Settings, 'theme' | 'notifications' | 'autoAnswer'>>
): Promise<Settings> {
  const r = await request<{ settings: Settings }>('/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return r.settings;
}
