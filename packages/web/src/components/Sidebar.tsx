'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Monitor,
  Clock,
  CreditCard,
  Settings,
  LogOut,
  Zap,
  ChevronRight,
  type LucideProps,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { getMe, getToken, clearToken } from '@/lib/api';
import { useEffect, useState, type ForwardRefExoticComponent, type RefAttributes } from 'react';
import clsx from 'clsx';

type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/devices', label: 'Devices', icon: Monitor },
  { href: '/sessions', label: 'Sessions', icon: Clock },
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface UserInfo {
  name: string;
  email: string;
  plan: string;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    getMe()
      .then((u) => setUser({ name: u.name, email: u.email, plan: u.plan }))
      .catch(() => {});
  }, []);

  function handleLogout() {
    clearToken();
    router.replace('/login');
  }

  return (
    <aside className={clsx(
      'w-60 flex-shrink-0 flex flex-col h-screen sticky top-0',
      'bg-dark-surface border-r border-dark-border',
      'dark:bg-dark-surface dark:border-dark-border'
    )}>
      {/* Logo */}
      <div className="px-5 py-6 border-b border-dark-border">
        <Link href="/dashboard" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shadow-glow flex-shrink-0 transition-transform duration-200 group-hover:scale-105">
            <Zap size={16} className="text-white" />
          </div>
          <div className="leading-tight">
            <span className="text-sm font-bold text-dark-text tracking-tight">DoomsDesk</span>
            <p className="text-[10px] text-dark-muted font-medium tracking-wider uppercase">Remote Access</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-dark-muted/60 px-2 mb-2">Navigation</p>
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group relative',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/40'
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-accent rounded-r-full" />
              )}
              <Icon
                size={17}
                className={clsx(
                  'flex-shrink-0 transition-colors',
                  active ? 'text-accent' : 'text-dark-muted group-hover:text-dark-text'
                ) as string}
              />
              <span className="flex-1">{label}</span>
              {active && <ChevronRight size={13} className="text-accent/60" />}
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-dark-border px-3 py-3 space-y-2">
        {/* Theme toggle row */}
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-dark-muted">Theme</span>
          <ThemeToggle />
        </div>

        {/* User info */}
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-dark-border/30 transition-colors group">
            <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0 border border-accent/30">
              <span className="text-xs font-bold text-accent">
                {user.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-dark-text truncate">{user.name}</p>
              <p className="text-[10px] text-dark-muted truncate">{user.email}</p>
            </div>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent capitalize flex-shrink-0">
              {user.plan}
            </span>
          </div>
        )}

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-dark-muted hover:text-danger hover:bg-danger/8 transition-all duration-150 group"
        >
          <LogOut size={16} className="flex-shrink-0" />
          <span className="font-medium">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
