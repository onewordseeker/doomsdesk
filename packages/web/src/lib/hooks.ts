'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getToken,
  getMe,
  getDevices,
  getSessions,
  getDashboardStats,
  getMyBilling,
  getPlans,
  getSettings,
  getTeams,
  getAuditLogs,
  logout,
  type User,
  type Device,
  type Session,
  type DashboardStats,
  type BillingInfo,
  type Plan,
  type Settings,
  type PaginatedResponse,
  type Team,
  type AuditLog,
} from './api';

// ─── useAuth ──────────────────────────────────────────────────────────────────

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      router.replace('/login');
      return;
    }
    getMe()
      .then((u) => setUser(u))
      .catch(() => {
        logout();
        router.replace('/login');
      })
      .finally(() => setLoading(false));
  }, [router]);

  const handleLogout = useCallback(() => {
    logout();
    router.replace('/login');
  }, [router]);

  return { user, loading, logout: handleLogout };
}

// ─── useDevices ───────────────────────────────────────────────────────────────

export function useDevices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getDevices();
      setDevices(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  return { devices, loading, error, refresh: fetchDevices };
}

// ─── useSessions ──────────────────────────────────────────────────────────────

export function useSessions(page = 1, limit = 20) {
  const [result, setResult] = useState<PaginatedResponse<Session> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSessions(page, limit);
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, limit]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return { sessions: result?.data ?? [], total: result?.total ?? 0, totalPages: result?.totalPages ?? 0, loading, error, refresh: fetchSessions };
}

// ─── useDashboard ─────────────────────────────────────────────────────────────

export function useDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return { stats, loading, error };
}

// ─── useBilling ───────────────────────────────────────────────────────────────

export function useBilling() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getMyBilling(), getPlans()])
      .then(([b, p]) => {
        setBilling(b);
        setPlans(p);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return { billing, plans, loading, error };
}

// ─── useSettings ──────────────────────────────────────────────────────────────

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return { settings, setSettings, loading, error };
}

// ─── useTeams ─────────────────────────────────────────────────────────────────

export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getTeams();
      setTeams(data.teams);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  return { teams, loading, error, refresh: fetchTeams };
}

// ─── useAuditLogs ─────────────────────────────────────────────────────────────

export function useAuditLogs(page = 1) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<{ page: number; limit: number; total: number; pages: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAuditLogs(page, 20);
      setLogs(data.logs);
      setPagination(data.pagination);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return { logs, pagination, loading, error };
}

// ─── useToast ─────────────────────────────────────────────────────────────────

export type Toast = { id: string; message: string; type: 'success' | 'error' | 'info' };

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
}
