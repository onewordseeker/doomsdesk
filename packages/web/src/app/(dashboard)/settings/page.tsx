'use client';

import { useState, FormEvent } from 'react';
import { User, Lock, Bell, Palette, Check, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useSettings, useAuth, useToast } from '@/lib/hooks';
import { updateSettings, changePassword } from '@/lib/api';
import { useTheme } from 'next-themes';
import clsx from 'clsx';

function SectionHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 mb-5 pb-4 border-b border-dark-border">
      <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0 text-accent">
        {icon}
      </div>
      <div>
        <h2 className="text-sm font-semibold text-dark-text">{title}</h2>
        <p className="text-xs text-dark-muted mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between cursor-pointer group py-2">
      <span className="text-sm text-dark-muted group-hover:text-dark-text transition-colors">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative w-10 h-5.5 rounded-full transition-colors duration-200 flex-shrink-0',
          checked ? 'bg-accent' : 'bg-dark-border'
        )}
        style={{ height: '22px', minWidth: '40px' }}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 w-4.5 h-4.5 bg-white rounded-full shadow transition-transform duration-200',
          )}
          style={{
            width: '18px',
            height: '18px',
            transform: checked ? 'translateX(18px)' : 'translateX(0)',
          }}
        />
      </button>
    </label>
  );
}

export default function SettingsPage() {
  const { settings, setSettings, loading } = useSettings();
  const { user } = useAuth();
  const { addToast, toasts, removeToast } = useToast();
  const { theme, setTheme } = useTheme();

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  async function handlePasswordSave(e: FormEvent) {
    e.preventDefault();
    setPasswordError('');
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      addToast('Password changed', 'success');
    } catch (err) {
      setPasswordError((err as Error).message || 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse bg-dark-surface border border-dark-border rounded-xl h-48" />
        <div className="animate-pulse bg-dark-surface border border-dark-border rounded-xl h-64" />
        <div className="animate-pulse bg-dark-surface border border-dark-border rounded-xl h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-dark-text">Settings</h1>
        <p className="text-sm text-dark-muted mt-1">Manage your account and preferences</p>
      </div>

      {/* Profile */}
      <div className="bg-dark-surface border border-dark-border rounded-xl p-6">
        <SectionHeader
          icon={<User size={16} />}
          title="Profile"
          description="Your account information"
        />
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1">Full name</p>
            <p className="text-sm text-dark-text">{user?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1">Email address</p>
            <p className="text-sm text-dark-text">{user?.email ?? '—'}</p>
          </div>
        </div>
      </div>

      {/* Security */}
      <div className="bg-dark-surface border border-dark-border rounded-xl p-6">
        <SectionHeader
          icon={<Lock size={16} />}
          title="Security"
          description="Change your account password"
        />
        {passwordError && (
          <div className="mb-4 flex items-center gap-2.5 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg px-3.5 py-3">
            <AlertCircle size={15} className="flex-shrink-0" />
            <span>{passwordError}</span>
          </div>
        )}
        <form onSubmit={handlePasswordSave} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">Current password</label>
            <div className="relative">
              <input
                type={showCurrentPw ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="input-base pr-10"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPw(!showCurrentPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-muted hover:text-dark-text transition-colors"
              >
                {showCurrentPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">New password</label>
            <div className="relative">
              <input
                type={showNewPw ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="input-base pr-10"
              />
              <button
                type="button"
                onClick={() => setShowNewPw(!showNewPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-muted hover:text-dark-text transition-colors"
              >
                {showNewPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              placeholder="••••••••"
              className={clsx(
                'input-base',
                confirmPassword && newPassword !== confirmPassword && 'border-danger focus:border-danger focus:ring-danger/20'
              )}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={passwordSaving}
              className="btn-primary flex items-center gap-2"
            >
              {passwordSaving ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Lock size={15} />
              )}
              Change Password
            </button>
          </div>
        </form>
      </div>

      {/* Notifications */}
      <div className="bg-dark-surface border border-dark-border rounded-xl p-6">
        <SectionHeader
          icon={<Bell size={16} />}
          title="Notifications"
          description="Toggle all notifications on or off"
        />
        <Toggle
          label="Receive notifications"
          checked={settings?.notifications ?? false}
          onChange={async (v) => {
            try {
              const updated = await updateSettings({ notifications: v });
              setSettings(updated);
            } catch {
              addToast('Failed to save notification preference', 'error');
            }
          }}
        />
      </div>

      {/* Preferences */}
      <div className="bg-dark-surface border border-dark-border rounded-xl p-6">
        <SectionHeader
          icon={<Palette size={16} />}
          title="Appearance"
          description="Customize how DoomsDesk looks"
        />
        <div>
          <p className="text-xs font-semibold text-dark-muted uppercase tracking-wider mb-3">Theme</p>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={clsx(
                  'flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all duration-150 capitalize',
                  theme === t
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-dark-border text-dark-muted hover:border-dark-muted/50 hover:text-dark-text'
                )}
              >
                {t === 'dark' ? '🌙' : '☀️'} {t.charAt(0).toUpperCase() + t.slice(1)}
                {theme === t && <Check size={13} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Toast notifications */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl text-sm font-medium animate-slide-in cursor-pointer',
              toast.type === 'success' && 'bg-success/10 border-success/30 text-success',
              toast.type === 'error' && 'bg-danger/10 border-danger/30 text-danger',
              toast.type === 'info' && 'bg-dark-surface border-dark-border text-dark-text',
            )}
            onClick={() => removeToast(toast.id)}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
