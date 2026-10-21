import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, Laptop, MailWarning, ShieldCheck, ShieldOff, Usb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, TextInput } from '@/features/tools/fields';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { createKey, keyErrorText, keysSupported } from '@/lib/webauthn';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Banner shown until the address is confirmed. */
export function EmailStatus() {
  const user = useAuth((s) => s.user);
  const [state, setState] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const resend = useMutation({
    mutationFn: api.auth.resendVerification,
    onSuccess: () => setState({ kind: 'ok', text: 'Confirmation email sent. It may take a minute to arrive.' }),
    onError: (e) => setState({ kind: 'err', text: errText(e) }),
  });
  if (!user || user.emailVerified) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" aria-label="Email confirmation">
      <MailWarning className="h-5 w-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1"><b>Confirm your email address.</b> We sent you a link when you signed up. Until it is confirmed, you cannot start a paid upgrade.</p>
      <Button size="sm" variant="secondary" disabled={resend.isPending} onClick={() => { setState(null); resend.mutate(); }}>Resend email</Button>
      {state && <p role={state.kind === 'err' ? 'alert' : 'status'} className={`w-full text-sm ${state.kind === 'err' ? 'text-red-700' : 'text-emerald-800'}`}>{state.text}</p>}
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `${codes.join('\n')}\n`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  const save = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Recovery codes\nEach works once. Keep them somewhere safe.\n\n${text}`], { type: 'text/plain' }));
    a.download = 'recovery-codes.txt'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  return (
    <div className="space-y-3" role="region" aria-label="Recovery codes">
      <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><b>Save these recovery codes now.</b> They are shown only once. Each one signs you in a single time if you lose your phone.</p>
      <ul className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 font-mono text-sm" aria-label="Your recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={copy}><Copy className="h-4 w-4" />{copied ? 'Copied' : 'Copy'}</Button>
        <Button size="sm" variant="secondary" onClick={save}><Download className="h-4 w-4" />Download</Button>
        <Button size="sm" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

type Step = { name: 'idle' } | { name: 'password' } | { name: 'scan'; secret: string; qr: string } | { name: 'codes'; codes: string[] }
  | { name: 'confirm'; action: 'disable' | 'codes' };

/** Turn two-factor sign-in on or off and manage recovery codes. Every change re-asks for the password. */
export function TwoFactorCard() {
  const { user, accept } = useAuth();
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const reset = () => { setStep({ name: 'idle' }); setPassword(''); setCode(''); setErr(null); };
  const fail = (e: unknown) => setErr(errText(e));

  const setup = useMutation({ mutationFn: () => api.me.twoFactorSetup(password), onSuccess: (r) => { setErr(null); setStep({ name: 'scan', secret: r.secret, qr: r.qr }); }, onError: fail });
  const enable = useMutation({ mutationFn: () => api.me.twoFactorEnable(code), onSuccess: (r) => { accept(r); setPassword(''); setCode(''); setErr(null); setStep({ name: 'codes', codes: r.recoveryCodes }); }, onError: fail });
  const disable = useMutation({ mutationFn: () => api.me.twoFactorDisable(password, code), onSuccess: (r) => { accept(r); reset(); }, onError: fail });
  const regen = useMutation({ mutationFn: () => api.me.recoveryCodes(password, code), onSuccess: (r) => { setPassword(''); setCode(''); setErr(null); setStep({ name: 'codes', codes: r.recoveryCodes }); }, onError: fail });
  if (!user) return null;
  const on = user.totpEnabled;

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">{on ? <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" /> : <ShieldOff className="h-5 w-5 text-slate-500" aria-hidden="true" />}Authenticator app</h2>
      <p className="mt-1 text-sm text-slate-600">{on ? 'On. Signing in accepts a code from your authenticator app as the second step.' : 'Off. Use an app on your phone to add a second step, so a stolen password alone cannot open your account.'}</p>

      {step.name === 'idle' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {!on && <Button onClick={() => setStep({ name: 'password' })}><KeyRound className="h-4 w-4" />Set up</Button>}
          {on && <>
            <Button variant="secondary" onClick={() => setStep({ name: 'confirm', action: 'codes' })}>New recovery codes</Button>
            <Button variant="danger" className="border border-red-200" onClick={() => setStep({ name: 'confirm', action: 'disable' })}>Turn off</Button>
          </>}
        </div>
      )}

      {step.name === 'password' && (
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); setup.mutate(); }}>
          <Field label="Your password, to set up the authenticator app"><TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <div className="flex gap-2"><Button type="submit" disabled={!password || setup.isPending}>Continue</Button><Button type="button" variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      )}

      {step.name === 'scan' && (
        <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); setErr(null); enable.mutate(); }}>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>Open an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator…).</li>
            <li>Scan this QR code, or enter the key by hand.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-4">
            <img src={step.qr} alt="QR code for your authenticator app" width={160} height={160} className="rounded-lg border border-slate-200 bg-white p-1" />
            <div className="text-sm"><p className="text-slate-600">Can't scan? Enter this key:</p><p className="mt-1 select-all break-all font-mono text-base tracking-wider" aria-label="Setup key">{step.secret.match(/.{1,4}/g)?.join(' ')}</p></div>
          </div>
          <Field label="6-digit code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" /></Field>
          <div className="flex gap-2"><Button type="submit" disabled={code.trim().length !== 6 || enable.isPending}>Turn on</Button><Button type="button" variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      )}

      {step.name === 'codes' && <div className="mt-4"><RecoveryCodes codes={step.codes} onDone={reset} /></div>}

      {step.name === 'confirm' && (
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); (step.action === 'disable' ? disable : regen).mutate(); }}>
          <p className="text-sm text-slate-700">{step.action === 'disable' ? 'Turning this off signs you out on other devices.' : 'Your old recovery codes stop working.'}</p>
          <Field label="Password"><TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Authenticator or recovery code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={16} spellCheck={false} /></Field>
          <div className="flex gap-2"><Button type="submit" variant={step.action === 'disable' ? 'danger' : 'primary'} className={step.action === 'disable' ? 'border border-red-200' : ''} disabled={!password || code.trim().length < 6 || disable.isPending || regen.isPending}>{step.action === 'disable' ? 'Turn off' : 'Create new codes'}</Button><Button type="button" variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      )}
      {err && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

type KeyStep = { name: 'idle' } | { name: 'add' } | { name: 'waiting' } | { name: 'codes'; codes: string[] } | { name: 'confirm'; action: 'remove' | 'codes'; id?: string; label?: string };

/** Hardware security keys and passkeys as a second step. Adding asks for the password; removing also asks for a code. */
export function SecurityKeysCard() {
  const { user, accept } = useAuth();
  const qc = useQueryClient();
  const supported = useQuery({ queryKey: ['webauthn-supported'], queryFn: keysSupported, staleTime: Infinity });
  const list = useQuery({ queryKey: ['security-keys'], queryFn: api.me.securityKeys });
  const [step, setStep] = useState<KeyStep>({ name: 'idle' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const reset = () => { setStep({ name: 'idle' }); setName(''); setPassword(''); setCode(''); setErr(null); };
  const refresh = (keys: unknown) => { qc.setQueryData(['security-keys'], { keys }); };

  const add = useMutation({
    mutationFn: async () => {
      const options = await api.me.securityKeyOptions(password);
      setStep({ name: 'waiting' });
      const response = await createKey(options);
      return api.me.securityKeyAdd(response, name.trim());
    },
    onSuccess: (r) => {
      refresh(r.keys);
      if (r.accessToken && r.user) accept({ user: r.user, accessToken: r.accessToken, expiresIn: r.expiresIn ?? 0 });
      setPassword(''); setName(''); setErr(null);
      setStep(r.recoveryCodes ? { name: 'codes', codes: r.recoveryCodes } : { name: 'idle' });
    },
    onError: (e) => { setErr(keyErrorText(e)); setStep({ name: 'add' }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.me.securityKeyRemove(id, password, code),
    onSuccess: (r) => { refresh(r.keys); accept(r); reset(); },
    onError: (e) => setErr(errText(e)),
  });
  const regen = useMutation({
    mutationFn: () => api.me.recoveryCodes(password, code),
    onSuccess: (r) => { setPassword(''); setCode(''); setErr(null); setStep({ name: 'codes', codes: r.recoveryCodes }); },
    onError: (e) => setErr(errText(e)),
  });
  if (!user) return null;
  const keys = list.data?.keys ?? [];

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Usb className="h-5 w-5 text-slate-500" aria-hidden="true" />Security keys</h2>
      <p className="mt-1 text-sm text-slate-600">Use a hardware key (YubiKey and similar) or a passkey as the second step. Your password is still needed first. Keep a spare key and your recovery codes.</p>
      {list.isLoading && <p className="mt-3 text-sm text-slate-500" role="status">Loading…</p>}
      {keys.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100" aria-label="Your security keys">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{k.name}{k.deviceType === 'multiDevice' && <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">Synced passkey</span>}</p>
                <p className="text-xs text-slate-600">Added {new Date(k.createdAt).toLocaleDateString()} · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used to sign in'}</p>
              </div>
              <Button size="sm" variant="secondary" aria-label={`Remove ${k.name}`} onClick={() => { setErr(null); setPassword(''); setCode(''); setStep({ name: 'confirm', action: 'remove', id: k.id, label: k.name }); }}>Remove</Button>
            </li>
          ))}
        </ul>
      )}

      {step.name === 'idle' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {supported.data === false
            ? <p className="text-sm text-slate-600" role="status">This browser cannot use security keys.</p>
            : <Button onClick={() => { setErr(null); setStep({ name: 'add' }); }}><KeyRound className="h-4 w-4" />Add a security key</Button>}
          {user.twoFactorEnabled && keys.length > 0 && <Button variant="secondary" onClick={() => { setErr(null); setPassword(''); setCode(''); setStep({ name: 'confirm', action: 'codes' }); }}>New recovery codes</Button>}
        </div>
      )}

      {(step.name === 'add' || step.name === 'waiting') && (
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); add.mutate(); }}>
          <Field label="Name for this key" hint="For example “YubiKey 5C” or “Laptop”. Only you see it."><TextInput value={name} maxLength={40} onChange={(e) => setName(e.target.value)} disabled={step.name === 'waiting'} /></Field>
          <Field label="Password to add this key"><TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={step.name === 'waiting'} /></Field>
          {step.name === 'waiting' && <p role="status" className="text-sm text-slate-700">Insert your key and touch it when your browser asks…</p>}
          <div className="flex gap-2"><Button type="submit" disabled={!password || !name.trim() || add.isPending}>Continue</Button><Button type="button" variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      )}

      {step.name === 'codes' && <div className="mt-4"><RecoveryCodes codes={step.codes} onDone={reset} /></div>}

      {step.name === 'confirm' && (
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); if (step.action === 'remove') remove.mutate(step.id!); else regen.mutate(); }}>
          <p className="text-sm text-slate-700">{step.action === 'remove' ? `Remove “${step.label}”? It will stop working for sign-in, and other devices are signed out.` : 'Your old recovery codes stop working.'}</p>
          <Field label={step.action === 'remove' ? 'Password to remove this key' : 'Password to make new codes'}><TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Recovery code or authenticator code" hint="A security key cannot confirm its own removal."><TextInput value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={16} spellCheck={false} /></Field>
          <div className="flex gap-2"><Button type="submit" variant={step.action === 'remove' ? 'danger' : 'primary'} className={step.action === 'remove' ? 'border border-red-200' : ''} disabled={!password || code.trim().length < 6 || remove.isPending || regen.isPending}>{step.action === 'remove' ? 'Remove key' : 'Make new codes'}</Button><Button type="button" variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      )}
      {err && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

/** Where this account is signed in, with remote sign-out. */
export function DevicesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: api.auth.sessions });
  const [err, setErr] = useState<string | null>(null);
  const done = () => { setErr(null); void qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const revoke = useMutation({ mutationFn: (id: string) => api.auth.revokeSession(id), onSuccess: done, onError: (e) => setErr(errText(e)) });
  const others = useMutation({ mutationFn: api.auth.revokeOtherSessions, onSuccess: done, onError: (e) => setErr(errText(e)) });
  const list = q.data ?? [];
  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Laptop className="h-5 w-5 text-slate-500" aria-hidden="true" />Signed-in devices</h2>
      <p className="mt-1 text-sm text-slate-600">If you do not recognise one, sign it out and change your password.</p>
      {q.isLoading && <p className="mt-3 text-sm text-slate-500" role="status">Loading…</p>}
      <ul className="mt-3 divide-y divide-slate-100" aria-label="Signed-in devices">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{s.device}{s.current && <span className="ml-2 rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">This device</span>}</p>
              <p className="text-xs text-slate-600">Signed in {new Date(s.since).toLocaleDateString()} · last active {new Date(s.lastUsed).toLocaleString()}</p>
            </div>
            {!s.current && <Button size="sm" variant="secondary" aria-label={`Sign out ${s.device}`} disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
          </li>
        ))}
      </ul>
      {list.length > 1 && <Button className="mt-3" size="sm" variant="secondary" disabled={others.isPending} onClick={() => others.mutate()}>Sign out all other devices</Button>}
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

