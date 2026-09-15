import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-dark-bg flex flex-col items-center justify-center px-4">
      {/* Subtle radial gradient behind the form */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-accent/5 blur-3xl" />
      </div>
      <div className="relative w-full max-w-sm">
        {children}
      </div>
    </div>
  );
}
