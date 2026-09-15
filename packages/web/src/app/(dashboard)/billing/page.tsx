'use client';

import { useState } from 'react';
import { Check, Zap, Star, Building2, X } from 'lucide-react';
import { useBilling, useToast } from '@/lib/hooks';
import type { Plan } from '@/lib/api';
import clsx from 'clsx';

const PLAN_ICONS = {
  Free: Zap,
  Pro: Star,
  Business: Building2,
};

const STATIC_PLANS: (Plan & { popular?: boolean })[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    maxDevices: 2,
    maxConcurrent: 1,
    features: [
      'Up to 2 devices',
      '1 concurrent session',
      'Standard connection quality',
      'Community support',
      '30-day session history',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 12,
    maxDevices: 10,
    maxConcurrent: 5,
    popular: true,
    features: [
      'Up to 10 devices',
      '5 concurrent sessions',
      'HD connection quality',
      'Priority email support',
      '1-year session history',
      'Multi-monitor support',
      'File transfer',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    price: 49,
    maxDevices: -1,
    maxConcurrent: -1,
    features: [
      'Unlimited devices',
      'Unlimited concurrent sessions',
      '4K Ultra HD quality',
      'Dedicated 24/7 support',
      'Unlimited session history',
      'Multi-monitor support',
      'File transfer',
      'Team management',
      'Audit logs',
      'Custom branding',
      'SSO / SAML',
    ],
  },
];

function PlanCard({
  plan,
  isCurrent,
  onUpgrade,
}: {
  plan: Plan & { popular?: boolean };
  isCurrent: boolean;
  onUpgrade: (planName: string) => void;
}) {
  const Icon = PLAN_ICONS[plan.name as keyof typeof PLAN_ICONS] || Zap;

  return (
    <div
      className={clsx(
        'relative rounded-2xl border p-6 flex flex-col transition-all duration-200',
        plan.popular
          ? 'border-accent bg-accent/5 shadow-glow'
          : 'border-dark-border bg-dark-surface hover:border-dark-muted/50',
        isCurrent && 'ring-2 ring-accent ring-offset-2 ring-offset-dark-bg'
      )}
    >
      {plan.popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="bg-accent text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-widest shadow-glow">
            Most Popular
          </span>
        </div>
      )}

      {isCurrent && (
        <div className="absolute top-4 right-4">
          <span className="bg-success/15 text-success text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider border border-success/25">
            Current
          </span>
        </div>
      )}

      <div className="mb-5">
        <div className={clsx(
          'w-10 h-10 rounded-xl flex items-center justify-center mb-4',
          plan.popular ? 'bg-accent/20 text-accent' : 'bg-dark-border text-dark-muted'
        )}>
          <Icon size={18} />
        </div>
        <h3 className="text-lg font-bold text-dark-text">{plan.name}</h3>
        <div className="flex items-end gap-1 mt-2">
          <span className="text-3xl font-black text-dark-text">${plan.price}</span>
          <span className="text-dark-muted text-sm mb-1">/ month</span>
        </div>
        {plan.price === 0 && (
          <p className="text-xs text-dark-muted mt-0.5">Free forever</p>
        )}
      </div>

      <div className="border-t border-dark-border/60 pt-5 mb-6 flex-1">
        <ul className="space-y-2.5">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5 text-sm">
              <Check size={14} className={clsx('flex-shrink-0 mt-0.5', plan.popular ? 'text-accent' : 'text-success')} />
              <span className="text-dark-muted">{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <button
        onClick={() => onUpgrade(plan.name)}
        disabled={isCurrent}
        className={clsx(
          'w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.98]',
          isCurrent
            ? 'bg-dark-border/60 text-dark-muted cursor-not-allowed'
            : plan.popular
            ? 'bg-accent hover:bg-accent-hover text-white shadow-glow'
            : 'border border-dark-border hover:border-accent/50 text-dark-text hover:text-accent'
        )}
      >
        {isCurrent ? 'Current plan' : plan.price === 0 ? 'Downgrade' : `Upgrade to ${plan.name}`}
      </button>
    </div>
  );
}

export default function BillingPage() {
  const { billing, loading } = useBilling();
  const { toasts, addToast, removeToast } = useToast();
  const [showComingSoon, setShowComingSoon] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState('');

  function handleUpgrade(planName: string) {
    setSelectedPlan(planName);
    setShowComingSoon(true);
    addToast('Payments coming soon — stay tuned!', 'info');
  }

  const currentPlan = billing?.plan.name ?? 'Free';

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-dark-text">Billing</h1>
        <p className="text-sm text-dark-muted mt-1">Manage your subscription and usage</p>
      </div>

      {/* Usage summary */}
      {billing && (
        <div className="bg-dark-surface border border-dark-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-dark-text mb-4">Current Usage</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between text-xs text-dark-muted mb-1.5">
                <span>Devices</span>
                <span>{billing.usage.devicesRegistered} / {billing.usage.maxDevices === -1 ? '∞' : billing.usage.maxDevices}</span>
              </div>
              <div className="h-1.5 rounded-full bg-dark-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{
                    width: billing.usage.maxDevices === -1
                      ? '30%'
                      : `${Math.min(100, (billing.usage.devicesRegistered / billing.usage.maxDevices) * 100)}%`
                  }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs text-dark-muted mb-1.5">
                <span>Concurrent sessions</span>
                <span>{billing.usage.devicesOnline} / {billing.usage.maxConcurrent === -1 ? '∞' : billing.usage.maxConcurrent}</span>
              </div>
              <div className="h-1.5 rounded-full bg-dark-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-success transition-all duration-500"
                  style={{
                    width: billing.usage.maxConcurrent === -1
                      ? '20%'
                      : `${Math.min(100, (billing.usage.devicesOnline / billing.usage.maxConcurrent) * 100)}%`
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plan cards */}
      {loading ? (
        <div className="grid grid-cols-3 gap-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse bg-dark-surface border border-dark-border rounded-2xl h-96" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-4">
          {STATIC_PLANS.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={currentPlan.toLowerCase() === plan.name.toLowerCase()}
              onUpgrade={handleUpgrade}
            />
          ))}
        </div>
      )}

      {/* Coming soon modal */}
      {showComingSoon && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-dark-surface border border-dark-border rounded-2xl p-8 w-full max-w-sm shadow-2xl animate-slide-in text-center">
            <div className="w-14 h-14 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto mb-5">
              <Zap size={24} className="text-accent" />
            </div>
            <h2 className="text-xl font-bold text-dark-text mb-2">Coming Soon</h2>
            <p className="text-sm text-dark-muted leading-relaxed mb-6">
              Payments for the <span className="font-semibold text-dark-text">{selectedPlan}</span> plan are on their way. We&apos;ll notify you when billing goes live.
            </p>
            <button
              onClick={() => setShowComingSoon(false)}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <X size={15} />
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl text-sm font-medium animate-slide-in cursor-pointer bg-dark-surface border-dark-border text-dark-text"
            onClick={() => removeToast(toast.id)}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
