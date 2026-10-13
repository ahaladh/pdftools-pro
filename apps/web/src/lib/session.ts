import type { UserView } from '@pdftools/shared';

/**
 * The access token lives only in memory (never localStorage), so XSS cannot read a long-lived
 * credential. The refresh token is an httpOnly cookie the page cannot see at all.
 */
let token: string | null = null;
let inflight: Promise<AuthPayload> | null = null;

export interface AuthPayload { user: UserView; accessToken: string; expiresIn: number }

export const getToken = () => token;
export const setToken = (t: string | null) => { token = t; };

const HINT = 'pt_signed_in';
export const hasSessionHint = () => { try { return localStorage.getItem(HINT) === '1'; } catch { return false; } };
export const setSessionHint = (on: boolean) => { try { on ? localStorage.setItem(HINT, '1') : localStorage.removeItem(HINT); } catch { /* storage unavailable */ } };

/** 'invalid' = the server rejected the session (sign out). 'unavailable' = network/5xx (keep the session, retry later). */
export class RefreshError extends Error {
  constructor(public kind: 'invalid' | 'unavailable') { super(kind); }
}

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<AuthPayload> {
  inflight ??= (async () => {
    let res: Response;
    try { res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-PDFTools-CSRF': '1' } }); }
    catch { throw new RefreshError('unavailable'); }
    if (res.status === 401 || res.status === 403) { token = null; throw new RefreshError('invalid'); }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) throw new RefreshError('unavailable');
    token = (body.data as AuthPayload).accessToken;
    return body.data as AuthPayload;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** fetch with the bearer token; on 401 refreshes once and retries. */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const run = () => fetch(input, { ...init, credentials: 'include', headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const res = await run();
  if (res.status !== 401 || !token) return res;
  try { await refreshSession(); } catch (e) {
    // Only a definitive rejection ends the session; an outage just surfaces the original 401.
    if (e instanceof RefreshError && e.kind === 'invalid') window.dispatchEvent(new Event('pt:signed-out'));
    return res;
  }
  return run();
}
