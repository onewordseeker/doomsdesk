'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';
import clsx from 'clsx';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className={clsx('w-8 h-8 rounded-lg', className)} />
    );
  }

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className={clsx(
        'w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200',
        'text-dark-muted hover:text-dark-text dark:text-dark-muted dark:hover:text-dark-text',
        'light:text-light-muted light:hover:text-light-text',
        'hover:bg-dark-border dark:hover:bg-dark-border',
        className
      )}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <Sun size={16} />
      ) : (
        <Moon size={16} />
      )}
    </button>
  );
}
