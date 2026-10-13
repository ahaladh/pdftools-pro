import { Check } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, type PublicPlan } from '@/lib/api';
import { useSeo } from '@/hooks/useSeo';
import { useAuth } from '@/stores/auth';
import { cn } from '@/lib/utils';

const price = (p: PublicPlan) => (p.priceCents === 0 ? 'Free' : new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase(), maximumFractionDigits: 0 }).format(p.priceCents / 100));
const hours = (m: number) => (m >= 60 ? `${Math.round(m / 60)} hours` : `${m} minutes`);

export default function Pricing() {
  useSeo({ title: 'Pricing', description: 'Free PDF tools with optional paid plans for higher limits and premium tools.', path: '/pricing' });
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { status, user } = useAuth();
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  const checkout = useMutation({ mutationFn: (plan: 'pro' | 'business') => api.billing.checkout(plan), onSuccess: (r) => { window.location.href = r.url; } });

  const list = plans.data?.filter((p) => p.id !== 'guest') ?? [];
  const accounts = cfg.data?.features.accounts;
  const billing = cfg.data?.features.billing;

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
      <p className="mt-2 text-slate-600">{billing ? 'Start free. Upgrade when you need bigger files, more operations or premium tools.' : 'All plans are shown for reference; paid checkout is not enabled on this server.'}</p>
      {params.get('checkout') === 'cancelled' && <p role="status" className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">Checkout was cancelled. You have not been charged.</p>}
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {list.map((p) => {
          const current = user?.plan === p.id;
          return (
            <Card key={p.id} className={cn('flex flex-col p-6', p.id === 'pro' && 'border-brand-500 ring-1 ring-brand-500')}>
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <p className="mt-2 text-3xl font-bold">{price(p)}{p.priceCents > 0 && <span className="text-sm font-normal text-slate-500"> / month</span>}</p>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {[`Files up to ${p.maxFileMB} MB`, `Up to ${p.maxPages.toLocaleString()} pages`, `${p.dailyOps.toLocaleString()} operations per day`, `${p.maxConcurrentJobs} jobs at once`, `Results kept ${hours(p.retentionMinutes)}`, ...p.features].map((x) => (
                  <li key={x} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />{x}</li>
                ))}
              </ul>
              <div className="mt-6">
                {current ? <p className="text-center text-sm font-medium text-emerald-700">Your current plan</p>
                  : p.id === 'free' ? (accounts && status !== 'authenticated' ? <Link to="/register" className={buttonClass({ variant: 'secondary', className: 'w-full' })}>Create free account</Link> : null)
                  : p.purchasable ? (
                    <Button className="w-full" disabled={checkout.isPending} onClick={() => (status === 'authenticated' ? checkout.mutate(p.id as 'pro' | 'business') : nav(`/signin?next=/pricing`))}>
                      {status === 'authenticated' ? `Upgrade to ${p.name}` : 'Sign in to upgrade'}
                    </Button>
                  ) : <p className="text-center text-sm text-slate-500">Not available for purchase yet</p>}
              </div>
            </Card>
          );
        })}
      </div>
      {checkout.error && <p role="alert" className="mt-4 text-sm text-red-600">{(checkout.error as Error).message}</p>}
      <p className="mt-6 text-xs text-slate-500">Payments are handled by Stripe; we never see your card details. Cancel any time from your account.</p>
    </div>
  );
}
