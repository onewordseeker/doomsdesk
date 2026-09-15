import type { ReactNode } from 'react';
import clsx from 'clsx';

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ReactNode;
  trend?: { value: number; label: string };
  accent?: 'default' | 'success' | 'warning' | 'danger';
}

export function StatsCard({ title, value, subtitle, icon, trend, accent = 'default' }: StatsCardProps) {
  const accentColors = {
    default: 'text-accent bg-accent/10',
    success: 'text-success bg-success/10',
    warning: 'text-warning bg-warning/10',
    danger: 'text-danger bg-danger/10',
  };

  return (
    <div className={clsx(
      'rounded-xl p-5 border transition-all duration-200',
      'bg-dark-surface border-dark-border dark:bg-dark-surface dark:border-dark-border',
      'hover:border-accent/30 hover:shadow-glow group animate-fade-in'
    )}>
      <div className="flex items-start justify-between mb-4">
        <div className={clsx(
          'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform duration-200 group-hover:scale-110',
          accentColors[accent]
        )}>
          {icon}
        </div>
        {trend && (
          <span className={clsx(
            'text-xs font-medium px-2 py-0.5 rounded-full',
            trend.value >= 0 ? 'text-success bg-success/10' : 'text-danger bg-danger/10'
          )}>
            {trend.value >= 0 ? '+' : ''}{trend.value}% {trend.label}
          </span>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold text-dark-text dark:text-dark-text tabular-nums">{value}</p>
        <p className="text-sm font-medium text-dark-muted mt-0.5">{title}</p>
        {subtitle && (
          <p className="text-xs text-dark-muted/70 mt-1">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
