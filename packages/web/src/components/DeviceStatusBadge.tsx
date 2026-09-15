import clsx from 'clsx';

interface DeviceStatusBadgeProps {
  status: 'online' | 'offline';
  showLabel?: boolean;
  size?: 'sm' | 'md';
}

export function DeviceStatusBadge({ status, showLabel = true, size = 'md' }: DeviceStatusBadgeProps) {
  const isOnline = status === 'online';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
        isOnline
          ? 'bg-success/10 text-success'
          : 'bg-dark-border/60 text-dark-muted dark:bg-dark-border/60 dark:text-dark-muted'
      )}
    >
      <span
        className={clsx(
          'block rounded-full flex-shrink-0',
          size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2',
          isOnline ? 'bg-success animate-pulse-dot' : 'bg-current opacity-50'
        )}
      />
      {showLabel && (isOnline ? 'Online' : 'Offline')}
    </span>
  );
}
