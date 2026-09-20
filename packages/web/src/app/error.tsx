'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html>
      <body className="min-h-screen bg-dark-bg flex items-center justify-center">
        <div className="text-center space-y-5 px-4">
          <div className="w-14 h-14 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center mx-auto">
            <AlertTriangle size={24} className="text-danger" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Something went wrong</h2>
            <p className="text-sm text-slate-400 mt-1">An unexpected error occurred.</p>
          </div>
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
