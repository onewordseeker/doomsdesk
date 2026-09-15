'use client';

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Zap, Mail, Lock, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { login, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await login(email, password);
      setToken(token);
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message || 'Invalid email or password');
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
        <h1 className="text-2xl font-bold text-dark-text tracking-tight">DoomsDesk</h1>
        <p className="text-sm text-dark-muted mt-1">Sign in to your account</p>
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
                autoComplete="current-password"
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
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>

      {/* Register link */}
      <p className="text-center text-sm text-dark-muted mt-5">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="text-accent hover:text-accent-light font-medium transition-colors">
          Create one
        </Link>
      </p>
    </div>
  );
}
