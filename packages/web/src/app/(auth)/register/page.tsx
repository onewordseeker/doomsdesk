'use client';

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Zap, User, Mail, Lock, AlertCircle, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { register, setToken } from '@/lib/api';

function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: '8+ characters', ok: password.length >= 8 },
    { label: 'Uppercase', ok: /[A-Z]/.test(password) },
    { label: 'Number', ok: /\d/.test(password) },
  ];
  if (!password) return null;
  return (
    <div className="flex gap-2 mt-1.5">
      {checks.map(({ label, ok }) => (
        <span
          key={label}
          className={`flex items-center gap-1 text-[10px] font-medium transition-colors ${ok ? 'text-success' : 'text-dark-muted'}`}
        >
          <CheckCircle2 size={10} className={ok ? 'text-success' : 'text-dark-muted/40'} />
          {label}
        </span>
      ))}
    </div>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const { token } = await register(name, email, password);
      setToken(token);
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-fade-in">
      {/* Logo */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-12 h-12 rounded-2xl bg-accent flex items-center justify-center shadow-glow mb-4">
          <Zap size={22} className="text-white" />
        </div>
        <h1 className="text-2xl font-bold text-dark-text tracking-tight">Create account</h1>
        <p className="text-sm text-dark-muted mt-1">Start using DoomsDesk for free</p>
      </div>

      {/* Card */}
      <div className="bg-dark-surface border border-dark-border rounded-2xl p-7 shadow-card-dark">
        {error && (
          <div className="mb-5 flex items-center gap-2.5 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg px-3.5 py-3 animate-fade-in">
            <AlertCircle size={15} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Full name
            </label>
            <div className="relative">
              <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                required
                autoComplete="name"
                className="input-base pl-9"
              />
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Email
            </label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="input-base pl-9"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-dark-muted uppercase tracking-wider mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-muted pointer-events-none" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
                className="input-base pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-muted hover:text-dark-text transition-colors"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <PasswordStrength password={password} />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full mt-2 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Creating account...
              </>
            ) : (
              'Create account'
            )}
          </button>
        </form>
      </div>

      {/* Login link */}
      <p className="text-center text-sm text-dark-muted mt-5">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:text-accent-light font-medium transition-colors">
          Sign in
        </Link>
      </p>

      <p className="text-center text-xs text-dark-muted/50 mt-4">
        By creating an account, you agree to our Terms of Service and Privacy Policy.
      </p>
    </div>
  );
}
