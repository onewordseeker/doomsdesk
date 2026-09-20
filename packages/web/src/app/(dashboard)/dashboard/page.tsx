'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Monitor, Activity, Calendar, Zap, ExternalLink, Clock, ArrowRight } from 'lucide-react';
import { StatsCard } from '@/components/StatsCard';
import { DeviceStatusBadge } from '@/components/DeviceStatusBadge';
import { useDashboard, useAuth } from '@/lib/hooks';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts * 1000));
}

// Skeleton shimmer for loading state
function Skeleton({ className }: { className: string }) {
  return (
    <div className={`animate-pulse bg-dark-border/50 rounded-lg ${className}`} />
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { stats, loading } = useDashboard();
  const router = useRouter();
  const [quickConnectId, setQuickConnectId] = useState('');

  function handleQuickConnect(e: FormEvent) {
    e.preventDefault();
    if (!quickConnectId.trim()) return;
    router.push(`/viewer?id=${encodeURIComponent(quickConnectId.trim())}`);
  }

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-dark-text">
          {greeting()}{user ? `, ${user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="text-sm text-dark-muted mt-1">Here&apos;s what&apos;s happening with your devices.</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))
        ) : (
          <>
            <StatsCard
              title="Online Devices"
              value={stats?.onlineDevices ?? 0}
              subtitle={`of ${stats?.totalDevices ?? 0} total`}
              icon={<Monitor size={18} />}
              accent="success"
            />
            <StatsCard
              title="Active Sessions"
              value={stats?.activeSessions ?? 0}
              subtitle="Right now"
              icon={<Activity size={18} />}
              accent="default"
            />
            <StatsCard
              title="Sessions This Month"
              value={stats?.sessionsThisMonth ?? 0}
              icon={<Calendar size={18} />}
            />
            <StatsCard
              title="Total Devices"
              value={stats?.totalDevices ?? 0}
              icon={<Zap size={18} />}
              accent="warning"
            />
          </>
        )}
      </div>

      {/* Quick connect */}
      <div className="bg-dark-surface border border-dark-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <ExternalLink size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-dark-text">Quick Connect</h2>
        </div>
        <p className="text-xs text-dark-muted mb-4">Enter a device ID to launch the desktop app and connect instantly.</p>
        <form onSubmit={handleQuickConnect} className="flex gap-2">
          <input
            type="text"
            value={quickConnectId}
            onChange={(e) => setQuickConnectId(e.target.value)}
            placeholder="Enter device ID (e.g. DD-1234-ABCD)"
            className="input-base flex-1"
          />
          <button
            type="submit"
            className="btn-primary flex items-center gap-2 px-5 whitespace-nowrap"
          >
            Connect
            <ArrowRight size={15} />
          </button>
        </form>
      </div>

      {/* Recent sessions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-dark-text flex items-center gap-2">
            <Clock size={15} className="text-dark-muted" />
            Recent Sessions
          </h2>
          <a href="/sessions" className="text-xs text-accent hover:text-accent-light transition-colors font-medium">
            View all
          </a>
        </div>

        <div className="bg-dark-surface border border-dark-border rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !stats?.recentSessions?.length ? (
            <div className="py-16 text-center">
              <Clock size={32} className="text-dark-muted/40 mx-auto mb-3" />
              <p className="text-sm text-dark-muted">No sessions yet</p>
              <p className="text-xs text-dark-muted/60 mt-1">Connect to a device to get started</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-border">
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3">Controller</th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3">Target Device</th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3">Duration</th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3">Date</th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentSessions.map((session, i) => (
                  <tr
                    key={session.id}
                    className="border-b border-dark-border/50 hover:bg-dark-border/20 transition-colors"
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-dark-text">{session.controllerDeviceId}</p>
                    </td>
                    <td className="px-5 py-3.5 text-dark-muted">{session.targetDeviceId}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-dark-text">{formatDuration(session.durationSeconds ?? 0)}</td>
                    <td className="px-5 py-3.5 text-dark-muted text-xs">{formatDate(session.startedAt)}</td>
                    <td className="px-5 py-3.5">
                      <DeviceStatusBadge status={session.endedAt === null ? 'online' : 'offline'} showLabel={false} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
