import Link from 'next/link';
import { Zap, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-dark-bg flex items-center justify-center">
      <div className="text-center space-y-6 px-4">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto">
          <Zap size={28} className="text-accent" />
        </div>
        <div>
          <h1 className="text-4xl font-bold text-dark-text">404</h1>
          <p className="text-sm text-dark-muted mt-2">This page doesn&apos;t exist.</p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          <Home size={15} />
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
