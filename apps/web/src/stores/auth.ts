import { create } from 'zustand';
import type { UserView } from '@pdftools/shared';
import { api } from '@/lib/api';
import { hasSessionHint, refreshSession, RefreshError, setSessionHint, setToken, type AuthPayload } from '@/lib/session';

interface AuthState {
  /** 'unavailable': we believe a session exists but the server could not be reached. */
  status: 'loading' | 'anonymous' | 'authenticated' | 'unavailable';
  user: UserView | null;
  init: () => Promise<void>;
  accept: (p: AuthPayload) => void;
  /** Resolves to a challenge when the account needs a second factor, otherwise signs in and resolves to null. */
  login: (email: string, password: string) => Promise<{ challenge: string } | null>;
  completeTwoFactor: (challenge: string, code: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: UserView) => void;
  /** True after the user chose to sign out (or deleted their account), as opposed to a session that expired. */
  leftOnPurpose: boolean;
  clear: (opts?: { onPurpose?: boolean }) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  leftOnPurpose: false,
  /** Restore a session from the refresh cookie (only attempted if we previously signed in). */
  async init() {
    if (!hasSessionHint()) return set({ status: 'anonymous' });
    set({ status: 'loading' });
    try { get().accept(await refreshSession()); }
    catch (e) {
      // Keep the sign-in hint on outages so a reload retries instead of silently signing the user out.
      if (e instanceof RefreshError && e.kind === 'invalid') get().clear(); else set({ status: 'unavailable' });
    }
  },
  accept(p) { setToken(p.accessToken); setSessionHint(true); set({ status: 'authenticated', user: p.user, leftOnPurpose: false }); },
  async login(email, password) {
    const r = await api.auth.login({ email, password });
    if ('twoFactorRequired' in r) return { challenge: r.challenge };
    get().accept(r);
    return null;
  },
  async completeTwoFactor(challenge, code) { get().accept(await api.auth.loginTwoFactor({ challenge, code })); },
  async register(email, password, name) { get().accept(await api.auth.register({ email, password, name })); },
  async logout() { await api.auth.logout().catch(() => undefined); get().clear({ onPurpose: true }); },
  setUser(user) { set({ user }); },
  clear(opts) { setToken(null); setSessionHint(false); set({ status: 'anonymous', user: null, leftOnPurpose: !!opts?.onPurpose }); },
}));

// A refresh failure anywhere signs the user out of the UI.
if (typeof window !== 'undefined') window.addEventListener('pt:signed-out', () => useAuth.getState().clear());
