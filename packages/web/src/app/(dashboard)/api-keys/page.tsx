'use client';

import { useState, useEffect, FormEvent } from 'react';
import { Key, Plus, Trash2, Copy, Check, AlertCircle, Clock, Eye, EyeOff } from 'lucide-react';
import { getApiKeys, createApiKey, revokeApiKey, type ApiKey } from '@/lib/api';
import clsx from 'clsx';

function formatDate(ts: number | null): string {
  if (!ts) return 'Never';
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'Never used';
  const diff = Date.now() - ts * 1000;
  if (diff < 60_000) return 'Just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [showNewKey, setShowNewKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Revoke
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const { keys: k } = await getApiKeys();
      setKeys(k);
    } catch {
      setError('Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { key, apiKey } = await createApiKey(newKeyName.trim());
      setKeys((prev) => [apiKey, ...prev]);
      setNewKeyValue(key);
      setShowNewKey(false);
      setNewKeyName('');
    } catch {
      setCreateError('Failed to create API key. Try again.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(id);
    try {
      await revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch {
      // silently fail — user can retry
    } finally {
      setRevoking(null);
    }
  }

  async function copyKey() {
    if (!newKeyValue) return;
    await navigator.clipboard.writeText(newKeyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-dark-text">API Keys</h1>
        <p className="text-sm text-dark-muted mt-1">
          Use API keys to authenticate programmatic access to DoomsDesk.
          Keys inherit your account permissions — treat them like passwords.
        </p>
      </div>

      {/* New key banner — shown immediately after creation */}
      {newKeyValue && (
        <div className="mb-6 rounded-xl border border-accent/30 bg-accent/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-sm font-medium text-dark-text">
              Copy your key now — it won&apos;t be shown again.
            </span>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <div className="flex-1 font-mono text-xs bg-dark-surface border border-dark-border rounded-lg px-3 py-2.5 text-dark-text overflow-hidden">
              {showNewKey ? newKeyValue : '•'.repeat(Math.min(newKeyValue.length, 40))}
            </div>
            <button
              onClick={() => setShowNewKey((v) => !v)}
              className="p-2 rounded-lg border border-dark-border text-dark-muted hover:text-dark-text transition"
              title={showNewKey ? 'Hide key' : 'Show key'}
            >
              {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            <button
              onClick={copyKey}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition',
                copied
                  ? 'bg-green-500/10 text-green-400 border border-green-500/30'
                  : 'bg-accent text-white hover:bg-accent/90'
              )}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={() => setNewKeyValue(null)}
              className="p-2 rounded-lg border border-dark-border text-dark-muted hover:text-dark-text transition"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <div className="mb-6 rounded-xl border border-dark-border bg-dark-surface p-4">
        <h2 className="text-sm font-semibold text-dark-text mb-3 flex items-center gap-2">
          <Plus className="w-4 h-4 text-accent" />
          Create new key
        </h2>
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. CI/CD, Home server)"
            maxLength={60}
            className="flex-1 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-dark-text placeholder-dark-muted focus:outline-none focus:border-accent/60 transition"
          />
          <button
            type="submit"
            disabled={creating || !newKeyName.trim()}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent/90 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
        {createError && (
          <p className="mt-2 text-xs text-red-400 flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" /> {createError}
          </p>
        )}
      </div>

      {/* Keys list */}
      {loading ? (
        <div className="text-sm text-dark-muted animate-pulse">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-400">{error}</div>
      ) : keys.length === 0 ? (
        <div className="rounded-xl border border-dark-border bg-dark-surface p-8 text-center">
          <Key className="w-8 h-8 text-dark-border mx-auto mb-3" />
          <p className="text-sm text-dark-muted">No API keys yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center gap-4 rounded-xl border border-dark-border bg-dark-surface px-4 py-3"
            >
              <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                <Key className="w-4 h-4 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-dark-text truncate">{key.name}</span>
                  <span className="font-mono text-xs text-dark-muted bg-dark-bg border border-dark-border rounded px-1.5 py-0.5">
                    {key.prefix}…
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-dark-muted flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {timeAgo(key.lastUsed)}
                  </span>
                  <span className="text-xs text-dark-muted">
                    Created {formatDate(key.createdAt)}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleRevoke(key.id)}
                disabled={revoking === key.id}
                className="p-2 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                title="Revoke key"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Usage note */}
      <div className="mt-6 rounded-xl border border-dark-border bg-dark-surface p-4">
        <h3 className="text-xs font-semibold text-dark-text mb-2">Usage</h3>
        <div className="space-y-1.5 text-xs text-dark-muted font-mono">
          <div>
            <span className="text-dark-text/60">Header:</span>{' '}
            <span className="text-accent">X-API-Key: dd_your_key_here</span>
          </div>
          <div>
            <span className="text-dark-text/60">Or:</span>{' '}
            <span className="text-accent">Authorization: ApiKey dd_your_key_here</span>
          </div>
        </div>
      </div>
    </div>
  );
}
