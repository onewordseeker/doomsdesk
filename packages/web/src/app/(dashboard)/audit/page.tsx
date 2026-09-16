'use client';

import { useState } from 'react';
import { Shield, ChevronLeft, ChevronRight, Calendar, Filter } from 'lucide-react';
import { useAuditLogs } from '@/lib/hooks';
import clsx from 'clsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts * 1000));
}

// ─── Action badge ─────────────────────────────────────────────────────────────

type BadgeVariant = 'red' | 'green' | 'blue' | 'gray' | 'yellow' | 'default';

const ACTION_COLORS: Record<string, BadgeVariant> = {
  auth_failed: 'red',
  login: 'green',
  logout: 'gray',
  register: 'green',
  device_connected: 'blue',
  device_disconnected: 'gray',
  session_started: 'green',
  session_ended: 'gray',
  device_deleted: 'red',
  member_invited: 'blue',
  member_removed: 'yellow',
  role_changed: 'yellow',
  team_created: 'blue',
  team_deleted: 'red',
  settings_updated: 'default',
};

const BADGE_CLASS: Record<BadgeVariant, string> = {
  red: 'bg-danger/10 text-danger border-danger/20',
  green: 'bg-success/10 text-success border-success/20',
  blue: 'bg-accent/10 text-accent border-accent/20',
  gray: 'bg-dark-border/50 text-dark-muted border-dark-border/60',
  yellow: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/20',
  default: 'bg-dark-bg text-dark-muted border-dark-border',
};

function ActionBadge({ action }: { action: string }) {
  const variant: BadgeVariant = ACTION_COLORS[action] ?? 'default';
  return (
    <span
      className={clsx(
        'inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap',
        BADGE_CLASS[variant]
      )}
    >
      {action.replace(/_/g, ' ')}
    </span>
  );
}

// ─── Action category groups for filter ───────────────────────────────────────

const ACTION_CATEGORIES: Record<string, string[]> = {
  auth: ['login', 'logout', 'auth_failed', 'register'],
  device: ['device_connected', 'device_disconnected', 'device_deleted'],
  session: ['session_started', 'session_ended'],
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>('all');

  const { logs, pagination, loading } = useAuditLogs(page);

  const filteredLogs = logs.filter((log) => {
    if (actionFilter === 'all') return true;
    const group = ACTION_CATEGORIES[actionFilter];
    return group ? group.includes(log.action) : true;
  });

  const totalPages = pagination?.pages ?? 1;
  const total = pagination?.total ?? 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-dark-text">Audit Log</h1>
        <p className="text-sm text-dark-muted mt-1">Security events for your account</p>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Action filter */}
        <div className="flex items-center gap-1 bg-dark-surface border border-dark-border rounded-xl p-1">
          {(['all', 'auth', 'device', 'session'] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => { setActionFilter(cat); setPage(1); }}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 capitalize',
                actionFilter === cat
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
              )}
            >
              {cat === 'all' && <Filter size={11} />}
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>

        {/* Date range (UI only) */}
        <div className="flex items-center gap-2 bg-dark-surface border border-dark-border rounded-xl px-3 py-2 text-xs text-dark-muted cursor-not-allowed opacity-60">
          <Calendar size={13} />
          <span>Date range</span>
          <ChevronLeft size={11} className="rotate-180 ml-1" />
        </div>

        {total > 0 && (
          <span className="text-xs text-dark-muted ml-auto">
            {total} event{total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-dark-surface border border-dark-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="animate-pulse bg-dark-border/40 rounded-lg h-12" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-14 h-14 rounded-full bg-dark-border/40 flex items-center justify-center mx-auto mb-4">
              <Shield size={28} className="text-dark-muted/40" />
            </div>
            <p className="text-sm font-medium text-dark-muted">No audit events found</p>
            <p className="text-xs text-dark-muted/60 mt-1">
              Security events will appear here as activity occurs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-dark-border">
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5 whitespace-nowrap">
                    Timestamp
                  </th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">
                    Action
                  </th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">
                    Resource
                  </th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">
                    Device / User
                  </th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">
                    IP
                  </th>
                  <th className="text-left text-xs font-semibold text-dark-muted uppercase tracking-wider px-5 py-3.5">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log, i) => (
                  <tr
                    key={log.id}
                    className="border-b border-dark-border/50 hover:bg-dark-border/15 transition-colors animate-fade-in"
                    style={{ animationDelay: `${i * 20}ms` }}
                  >
                    {/* Timestamp */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <span className="text-xs text-dark-muted font-mono">
                        {formatTimestamp(log.createdAt)}
                      </span>
                    </td>

                    {/* Action */}
                    <td className="px-5 py-3.5">
                      <ActionBadge action={log.action} />
                    </td>

                    {/* Resource */}
                    <td className="px-5 py-3.5">
                      {log.resource ? (
                        <code className="text-xs text-dark-muted font-mono bg-dark-bg border border-dark-border px-1.5 py-0.5 rounded">
                          {log.resource}
                        </code>
                      ) : (
                        <span className="text-xs text-dark-muted/40">—</span>
                      )}
                    </td>

                    {/* Device / User */}
                    <td className="px-5 py-3.5">
                      {log.deviceId || log.userId ? (
                        <code className="text-xs text-dark-muted font-mono">
                          {log.deviceId ?? log.userId}
                        </code>
                      ) : (
                        <span className="text-xs text-dark-muted/40">—</span>
                      )}
                    </td>

                    {/* IP */}
                    <td className="px-5 py-3.5">
                      {log.ip ? (
                        <span className="text-xs font-mono text-dark-muted">{log.ip}</span>
                      ) : (
                        <span className="text-xs text-dark-muted/40">—</span>
                      )}
                    </td>

                    {/* Detail */}
                    <td className="px-5 py-3.5 max-w-[200px]">
                      {log.detail ? (
                        <span
                          className="text-xs text-dark-muted truncate block max-w-[180px]"
                          title={log.detail}
                        >
                          {log.detail}
                        </span>
                      ) : (
                        <span className="text-xs text-dark-muted/40">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-dark-muted">
            Page {page} of {totalPages} &mdash; {total} total events
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
              const pageNum =
                totalPages <= 5
                  ? i + 1
                  : Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
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
