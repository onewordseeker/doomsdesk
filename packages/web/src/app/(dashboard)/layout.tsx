'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';
import { Sidebar } from '@/components/Sidebar';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
    }
  }, [router]);

  return (
    <div className="flex h-screen overflow-hidden bg-dark-bg dark:bg-dark-bg">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
