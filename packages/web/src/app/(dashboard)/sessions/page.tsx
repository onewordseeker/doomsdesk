'use client';

import { useState } from 'react';
import { Clock, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useSessions } from '@/lib/hooks';
import clsx from 'clsx';

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts * 1000));
}

export default function SessionsPage() {
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');

  const { sessions, total, totalPages, loading } = useSessions(page, 20);

  const filteredSessions = sessions.filter((s) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      s.controllerDeviceId.toLowerCase().includes(q) ||
      s.targetDeviceId.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-dark-text">Sessions</h1>
        <p className="text-sm text-dark-muted mt-1">
          {total > 0 ? `${total} session${total !== 1 ? 's' : ''} total` : 'Session history'}
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by device ID..."
          className="input-base pl-9 w-full max-w-sm"
        />
      </div>

      {/* Table */}
      <div className="bg-dark-surface border border-dark-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse bg-dark-border/40 rounded-lg h-14" />
            ))}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="py-20 text-center">
            <Clock size={40} className="text-dark-muted/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-dark-muted">No sessions found</p>
            <p className="text-xs text-dark-muted/60 mt-1">
              Sessions will appear here once you connect to a device
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-border">
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Controller</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Target Device</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Duration</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Started</th>
                <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">Ended</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((session, i) => (
                <tr
                  key={session.id}
                  className="border-b border-dark-border/50 hover:bg-dark-border/15 transition-colors animate-fade-in"
                  style={{ animationDelay: `${i * 25}ms` }}
                >
                  <td className="px-5 py-3.5">
                    <code className="text-xs font-mono text-dark-text">{session.controllerDeviceId}</code>
                  </td>
                  <td className="px-5 py-3.5">
                    <code className="text-xs font-mono text-dark-muted">{session.targetDeviceId}</code>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-xs text-dark-text bg-dark-bg border border-dark-border px-2 py-1 rounded">
                      {formatDuration(session.durationSeconds)}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-dark-muted whitespace-nowrap">{formatDate(session.startedAt)}</td>
                  <td className="px-5 py-3.5 text-xs text-dark-muted whitespace-nowrap">{formatDate(session.endedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-dark-muted">
            Page {page} of {totalPages} &mdash; {total} total sessions
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pageNum = totalPages <= 5 ? i + 1 : Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={clsx(
                    'w-8 h-8 rounded-lg text-sm font-medium transition-colors',
                    page === pageNum
                      ? 'bg-accent text-white'
                      : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
                  )}
                >
                  {pageNum}
                </button>
              );
            })}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-2 rounded-lg text-dark-muted hover:text-dark-text hover:bg-dark-border/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
