import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { forgotSchema, loginSchema, registerSchema, resetSchema } from '@pdftools/shared';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, TextInput } from '@/features/tools/fields';
import { api, ApiError } from '@/lib/api';
import { useSeo } from '@/hooks/useSeo';
import { useAuth } from '@/stores/auth';
import { safeNext } from '@/lib/safeNext';

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="bg-gradient-to-b from-brand-50/80 via-white to-white">
      <div className="mx-auto max-w-md px-4 py-16 sm:py-20">
        <div className="text-center">
          <LogoMark className="mx-auto h-12 w-12 drop-shadow-[0_8px_16px_rgb(79_70_229/0.35)]" />
          <h1 className="mt-5 text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-slate-600">{subtitle}</p>}
        </div>
        <Card className="mt-8 p-7 shadow-[var(--shadow-lift)]">{children}</Card>
        {footer && <p className="mt-5 text-center text-sm text-slate-600">{footer}</p>}
      </div>
    </div>
  );
}

const Err = ({ msg }: { msg?: string }) => (msg ? <p role="alert" className="mt-1 text-xs text-red-600">{msg}</p> : null);
const useServerError = () => { const [e, setE] = useState<string | null>(null); return [e, (x: unknown) => setE(x instanceof ApiError || x instanceof Error ? x.message : 'Something went wrong.'), () => setE(null)] as const; };

export function SignIn() {
  useSeo({ title: 'Sign in', description: 'Sign in to your account.', path: '/signin', noindex: true });
  const nav = useNavigate();
  const [params] = useSearchParams();
  const status = useAuth((s) => s.status);
  const login = useAuth((s) => s.login);
  const completeTwoFactor = useAuth((s) => s.completeTwoFactor);
  const [serverError, fail, clear] = useServerError();
  const f = useForm<z.input<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  /** Set once the password was accepted for an account with two-factor sign-in on. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to={safeNext(params.get('next'))} replace />;

  if (challenge) {
    return (
      <Shell title="Two-step verification" subtitle={useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
        footer={<button type="button" className="text-brand-700 underline" onClick={() => { setChallenge(null); setCode(''); setUseRecovery(false); clear(); }}>Back to sign in</button>}>
        <form className="space-y-4" noValidate onSubmit={async (e) => {
          e.preventDefault(); clear(); setBusy(true);
          try { await completeTwoFactor(challenge, code); nav(safeNext(params.get('next'))); }
          catch (err) {
            fail(err);
            // An expired or invalid challenge cannot be retried: start over rather than leave the user stuck.
            if (err instanceof ApiError && err.code === 'invalid_challenge') { setChallenge(null); setCode(''); }
          } finally { setBusy(false); }
        }}>
          <Field label={useRecovery ? 'Recovery code' : 'Authentication code'} hint={useRecovery ? 'Each recovery code works once.' : undefined}>
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} maxLength={useRecovery ? 16 : 6} spellCheck={false} placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'} />
          </Field>
          {serverError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{serverError}</p>}
          <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</Button>
          <p className="text-center text-sm"><button type="button" className="text-slate-600 underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); clear(); }}>{useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}</button></p>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title="Sign in" footer={<>No account? <Link className="text-brand-700 underline" to="/register">Create one</Link></>}>
      <form className="space-y-4" noValidate onSubmit={f.handleSubmit(async (v) => { clear(); try { const r = await login(v.email, v.password); if (r) setChallenge(r.challenge); else nav(safeNext(params.get('next'))); } catch (e) { fail(e); } })}>
        <Field label="Email"><TextInput type="email" autoComplete="email" {...f.register('email')} /><Err msg={f.formState.errors.email?.message} /></Field>
        <Field label="Password"><TextInput type="password" autoComplete="current-password" {...f.register('password')} /><Err msg={f.formState.errors.password?.message} /></Field>
        {serverError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={f.formState.isSubmitting}>{f.formState.isSubmitting ? 'Signing in…' : 'Sign in'}</Button>
        <p className="text-center text-sm"><Link to="/forgot-password" className="text-slate-600 underline">Forgot your password?</Link></p>
      </form>
    </Shell>
  );
}

/** Landing page for the link in the confirmation email. The token in the URL is the credential; it works once. */
export function VerifyEmail() {
  useSeo({ title: 'Confirm your email', description: 'Confirm your email address.', path: '/verify-email', noindex: true });
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
  const [error, setError] = useState(token ? '' : 'This link is incomplete. Open the whole link from the email.');
  const ran = useRef(false);
  const setUser = useAuth((s) => s.setUser);
  const user = useAuth((s) => s.user);
  useEffect(() => {
    if (!token || ran.current) return; // StrictMode runs effects twice; a one-time token must be spent only once
    ran.current = true;
    api.auth.verifyEmail(token).then(() => { setState('done'); if (user) setUser({ ...user, emailVerified: true }); })
      .catch((e: unknown) => { setState('failed'); setError(e instanceof Error ? e.message : 'Could not confirm your email.'); });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Shell title="Confirm your email">
      {state === 'working' && <p role="status" className="text-sm text-slate-700">Confirming…</p>}
      {state === 'done' && <p role="status" className="text-sm text-slate-800">Thanks, your email address is confirmed. <Link className="text-brand-700 underline" to="/account">Go to your account</Link></p>}
      {state === 'failed' && <div role="alert" className="space-y-3 text-sm"><p className="text-red-700">{error}</p><Link className="text-brand-700 underline" to="/account">Open your account to get a new link</Link></div>}
    </Shell>
  );
}

export function Register() {
  useSeo({ title: 'Create account', description: 'Create a free account.', path: '/register', noindex: true });
  const nav = useNavigate();
  const status = useAuth((s) => s.status);
  const register = useAuth((s) => s.register);
  const [serverError, fail, clear] = useServerError();
  const f = useForm<z.input<typeof registerSchema>>({ resolver: zodResolver(registerSchema), defaultValues: { name: '' } });
  if (status === 'authenticated') return <Navigate to="/account" replace />;
  return (
    <Shell title="Create your account" subtitle="Free. Higher daily limits and job history." footer={<>Already registered? <Link className="text-brand-700 underline" to="/signin">Sign in</Link></>}>
      <form className="space-y-4" noValidate onSubmit={f.handleSubmit(async (v) => { clear(); try { await register(v.email, v.password, v.name ?? ''); nav('/account'); } catch (e) { fail(e); } })}>
        <Field label="Name (optional)"><TextInput autoComplete="name" {...f.register('name')} /></Field>
        <Field label="Email"><TextInput type="email" autoComplete="email" {...f.register('email')} /><Err msg={f.formState.errors.email?.message} /></Field>
        <Field label="Password" hint="At least 10 characters."><TextInput type="password" autoComplete="new-password" {...f.register('password')} /><Err msg={f.formState.errors.password?.message} /></Field>
        {serverError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={f.formState.isSubmitting}>{f.formState.isSubmitting ? 'Creating…' : 'Create account'}</Button>
        <p className="text-xs text-slate-500">By creating an account you agree to the <Link to="/terms" className="underline">terms</Link> and <Link to="/privacy" className="underline">privacy policy</Link>.</p>
      </form>
    </Shell>
  );
}

export function ForgotPassword() {
  useSeo({ title: 'Reset password', description: 'Request a password reset link.', path: '/forgot-password', noindex: true });
  const [done, setDone] = useState(false);
  const [serverError, fail, clear] = useServerError();
  const f = useForm<z.input<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema) });
  return (
    <Shell title="Reset your password" footer={<Link className="text-brand-700 underline" to="/signin">Back to sign in</Link>}>
      {done ? <p role="status" className="text-sm text-slate-700">If an account exists for that email, a reset link is on its way. It expires in 1 hour.</p> : (
        <form className="space-y-4" noValidate onSubmit={f.handleSubmit(async (v) => { clear(); try { await api.auth.forgot(v.email); setDone(true); } catch (e) { fail(e); } })}>
          <Field label="Email"><TextInput type="email" autoComplete="email" {...f.register('email')} /><Err msg={f.formState.errors.email?.message} /></Field>
          {serverError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{serverError}</p>}
          <Button type="submit" className="w-full" disabled={f.formState.isSubmitting}>Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

const resetForm = resetSchema.pick({ password: true });
export function ResetPassword() {
  useSeo({ title: 'Choose a new password', description: 'Set a new password.', path: '/reset-password', noindex: true });
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [serverError, fail, clear] = useServerError();
  const f = useForm<z.input<typeof resetForm>>({ resolver: zodResolver(resetForm) });
  return (
    <Shell title="Choose a new password">
      {done ? <p role="status" className="text-sm">Your password was changed. <Link className="text-brand-700 underline" to="/signin">Sign in</Link></p> : !token ? <p role="alert" className="text-sm text-red-700">This reset link is incomplete. Request a new one.</p> : (
        <form className="space-y-4" noValidate onSubmit={f.handleSubmit(async (v) => { clear(); try { await api.auth.reset(token, v.password); setDone(true); } catch (e) { fail(e); } })}>
          <Field label="New password" hint="At least 10 characters."><TextInput type="password" autoComplete="new-password" {...f.register('password')} /><Err msg={f.formState.errors.password?.message} /></Field>
          {serverError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{serverError}</p>}
          <Button type="submit" className="w-full" disabled={f.formState.isSubmitting}>Change password</Button>
        </form>
      )}
    </Shell>
  );
}

/** Route guard. Waits for session restore, then redirects anonymous users to sign-in. */
export function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { status, user, init } = useAuth();
  if (status === 'unavailable') return <div role="alert" className="p-12 text-center"><p className="text-slate-700">We couldn't reach the server to restore your session.</p><Button className="mt-4" onClick={() => void init()}>Try again</Button></div>;
  if (status === 'loading') return <p className="p-12 text-center text-slate-500" role="status">Loading…</p>;
  if (status === 'anonymous') return <Navigate to={`/signin?next=${encodeURIComponent(window.location.pathname)}`} replace />;
  if (admin && user?.role !== 'admin') return <Navigate to="/account" replace />; // UX only; the API enforces this
  return <>{children}</>;
}
