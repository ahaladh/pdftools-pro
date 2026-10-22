import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, LogOut, Trash2, UserPlus, Users } from 'lucide-react';
import type { TeamMemberView, TeamView } from '@pdftools/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Select, TextInput } from '@/features/tools/fields';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/** The signed-in user now carries (or no longer carries) a team and its plan: refresh it after any change. */
function useTeamActions() {
  const qc = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  const [err, setErr] = useState<string | null>(null);
  const settle = async () => { setErr(null); await qc.invalidateQueries({ queryKey: ['team'] }); try { setUser(await api.me.get()); } catch { /* the next request will refresh it */ } };
  const opts = { onSuccess: settle, onError: (e: unknown) => setErr(errText(e)) };
  return { err, setErr, opts, settle };
}

function CreateTeam() {
  const [name, setName] = useState('');
  const { err, opts } = useTeamActions();
  const create = useMutation({ mutationFn: () => api.teams.create(name), ...opts });
  return (
    <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <p className="text-sm text-slate-600">Create a team to share one plan and one bill with colleagues. If someone invited you, open the link in their email instead.</p>
      <Field label="What should the team be called?"><TextInput value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Acme Design" /></Field>
      <Button type="submit" disabled={name.trim().length < 2 || create.isPending}><Users className="h-4 w-4" />Create team</Button>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
    </form>
  );
}

/** Owners and admins can limit how much of the shared allowance any one person may use per day; everyone else just sees the limit. */
function MemberCap({ team, actions, canManage }: { team: TeamView; actions: ReturnType<typeof useTeamActions>; canManage: boolean }) {
  const cap = team.pool?.memberCap;
  const [value, setValue] = useState(cap ? String(cap) : '');
  const save = useMutation({ mutationFn: (v: number | null) => api.teams.setMemberCap(v), ...actions.opts, onSuccess: async () => { await actions.opts.onSuccess(); } });
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 1;
  if (!canManage) return cap ? <p className="mt-1.5 text-xs text-slate-600">Your team limits each person to {cap} operations a day.</p> : null;
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(n); }}>
      <Field label="Daily limit per person" hint={cap ? `Currently ${cap}.` : 'Optional. Without one, a single person can use the whole shared allowance.'}>
        <TextInput className="!w-28" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="No limit" />
      </Field>
      <Button type="submit" size="sm" disabled={!valid || save.isPending || n === cap}>Save limit</Button>
      {cap && <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setValue(''); save.mutate(null); }}>Remove limit</Button>}
    </form>
  );
}

function Members({ team, actions }: { team: TeamView; actions: ReturnType<typeof useTeamActions> }) {
  const { opts } = actions;
  const isOwner = team.myRole === 'owner';
  const canManage = isOwner || team.myRole === 'admin';
  const role = useMutation({ mutationFn: (v: { id: string; role: 'admin' | 'member' }) => api.teams.setRole(v.id, v.role), ...opts });
  const remove = useMutation({ mutationFn: (id: string) => api.teams.removeMember(id), ...opts });
  const share = new Map((team.pool?.byMember ?? []).map((x) => [x.userId, x.ops]));
  const canRemove = (m: TeamMemberView) => !m.you && m.role !== 'owner' && (isOwner || (canManage && m.role === 'member'));
  return (
    <ul className="mt-3 divide-y divide-slate-100" aria-label="Team members">
      {team.members.map((m) => (
        <li key={m.userId} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{m.name || m.email}{m.you && <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">You</span>}</p>
            {m.name && <p className="truncate text-xs text-slate-600">{m.email}</p>}
          </div>
          {share.has(m.userId) && <span className="text-xs text-slate-600" aria-label={`Operations used today by ${m.email}`}>{share.get(m.userId)} today</span>}
          {isOwner && !m.you && m.role !== 'owner'
            ? <Select aria-label={`Role of ${m.email}`} className="!w-auto !py-1.5" value={m.role} onChange={(e) => role.mutate({ id: m.userId, role: e.target.value as 'admin' | 'member' })}><option value="member">Member</option><option value="admin">Admin</option></Select>
            : <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">{m.role === 'owner' && <Crown className="h-3 w-3" aria-hidden="true" />}{ROLE_LABEL[m.role]}</span>}
          {canRemove(m) && <Button size="sm" variant="secondary" aria-label={`Remove ${m.email} from the team`} disabled={remove.isPending} onClick={() => { if (window.confirm(`Remove ${m.email} from the team? They lose the team's plan immediately.`)) remove.mutate(m.userId); }}>Remove</Button>}
        </li>
      ))}
    </ul>
  );
}

export function TeamCard() {
  const user = useAuth((s) => s.user);
  const q = useQuery({ queryKey: ['team'], queryFn: api.teams.mine });
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const actions = useTeamActions();
  const { err, setErr, opts } = actions;
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [name, setName] = useState<string | null>(null);
  const [heir, setHeir] = useState('');
  const team = q.data;

  const invite = useMutation({ mutationFn: () => api.teams.invite(email, inviteRole), ...opts, onSuccess: async () => { setEmail(''); await opts.onSuccess(); } });
  const cancel = useMutation({ mutationFn: (id: string) => api.teams.cancelInvite(id), ...opts });
  const rename = useMutation({ mutationFn: () => api.teams.rename(name ?? ''), ...opts, onSuccess: async () => { setName(null); await opts.onSuccess(); } });
  const leave = useMutation({ mutationFn: api.teams.leave, ...opts });
  const del = useMutation({ mutationFn: api.teams.remove, ...opts });
  const transfer = useMutation({ mutationFn: () => api.teams.transfer(heir), ...opts, onSuccess: async () => { setHeir(''); await opts.onSuccess(); } });
  const checkout = useMutation({ mutationFn: (p: 'pro' | 'business') => api.teams.checkout(p), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => setErr(errText(e)) });
  const portal = useMutation({ mutationFn: api.teams.portal, onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => setErr(errText(e)) });
  if (!user) return null;

  return (
    <Card className="p-6 md:col-span-2" aria-label="Team">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Users className="h-5 w-5 text-slate-500" aria-hidden="true" />Team</h2>
      {q.isLoading && <p className="mt-3 text-sm text-slate-500" role="status">Loading…</p>}
      {!q.isLoading && !team && <CreateTeam />}

      {team && (() => {
        const canManage = team.myRole === 'owner' || team.myRole === 'admin';
        const isOwner = team.myRole === 'owner';
        const full = team.seatsUsed >= team.seats;
        const heirs = team.members.filter((m) => !m.you);
        return (
          <div className="mt-3 space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              {name === null ? <>
                <h3 className="text-base font-semibold">{team.name}</h3>
                {canManage && <Button size="sm" variant="ghost" onClick={() => setName(team.name)}>Rename</Button>}
              </> : (
                <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
                  <Field label="New title for the team"><TextInput value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
                  <Button type="submit" size="sm" disabled={name.trim().length < 2 || rename.isPending}>Save</Button><Button type="button" size="sm" variant="ghost" onClick={() => setName(null)}>Cancel</Button>
                </form>
              )}
              <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold capitalize text-brand-800">{team.plan} plan</span>
              <span className="text-sm text-slate-600" aria-label="Seats">{team.seatsUsed} of {team.seats} seat{team.seats === 1 ? '' : 's'} used</span>
              <span className="ml-auto text-sm text-slate-600">You are {team.myRole === 'admin' ? 'an admin' : `the ${team.myRole}`}</span>
            </div>
            {team.pool && (
              <div className="rounded-xl bg-slate-50 p-3" aria-label="Shared allowance">
                <div className="flex justify-between text-sm"><span className="font-medium">Shared allowance today</span><span>{team.pool.opsToday} / {team.pool.limit}</span></div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Team operations used today" aria-valuenow={team.pool.opsToday} aria-valuemin={0} aria-valuemax={team.pool.limit}><div className={`h-full rounded-full ${team.pool.opsToday >= team.pool.limit * 0.9 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${Math.min(100, Math.round((team.pool.opsToday / Math.max(1, team.pool.limit)) * 100))}%` }} /></div>
                <p className="mt-1.5 text-xs text-slate-600">{team.pool.perMember} for each of {team.members.length} member{team.members.length === 1 ? '' : 's'}, shared: people who use less leave room for people who use more. Anyone whose own plan is better uses their own allowance instead. Resets daily.</p>
                <MemberCap team={team} actions={actions} canManage={canManage} />
              </div>
            )}
            {team.plan === 'free' && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">This team is on the free plan, so there is room for just you. {isOwner ? 'Subscribe the team to share a paid plan with colleagues.' : 'Ask the owner to subscribe the team.'}</p>}

            <Members team={team} actions={actions} />

            {canManage && (
              <div>
                <h3 className="text-sm font-semibold">Invitations</h3>
                {team.invites.length > 0 && (
                  <ul className="mt-2 divide-y divide-slate-100" aria-label="Pending invitations">
                    {team.invites.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{i.email} <span className="text-xs text-slate-600">· {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}</span></span>
                        <Button size="sm" variant="secondary" aria-label={`Cancel invitation for ${i.email}`} disabled={cancel.isPending} onClick={() => cancel.mutate(i.id)}>Cancel</Button>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setErr(null); invite.mutate(); }}>
                  <div className="min-w-[14rem] flex-1"><Field label="Invite by email"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@example.com" disabled={full} /></Field></div>
                  {isOwner && <Field label="Role"><Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}><option value="member">Member</option><option value="admin">Admin</option></Select></Field>}
                  <Button type="submit" disabled={!email.includes('@') || invite.isPending || full}><UserPlus className="h-4 w-4" />Send invitation</Button>
                </form>
                {full && <p className="mt-2 text-xs text-slate-600">All seats are taken. Remove someone, cancel an invitation{isOwner ? ' or upgrade the plan' : ''} to invite more people.</p>}
                <p className="mt-2 text-xs text-slate-600">They must sign in with the address you enter and confirm it before the link works.</p>
              </div>
            )}

            {isOwner && (
              <div className="rounded-xl border border-slate-200 p-4">
                <h3 className="text-sm font-semibold">Team billing</h3>
                {team.subscription ? (
                  <p className="mt-1 text-sm text-slate-700">Subscription {team.subscription.status}{team.subscription.cancelAtPeriodEnd ? ' (ends at period end)' : ''}{team.subscription.currentPeriodEnd ? `, renews ${new Date(team.subscription.currentPeriodEnd).toLocaleDateString()}` : ''}.</p>
                ) : <p className="mt-1 text-sm text-slate-700">No subscription yet.</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {cfg.data?.features.billing && team.plan === 'free' && <>
                    <Button size="sm" disabled={checkout.isPending} onClick={() => checkout.mutate('pro')}>Subscribe team to Pro</Button>
                    <Button size="sm" variant="secondary" disabled={checkout.isPending} onClick={() => checkout.mutate('business')}>Subscribe team to Business</Button>
                  </>}
                  {cfg.data?.features.billing && team.subscription && <Button size="sm" variant="secondary" disabled={portal.isPending} onClick={() => portal.mutate()}>Manage team billing</Button>}
                  {!cfg.data?.features.billing && <p className="text-xs text-slate-600">Paid checkout is not enabled on this server.</p>}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
              {isOwner && heirs.length > 0 && (
                <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); const h = heirs.find((m) => m.userId === heir); if (h && window.confirm(`Make ${h.email} the owner? They will control the team's billing, and you become an admin.`)) transfer.mutate(); }}>
                  <Field label="Transfer ownership to"><Select value={heir} onChange={(e) => setHeir(e.target.value)}><option value="">Choose a member…</option>{heirs.map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}</Select></Field>
                  <Button type="submit" size="sm" variant="secondary" disabled={!heir || transfer.isPending}>Transfer</Button>
                </form>
              )}
              <div className="ml-auto flex gap-2">
                {!isOwner && <Button size="sm" variant="secondary" disabled={leave.isPending} onClick={() => { if (window.confirm('Leave this team? You lose the team\'s plan immediately.')) leave.mutate(); }}><LogOut className="h-4 w-4" />Leave team</Button>}
                {isOwner && <Button size="sm" variant="danger" className="border border-red-200" disabled={del.isPending} onClick={() => { if (window.confirm(`Delete the team "${team.name}"? Its subscription is cancelled and every member loses the team's plan.`)) del.mutate(); }}><Trash2 className="h-4 w-4" />Delete team</Button>}
              </div>
            </div>
          </div>
        );
      })()}
      {err && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
    </Card>
  );
}
