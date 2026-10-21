import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_IDS, TOOLS, type AppSettings, type PlanConfig, type PlanId } from '@pdftools/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BarChart } from '@/components/BarChart';
import { Select, TextInput } from '@/features/tools/fields';
import { api } from '@/lib/api';
import { formatBytes, cn } from '@/lib/utils';
import { useSeo } from '@/hooks/useSeo';
import { useAuth } from '@/stores/auth';
import { Link } from 'react-router-dom';

const TABS = ['Overview', 'Users', 'Teams', 'Jobs', 'Usage', 'Settings', 'Audit log'] as const;
type Tab = (typeof TABS)[number];

export default function Admin() {
  useSeo({ title: 'Admin', description: 'Administration', path: '/admin', noindex: true });
  const [tab, setTab] = useState<Tab>('Overview');
  const user = useAuth((s) => s.user);
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 5 * 60_000 });
  // Say it plainly instead of showing a wall of 403s: the server enforces this too, this is only the explanation.
  if (user && cfg.data?.features.adminTwoFactor && !user.twoFactorEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Administration</h1>
        <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold">Turn on two-step sign-in to use the admin area.</p>
          <p className="mt-1">Administrator accounts must have an authenticator app or a security key. Set one up on <Link to="/account" className="underline">your account page</Link>, then come back here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Administration</h1>
      <div role="tablist" aria-label="Admin sections" className="mt-6 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} aria-controls={`panel-${t}`} id={`tab-${t}`} onClick={() => setTab(t)}
            className={cn('-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium', tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-6">
        {tab === 'Overview' && <Overview />}
        {tab === 'Users' && <Users />}
        {tab === 'Teams' && <Teams />}
        {tab === 'Jobs' && <Jobs />}
        {tab === 'Usage' && <UsageTab />}
        {tab === 'Settings' && <SettingsTab />}
        {tab === 'Audit log' && <AuditTab />}
      </div>
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <Card className="p-4"><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p>{sub && <p className="text-xs text-slate-500">{sub}</p>}</Card>
);
const ErrorBox = ({ e }: { e: unknown }) => (e ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{(e as Error).message}</p> : null);

function Overview() {
  const q = useQuery({ queryKey: ['admin-dash'], queryFn: api.admin.dashboard, refetchInterval: 5000 });
  if (q.error) return <ErrorBox e={q.error} />;
  const d = q.data; if (!d) return <p className="text-slate-500">Loading…</p>;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Registered users" value={d.users.total} sub={`${d.users.active7d} active in 7 days`} />
        <Stat label="Teams" value={d.teams.total} sub={`${d.teams.paid} on a paid plan`} />
        <Stat label="Total jobs" value={d.jobs.total} sub={`${d.jobs.completed} completed · ${d.jobs.failed} failed`} />
        <Stat label="Queue" value={`${d.queue.waiting} waiting`} sub={`${d.queue.active} running`} />
        <Stat label="Storage in use" value={formatBytes(d.storage.bytes)} />
      </div>
      {d.users.twoFactorRequired && d.users.adminsWithoutTwoFactor > 0 && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{d.users.adminsWithoutTwoFactor} administrator{d.users.adminsWithoutTwoFactor === 1 ? ' has' : 's have'} not turned on two-step sign-in yet and cannot use the admin area until they do.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><h2 className="font-semibold">Users by plan</h2>
          <ul className="mt-2 text-sm">{PLAN_IDS.filter((p) => p !== 'guest').map((p) => <li key={p} className="flex justify-between border-b border-slate-100 py-1 capitalize"><span>{p}</span><span>{d.users.byPlan[p] ?? 0}</span></li>)}</ul></Card>
        <Card className="p-5"><h2 className="font-semibold">System</h2>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-slate-500">Load (1/5/15 min)</dt><dd>{d.system.loadavg.map((x) => x.toFixed(2)).join(' / ')}</dd></div>
            <div><dt className="text-slate-500">CPU cores</dt><dd>{d.system.cpus}</dd></div>
            <div><dt className="text-slate-500">API memory (RSS)</dt><dd>{formatBytes(d.system.rssBytes)}</dd></div>
            <div><dt className="text-slate-500">Free memory</dt><dd>{formatBytes(d.system.freeMemBytes)} / {formatBytes(d.system.totalMemBytes)}</dd></div>
          </dl></Card>
      </div>
      <Card className="p-5"><h2 className="font-semibold">Running now (CPU-intensive work)</h2>
        {d.running.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nothing is processing.</p> : (
          <table className="mt-2 w-full text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr><th>Job</th><th>Tool</th><th>Plan</th><th>Running for</th></tr></thead>
            <tbody>{d.running.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="py-1 font-mono text-xs">{r.id.slice(0, 8)}</td><td>{r.tool}</td><td className="capitalize">{r.plan}</td><td className={r.runningMs > 60_000 ? 'text-amber-700' : ''}>{(r.runningMs / 1000).toFixed(1)} s</td></tr>)}</tbody></table>
        )}
      </Card>
    </div>
  );
}

function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="mt-3 flex items-center gap-2 text-sm">
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages} · {total} total</span>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const q = useQuery({ queryKey: ['admin-users', page, applied], queryFn: () => api.admin.users({ page, q: applied || undefined }) });
  const me = useAuth((s) => s.user);
  const reset2fa = useMutation({ mutationFn: (id: string) => api.admin.resetTwoFactor(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }) });
  const upd = useMutation({ mutationFn: (v: { id: string; patch: Parameters<typeof api.admin.updateUser>[1] }) => api.admin.updateUser(v.id, v.patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }) });
  return (
    <div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(search.trim()); }}>
        <TextInput className="max-w-xs" aria-label="Search users by email" placeholder="Search email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <ErrorBox e={q.error ?? upd.error ?? reset2fa.error} />
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Email</th><th>Role</th><th>Plan</th><th>Status</th><th>Last login</th><th>Joined</th><th>2-step</th></tr></thead>
        <tbody>{q.data?.rows.map((u) => (
          <tr key={u.id} className="border-t border-slate-100">
            <td className="py-2 pr-3">{u.email}{u.subscription && <span className="ml-2 rounded bg-slate-100 px-1.5 text-[10px]">{u.subscription.status}</span>}</td>
            <td><Select aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => upd.mutate({ id: u.id, patch: { role: e.target.value as 'user' | 'admin' } })}><option value="user">user</option><option value="admin">admin</option></Select></td>
            <td><Select aria-label={`Plan for ${u.email}`} value={u.plan} onChange={(e) => upd.mutate({ id: u.id, patch: { plan: e.target.value as 'free' | 'pro' | 'business' } })}><option>free</option><option>pro</option><option>business</option></Select></td>
            <td><Select aria-label={`Status for ${u.email}`} value={u.status} onChange={(e) => upd.mutate({ id: u.id, patch: { status: e.target.value as 'active' | 'disabled' } })}><option>active</option><option>disabled</option></Select></td>
            <td className="px-2">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : '—'}</td>
            <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            <td className="pl-2">{u.twoFactorEnabled
              ? <Button size="sm" variant="secondary" aria-label={`Reset two-step verification for ${u.email}`} disabled={reset2fa.isPending || u.id === me?.id} title={u.id === me?.id ? 'Ask another administrator to reset yours' : undefined} onClick={() => { if (window.confirm(`Turn off two-step verification for ${u.email} and sign them out everywhere? Do this only after confirming their identity.`)) reset2fa.mutate(u.id); }}>Reset</Button>
              : <span className="text-xs text-slate-500">off</span>}</td>
          </tr>))}</tbody>
      </table></div>
      {q.data && <Pager page={page} total={q.data.total} size={q.data.pageSize} onPage={setPage} />}
    </div>
  );
}

function Teams() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin-teams', page, applied], queryFn: () => api.admin.teams({ page, q: applied || undefined }) });
  return (
    <div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(search.trim()); }}>
        <TextInput className="max-w-xs" aria-label="Search teams by name or owner email" placeholder="Team name or owner email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <ErrorBox e={q.error} />
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Team</th><th>Owner</th><th>Plan</th><th>People</th><th>Used today</th><th>Subscription</th><th>Created</th></tr></thead>
        <tbody>{q.data?.rows.map((t) => (
          <tr key={t.id} className="border-t border-slate-100">
            <td className="py-2 pr-3"><button type="button" className="font-medium text-brand-700 underline" aria-label={`Open team ${t.name}`} onClick={() => setOpen(t.id)}>{t.name}</button></td>
            <td className="pr-3">{t.owner.email}</td>
            <td className="capitalize">{t.plan}</td>
            <td>{t.members} / {t.seats}{t.seatsUsed > t.members && <span className="ml-1 text-xs text-slate-500">(+{t.seatsUsed - t.members} invited)</span>}</td>
            <td>{t.pool ? `${t.pool.opsToday} / ${t.pool.limit}` : '—'}</td>
            <td>{t.subscription ? `${t.subscription.status}${t.subscription.cancelAtPeriodEnd ? ' (ends)' : ''}` : '—'}</td>
            <td>{new Date(t.createdAt).toLocaleDateString()}</td>
          </tr>))}</tbody>
      </table></div>
      {q.data && q.data.rows.length === 0 && <p className="mt-3 text-sm text-slate-500">No teams{applied ? ' match that search' : ' yet'}.</p>}
      {q.data && <Pager page={page} total={q.data.total} size={q.data.pageSize} onPage={setPage} />}
      {open && <TeamDetailPanel key={open} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TeamDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['admin-team', id], queryFn: () => api.admin.team(id) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-teams'] }); void qc.invalidateQueries({ queryKey: ['admin-team', id] }); };
  const transfer = useMutation({ mutationFn: (userId: string) => api.admin.transferTeam(id, userId), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api.admin.deleteTeam(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-teams'] }); void qc.invalidateQueries({ queryKey: ['admin-dash'] }); onClose(); } });
  const t = d.data;
  return (
    <Card className="mt-6 p-5" role="region" aria-label="Team details">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t?.name ?? 'Team'}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <ErrorBox e={d.error ?? transfer.error ?? del.error} />
      {t && (
        <>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-slate-500">Plan</dt><dd className="capitalize">{t.plan}</dd></div>
            <div><dt className="text-slate-500">Seats</dt><dd>{t.seatsUsed} of {t.seats} ({t.pendingInvites} invited)</dd></div>
            <div><dt className="text-slate-500">Shared allowance today</dt><dd>{t.pool ? `${t.pool.opsToday} / ${t.pool.limit}` : 'none (free plan)'}</dd></div>
            <div><dt className="text-slate-500">Subscription</dt><dd>{t.subscription ? `${t.subscription.status}${t.currentPeriodEnd ? `, to ${new Date(t.currentPeriodEnd).toLocaleDateString()}` : ''}` : 'none'}</dd></div>
          </dl>
          <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Team members">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Member</th><th>Role</th><th>Email confirmed</th><th>Used today</th><th>Joined</th><th /></tr></thead>
            <tbody>{t.memberList.map((m) => (
              <tr key={m.userId} className="border-t border-slate-100">
                <td className="py-2 pr-3">{m.email}{m.name && <span className="ml-2 text-xs text-slate-500">{m.name}</span>}</td>
                <td className="capitalize">{m.role}</td>
                <td>{m.emailVerified ? 'yes' : 'no'}</td>
                <td>{m.opsToday ?? '—'}</td>
                <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
                <td className="text-right">{m.role !== 'owner' && (
                  <Button size="sm" variant="secondary" aria-label={`Make ${m.email} the owner`} disabled={transfer.isPending || !m.emailVerified} title={m.emailVerified ? undefined : 'They have not confirmed their email address, so they cannot take over billing'}
                    onClick={() => { if (window.confirm(`Make ${m.email} the owner of “${t.name}”? The current owner (${t.owner.email}) stays on as an admin. Use this only when the owner cannot be reached; it is recorded in the audit log.`)) transfer.mutate(m.userId); }}>Make owner</Button>)}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <Button variant="danger" className="border border-red-200" disabled={del.isPending}
              onClick={() => { if (window.confirm(`Delete the team “${t.name}”? ${t.subscription ? 'Its subscription is cancelled first. ' : ''}Its ${t.members} member${t.members === 1 ? '' : 's'} keep their accounts but lose the team's plan. This cannot be undone.`)) del.mutate(); }}>Delete team</Button>
            <p className="text-xs text-slate-500">Owner: {t.owner.email}. Both actions are written to the audit log with your name.</p>
          </div>
        </>
      )}
    </Card>
  );
}

function Jobs() {
  const [page, setPage] = useState(1); const [state, setState] = useState(''); const [tool, setTool] = useState('');
  const q = useQuery({ queryKey: ['admin-jobs', page, state, tool], queryFn: () => api.admin.jobs({ page, state: state || undefined, tool: tool || undefined }), refetchInterval: 5000 });
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Select className="w-44" aria-label="Filter by state" value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}><option value="">All states</option>{['queued', 'processing', 'completed', 'failed', 'cancelled', 'expired'].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select className="w-52" aria-label="Filter by tool" value={tool} onChange={(e) => { setTool(e.target.value); setPage(1); }}><option value="">All tools</option>{TOOLS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      </div>
      <ErrorBox e={q.error} />
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Job</th><th>Owner</th><th>Tool</th><th>State</th><th>Plan</th><th>Created</th><th>Result</th></tr></thead>
        <tbody>{q.data?.rows.map((j) => <tr key={j.id} className="border-t border-slate-100"><td className="py-2 font-mono text-xs">{j.id.slice(0, 8)}</td><td className="font-mono text-xs">{j.owner.slice(0, 10)}…</td><td>{j.tool}</td><td className={j.state === 'failed' ? 'text-red-700' : ''}>{j.state}{j.error ? ` (${j.error})` : ''}</td><td className="capitalize">{j.plan}</td><td>{new Date(j.createdAt).toLocaleString()}</td><td>{j.bytes ? formatBytes(j.bytes) : '—'}</td></tr>)}</tbody>
      </table></div>
      {q.data && <Pager page={page} total={q.data.total} size={q.data.pageSize} onPage={setPage} />}
    </div>
  );
}

function UsageTab() {
  const [days, setDays] = useState(14);
  const q = useQuery({ queryKey: ['admin-usage', days], queryFn: () => api.admin.usage(days) });
  return (
    <div className="space-y-4">
      <Select className="w-40" aria-label="Range" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option></Select>
      <ErrorBox e={q.error} />
      {q.data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-5 lg:col-span-2"><h2 className="font-semibold">Completed operations per day</h2><div className="mt-3"><BarChart height={140} label={`Operations per day, last ${days} days`} data={q.data.days.map((d) => ({ label: d.day, value: d.ops }))} /></div></Card>
          <Card className="p-5"><h2 className="font-semibold">Top tools</h2>
            <ol className="mt-2 space-y-1 text-sm">{q.data.topTools.map((t) => <li key={t.tool} className="flex justify-between"><span>{t.tool}</span><span>{t.ops}</span></li>)}{q.data.topTools.length === 0 && <li className="text-slate-500">No data yet.</li>}</ol></Card>
        </div>
      )}
    </div>
  );
}

const NUM_FIELDS: { key: keyof PlanConfig; label: string }[] = [
  { key: 'maxFileMB', label: 'Max file (MB)' }, { key: 'maxPages', label: 'Max pages' }, { key: 'maxFiles', label: 'Files per job' },
  { key: 'dailyOps', label: 'Operations / day' }, { key: 'maxConcurrentJobs', label: 'Concurrent jobs' }, { key: 'retentionMinutes', label: 'Retention (min)' },
  { key: 'priority', label: 'Queue priority' }, { key: 'priceCents', label: 'Price (cents/mo)' },
];

function SettingsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const s = draft ?? q.data;
  const save = useMutation({ mutationFn: (v: AppSettings) => api.admin.saveSettings(v), onSuccess: (v) => { qc.setQueryData(['admin-settings'], v); setDraft(null); } });
  if (q.error) return <ErrorBox e={q.error} />;
  if (!s) return <p className="text-slate-500">Loading…</p>;
  const edit = (fn: (x: AppSettings) => AppSettings) => setDraft(fn(structuredClone(s)));
  const setPlan = (id: PlanId, patch: Partial<PlanConfig>) => edit((x) => { x.plans[id] = { ...x.plans[id], ...patch }; return x; });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((t) => t !== id) : [...list, id]);

  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save.mutate(s); }}>
      <Card className="p-5">
        <h2 className="font-semibold">Service</h2>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.maintenance} onChange={(e) => edit((x) => { x.maintenance = e.target.checked; return x; })} />Maintenance mode (blocks all processing; admin stays available)</label>
        <fieldset className="mt-4"><legend className="text-sm font-medium">Disabled tools (off for everyone)</legend>
          <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">{TOOLS.map((t) => <label key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.disabledTools.includes(t.id)} onChange={() => edit((x) => { x.disabledTools = toggle(x.disabledTools, t.id); return x; })} />{t.name}</label>)}</div></fieldset>
      </Card>
      {PLAN_IDS.map((id) => {
        const p = s.plans[id];
        return (
          <Card key={id} className="p-5">
            <h2 className="font-semibold capitalize">{id} plan</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {NUM_FIELDS.map((f) => (
                <label key={f.key} className="block text-sm"><span className="mb-1 block text-slate-700">{f.label}</span>
                  <TextInput type="number" min={0} value={p[f.key] as number} onChange={(e) => setPlan(id, { [f.key]: Number(e.target.value) } as Partial<PlanConfig>)} /></label>
              ))}
              <label className="block text-sm"><span className="mb-1 block text-slate-700">Stripe price ID</span><TextInput value={p.stripePriceId ?? ''} disabled={id === 'guest' || id === 'free'} onChange={(e) => setPlan(id, { stripePriceId: e.target.value || undefined })} /></label>
            </div>
            <fieldset className="mt-4"><legend className="text-sm font-medium">Blocked (premium) tools for this plan</legend>
              <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">{TOOLS.map((t) => <label key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.blockedTools.includes(t.id)} onChange={() => setPlan(id, { blockedTools: toggle(p.blockedTools, t.id) })} />{t.name}</label>)}</div></fieldset>
          </Card>
        );
      })}
      <ErrorBox e={save.error} />
      <div className="flex items-center gap-3"><Button type="submit" disabled={!draft || save.isPending}>{save.isPending ? 'Saving…' : 'Save settings'}</Button>{draft && <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Discard changes</Button>}{save.isSuccess && !draft && <span role="status" className="text-sm text-emerald-700">Saved.</span>}</div>
    </form>
  );
}

function AuditTab() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin-audit', page], queryFn: () => api.admin.audit(page) });
  return (
    <div>
      <ErrorBox e={q.error} />
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
        <tbody>{q.data?.rows.map((r) => <tr key={r._id} className="border-t border-slate-100"><td className="py-2 pr-3">{new Date(r.at).toLocaleString()}</td><td className="font-mono text-xs">{r.actor}</td><td>{r.action}</td><td className="font-mono text-xs">{r.target ?? '—'}</td><td>{r.ip ?? '—'}</td></tr>)}</tbody>
      </table></div>
      {q.data && <Pager page={page} total={q.data.total} size={q.data.pageSize} onPage={setPage} />}
    </div>
  );
}
