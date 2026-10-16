import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { changePasswordSchema } from '@pdftools/shared';
import { Download } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BarChart } from '@/components/BarChart';
import { Field, TextInput } from '@/features/tools/fields';
import { api } from '@/lib/api';
import { setSessionHint, setToken } from '@/lib/session';
import { useSeo } from '@/hooks/useSeo';
import { useAuth } from '@/stores/auth';
import { getTool } from '@pdftools/shared';
import { DevicesCard, EmailStatus, TwoFactorCard } from '@/pages/account/Security';
import { TeamCard } from '@/pages/account/Team';

const when = (iso: string) => new Date(iso).toLocaleString();

export default function Account() {
  useSeo({ title: 'Your account', description: 'Manage your account, usage and subscription.', path: '/account', noindex: true });
  const { user, setUser, accept } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const usage = useQuery({ queryKey: ['me-usage'], queryFn: api.me.usage });
  const jobs = useQuery({ queryKey: ['me-jobs'], queryFn: api.me.jobs });
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const [name, setName] = useState(user?.name ?? '');
  const [msg, setMsg] = useState<string | null>(null);

  const saveName = useMutation({ mutationFn: () => api.me.update(name), onSuccess: (u) => { setUser(u); setMsg('Profile saved.'); } });
  const portal = useMutation({ mutationFn: api.billing.portal, onSuccess: (r) => { window.location.href = r.url; } });

  const pw = useForm<z.input<typeof changePasswordSchema>>({ resolver: zodResolver(changePasswordSchema) });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState<string | null>(null);
  /** Leave the protected route first and let the router commit it; clearing the session while it is still mounted would bounce to /signin. */
  const leave = async (then: () => void | Promise<void>) => { nav('/'); await new Promise((r) => setTimeout(r, 50)); await then(); qc.clear(); };

  if (!user) return null;
  const u = usage.data;
  const pct = u ? Math.min(100, Math.round((u.today.ops / Math.max(1, u.today.limit)) * 100)) : 0;
  const sub = user.subscription;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <div><h1 className="text-3xl font-bold tracking-tight">Your account</h1><p className="text-slate-600">{user.email}</p></div>
        <div className="ml-auto flex gap-2">
          {user.role === 'admin' && <Link to="/admin" className={buttonClass({ variant: 'secondary' })}>Admin</Link>}
          <Button variant="secondary" onClick={async () => { const revoked = api.auth.logout().catch(() => undefined); await leave(async () => { await revoked; useAuth.getState().clear({ onPurpose: true }); }); }}>Sign out</Button>
        </div>
      </header>
      <EmailStatus />
      {params.get('checkout') === 'success' && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Thanks! Your subscription is being activated; this can take a few seconds. Refresh to see your new plan.</p>}

      <section aria-labelledby="plan" className="grid gap-6 md:grid-cols-2">
        <Card className="p-6">
          <h2 id="plan" className="text-lg font-semibold">Plan & usage</h2>
          <p className="mt-1 text-sm text-slate-600">Current plan: <b className="capitalize">{user.effectivePlan}</b>{user.team && user.effectivePlan !== user.plan && <> (shared by the team “{user.team.name}”)</>}{sub && <> · subscription {sub.status}{sub.cancelAtPeriodEnd ? ' (ends at period end)' : ''}{sub.currentPeriodEnd ? `, renews ${new Date(sub.currentPeriodEnd).toLocaleDateString()}` : ''}</>}</p>
          {u && (
            <>
              <div className="mt-4"><div className="mb-1 flex justify-between text-sm"><span>Operations today</span><span>{u.today.ops} / {u.today.limit}</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={u.today.ops} aria-valuemin={0} aria-valuemax={u.today.limit} aria-label="Operations used today"><div className={`h-full rounded-full ${pct >= 90 ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} /></div></div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div><dt className="text-slate-500">Max file size</dt><dd>{u.limits.maxFileMB} MB</dd></div>
                <div><dt className="text-slate-500">Max pages</dt><dd>{u.limits.maxPages}</dd></div>
                <div><dt className="text-slate-500">Files per job</dt><dd>{u.limits.maxFiles}</dd></div>
                <div><dt className="text-slate-500">Results kept</dt><dd>{u.limits.retentionMinutes >= 60 ? `${Math.round(u.limits.retentionMinutes / 60)} h` : `${u.limits.retentionMinutes} min`}</dd></div>
              </dl>
              <div className="mt-4"><p className="mb-1 text-xs text-slate-500">Last 30 days</p><BarChart label="Operations per day, last 30 days" data={u.last30Days.map((d) => ({ label: d.day, value: d.ops }))} /></div>
            </>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            {cfg.data?.features.billing && sub && <Button variant="secondary" onClick={() => portal.mutate()} disabled={portal.isPending}>Manage billing</Button>}
            {user.effectivePlan !== 'business' && <Link to="/pricing" className={buttonClass()}>{user.effectivePlan === 'free' ? 'Upgrade' : 'See plans'}</Link>}
          </div>
          {portal.error && <p role="alert" className="mt-2 text-sm text-red-600">{(portal.error as Error).message}</p>}
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold">Profile</h2>
          <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); saveName.mutate(); }}>
            <Field label="Name"><TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
            <Button type="submit" disabled={saveName.isPending}>Save</Button>
            {msg && <p role="status" className="text-sm text-emerald-700">{msg}</p>}
          </form>
        </Card>
      </section>

      <Card className="p-6">
        <h2 className="text-lg font-semibold">Recent jobs</h2>
        {jobs.data?.length === 0 && <p className="mt-2 text-sm text-slate-600">No jobs yet. <Link to="/tools" className="underline">Pick a tool</Link>.</p>}
        {!!jobs.data?.length && (
          <div className="mt-3 overflow-x-auto"><table aria-label="Recent jobs" className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-4">Tool</th><th className="pr-4">Status</th><th className="pr-4">Created</th><th className="pr-4">Expires</th><th><span className="sr-only">Download</span></th></tr></thead>
            <tbody>{jobs.data.map((j) => (
              <tr key={j.id} className="border-t border-slate-100">
                <td className="py-2 pr-4">{getTool(j.tool)?.name ?? j.tool}</td>
                <td className="pr-4 capitalize">{j.state}{j.error ? ` · ${j.error.message}` : ''}</td>
                <td className="pr-4">{when(j.createdAt)}</td>
                <td className="pr-4">{j.state === 'completed' ? when(j.expiresAt) : '—'}</td>
                <td>{j.result && <Button size="sm" variant="secondary" aria-label={`Download ${j.result.name}`} onClick={() => api.download(j.result!.downloadUrl, j.result!.name)}><Download className="h-3 w-3" />Download</Button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>

      <section className="grid gap-6 md:grid-cols-2" aria-label="Team section">
        <TeamCard />
      </section>

      <section className="grid gap-6 md:grid-cols-2" aria-label="Sign-in security">
        <TwoFactorCard />
        <DevicesCard />
      </section>

      <section className="grid gap-6 md:grid-cols-2" aria-label="Security">
        <Card className="p-6">
          <h2 className="text-lg font-semibold">Change password</h2>
          <form className="mt-4 space-y-3" noValidate onSubmit={pw.handleSubmit(async (v) => {
            setPwMsg(null);
            try { accept(await api.me.changePassword(v.currentPassword, v.newPassword)); pw.reset(); setPwMsg('Password changed. Other devices were signed out.'); }
            catch (e) { setPwMsg((e as Error).message); }
          })}>
            <Field label="Current password"><TextInput type="password" autoComplete="current-password" {...pw.register('currentPassword')} /></Field>
            <Field label="New password" hint="At least 10 characters."><TextInput type="password" autoComplete="new-password" {...pw.register('newPassword')} /></Field>
            {pw.formState.errors.newPassword && <p role="alert" className="text-xs text-red-600">{pw.formState.errors.newPassword.message}</p>}
            <Button type="submit" disabled={pw.formState.isSubmitting}>Change password</Button>
            {pwMsg && <p role="status" className="text-sm text-slate-700">{pwMsg}</p>}
          </form>
        </Card>
        <Card className="border-red-200 p-6">
          <h2 className="text-lg font-semibold text-red-700">Delete account</h2>
          <p className="mt-1 text-sm text-slate-600">Permanently deletes your account, job history and any stored results, and cancels your subscription. This cannot be undone.</p>
          <form className="mt-4 space-y-3" onSubmit={async (e) => {
            e.preventDefault(); setDelErr(null);
            try { await api.me.remove(delPw); await leave(() => { setToken(null); setSessionHint(false); useAuth.getState().clear({ onPurpose: true }); }); } catch (err) { setDelErr((err as Error).message); }
          }}>
            <Field label="Confirm with your password"><TextInput type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} /></Field>
            <Button type="submit" variant="danger" className="border border-red-200" disabled={!delPw}>Delete my account</Button>
            {delErr && <p role="alert" className="text-sm text-red-600">{delErr}</p>}
          </form>
        </Card>
      </section>
    </div>
  );
}
