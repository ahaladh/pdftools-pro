import type { ApiResponse, JobView, PlanConfig, PublicConfig, UsageView, UserView } from '@pdftools/shared';
import { authedFetch, getToken, refreshSession, type AuthPayload } from './session';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function parse<T>(res: Response): Promise<T> {
  let body: ApiResponse<T> | undefined;
  try { body = (await res.json()) as ApiResponse<T>; } catch { /* non-JSON */ }
  if (!body) throw new ApiError('bad_response', `Server returned an unexpected response (${res.status})`, res.status);
  if (!body.ok) throw new ApiError(body.error.code, body.error.message, res.status);
  return body.data;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async <T,>(path: string, init?: RequestInit) => parse<T>(await authedFetch(path, init));

export interface PublicPlan extends Omit<PlanConfig, 'stripePriceId'> { purchasable: boolean }
export interface Paged<T> { rows: T[]; total: number; page: number; pageSize: number }

export const api = {
  config: () => call<PublicConfig>('/api/config'),
  plans: () => call<PublicPlan[]>('/api/plans'),
  job: (id: string) => call<JobView>(`/api/jobs/${id}`),
  cancel: (id: string) => call<JobView>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  deleteFile: (fileId: string) => call<{ deleted: boolean }>(`/api/files/${fileId}`, { method: 'DELETE' }),

  /** Fetch a result with credentials and hand it to the browser as a download. */
  async download(url: string, filename: string) {
    const res = await authedFetch(url);
    if (!res.ok) await parse(res); // throws ApiError with the server's message
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },

  auth: {
    register: (b: { email: string; password: string; name: string }) => call<AuthPayload>('/api/auth/register', json('POST', b)),
    /** Either a session, or - when the account has two-factor on - just a challenge to answer with a code. */
    login: (b: { email: string; password: string }) => call<AuthPayload | import('@pdftools/shared').TwoFactorChallenge>('/api/auth/login', json('POST', b)),
    loginTwoFactor: (b: { challenge: string; code: string }) => call<AuthPayload>('/api/auth/login/2fa', json('POST', b)),
    /** Second step with a security key: the browser's options, then the signed answer. */
    loginKeyOptions: (challenge: string) => call<unknown>('/api/auth/login/2fa/key/options', json('POST', { challenge })),
    loginKey: (b: { challenge: string; response: unknown }) => call<AuthPayload>('/api/auth/login/2fa/key', json('POST', b)),
    verifyEmail: (token: string) => call<{ verified: boolean }>('/api/auth/verify-email', json('POST', { token })),
    resendVerification: () => call<{ sent: boolean }>('/api/auth/resend-verification', { method: 'POST' }),
    sessions: () => call<import('@pdftools/shared').SessionInfo[]>('/api/auth/sessions'),
    revokeSession: (id: string) => call<{ revoked: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    revokeOtherSessions: () => call<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST' }),
    // keepalive: the revocation request must complete even if the user navigates away or closes the tab immediately.
    logout: () => call<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST', headers: { 'X-PDFTools-CSRF': '1' }, keepalive: true }),
    forgot: (email: string) => call<{ message: string }>('/api/auth/forgot-password', json('POST', { email })),
    reset: (token: string, password: string) => call<{ reset: boolean }>('/api/auth/reset-password', json('POST', { token, password })),
  },
  me: {
    get: () => call<UserView>('/api/me'),
    update: (name: string) => call<UserView>('/api/me', json('PATCH', { name })),
    changePassword: (currentPassword: string, newPassword: string) => call<AuthPayload>('/api/me/password', json('POST', { currentPassword, newPassword })),
    twoFactorSetup: (password: string) => call<{ secret: string; otpauthUri: string; qr: string }>('/api/me/2fa/setup', json('POST', { password })),
    twoFactorEnable: (code: string) => call<AuthPayload & { recoveryCodes: string[] }>('/api/me/2fa/enable', json('POST', { code })),
    twoFactorDisable: (password: string, code: string) => call<AuthPayload>('/api/me/2fa/disable', json('POST', { password, code })),
    recoveryCodes: (password: string, code: string) => call<{ recoveryCodes: string[] }>('/api/me/2fa/recovery-codes', json('POST', { password, code })),
    securityKeys: () => call<{ keys: import('@pdftools/shared').SecurityKeyView[] }>('/api/me/security-keys'),
    securityKeyOptions: (password: string) => call<unknown>('/api/me/security-keys/options', json('POST', { password })),
    securityKeyAdd: (response: unknown, name: string) => call<{ keys: import('@pdftools/shared').SecurityKeyView[]; recoveryCodes?: string[] } & Partial<AuthPayload>>('/api/me/security-keys', json('POST', { response, name })),
    securityKeyRemove: (id: string, password: string, code: string) => call<AuthPayload & { keys: import('@pdftools/shared').SecurityKeyView[] }>(`/api/me/security-keys/${encodeURIComponent(id)}`, json('DELETE', { password, code })),
    usage: () => call<UsageView>('/api/me/usage'),
    jobs: () => call<JobView[]>('/api/me/jobs'),
    remove: (password: string) => call<{ deleted: boolean }>('/api/me', json('DELETE', { password })),
  },
  teams: {
    mine: () => call<import('@pdftools/shared').TeamView | null>('/api/teams/mine'),
    create: (name: string) => call<import('@pdftools/shared').TeamView>('/api/teams', json('POST', { name })),
    rename: (name: string) => call<import('@pdftools/shared').TeamView>('/api/teams/mine', json('PATCH', { name })),
    setMemberCap: (memberDailyCap: number | null) => call<import('@pdftools/shared').TeamView>('/api/teams/mine/settings', json('PATCH', { memberDailyCap })),
    remove: () => call<{ deleted: boolean }>('/api/teams/mine', { method: 'DELETE' }),
    invite: (email: string, role: 'admin' | 'member') => call<import('@pdftools/shared').TeamView>('/api/teams/mine/invites', json('POST', { email, role })),
    cancelInvite: (id: string) => call<import('@pdftools/shared').TeamView>(`/api/teams/mine/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    accept: (token: string) => call<import('@pdftools/shared').TeamView>('/api/teams/invites/accept', json('POST', { token })),
    setRole: (userId: string, role: 'admin' | 'member') => call<import('@pdftools/shared').TeamView>(`/api/teams/mine/members/${userId}`, json('PATCH', { role })),
    removeMember: (userId: string) => call<import('@pdftools/shared').TeamView>(`/api/teams/mine/members/${userId}`, { method: 'DELETE' }),
    leave: () => call<{ left: boolean }>('/api/teams/mine/leave', { method: 'POST' }),
    transfer: (userId: string) => call<import('@pdftools/shared').TeamView>('/api/teams/mine/transfer', json('POST', { userId })),
    checkout: (plan: 'pro' | 'business', seats?: number) => call<{ url: string }>('/api/billing/team/checkout', json('POST', { plan, ...(seats !== undefined ? { seats } : {}) })),
    setSeats: (seats: number) => call<{ seats: number }>('/api/billing/team/seats', json('POST', { seats })),
    portal: () => call<{ url: string }>('/api/billing/team/portal', { method: 'POST' }),
  },
  billing: {
    checkout: (plan: 'pro' | 'business') => call<{ url: string }>('/api/billing/checkout', json('POST', { plan })),
    portal: () => call<{ url: string }>('/api/billing/portal', { method: 'POST' }),
  },
  admin: {
    dashboard: () => call<AdminDashboard>('/api/admin/dashboard'),
    users: (q: { page: number; q?: string }) => call<Paged<AdminUser>>(`/api/admin/users?page=${q.page}&pageSize=20${q.q ? `&q=${encodeURIComponent(q.q)}` : ''}`),
    teams: (q: { page: number; q?: string }) => call<Paged<import('@pdftools/shared').AdminTeamRow>>(`/api/admin/teams?page=${q.page}&pageSize=15${q.q ? `&q=${encodeURIComponent(q.q)}` : ''}`),
    team: (id: string) => call<import('@pdftools/shared').AdminTeamDetail>(`/api/admin/teams/${encodeURIComponent(id)}`),
    transferTeam: (id: string, userId: string) => call<import('@pdftools/shared').AdminTeamDetail>(`/api/admin/teams/${encodeURIComponent(id)}/transfer`, json('POST', { userId })),
    deleteTeam: (id: string) => call<{ deleted: boolean }>(`/api/admin/teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    resetTwoFactor: (id: string) => call<AdminUser>(`/api/admin/users/${id}/2fa/reset`, { method: 'POST' }),
    updateUser: (id: string, patch: Partial<Pick<AdminUser, 'role' | 'plan' | 'status'>>) => call<AdminUser>(`/api/admin/users/${id}`, json('PATCH', patch)),
    jobs: (q: { page: number; state?: string; tool?: string }) => call<Paged<AdminJob>>(`/api/admin/jobs?page=${q.page}&pageSize=20${q.state ? `&state=${q.state}` : ''}${q.tool ? `&tool=${q.tool}` : ''}`),
    usage: (days: number) => call<{ days: { day: string; ops: number; activeOwners: number }[]; topTools: { tool: string; ops: number }[] }>(`/api/admin/usage?days=${days}`),
    settings: () => call<import('@pdftools/shared').AppSettings>('/api/admin/settings'),
    saveSettings: (s: import('@pdftools/shared').AppSettings) => call<import('@pdftools/shared').AppSettings>('/api/admin/settings', json('PUT', s)),
    audit: (page: number) => call<Paged<AdminAudit>>(`/api/admin/audit?page=${page}&pageSize=30`),
  },

  /** multipart upload with progress (fetch cannot report upload progress). Retries once after a token refresh. */
  submit(tool: string, files: File[], options: unknown, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<{ jobId: string }> {
    const attempt = (retry: boolean): Promise<{ jobId: string }> => new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('options', JSON.stringify(options ?? {}));
      for (const f of files) form.append('files', f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/pdf/${tool}`);
      xhr.withCredentials = true;
      const t = getToken(); if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onerror = () => reject(new ApiError('network', 'Network error while uploading. Check your connection and try again.', 0));
      xhr.onabort = () => reject(new ApiError('aborted', 'Upload cancelled', 0));
      xhr.onload = async () => {
        if (xhr.status === 401 && t && retry && (await refreshSession().then(() => true, () => false))) return attempt(false).then(resolve, reject);
        try {
          const body = JSON.parse(xhr.responseText) as ApiResponse<{ jobId: string }>;
          if (body.ok) resolve(body.data); else reject(new ApiError(body.error.code, body.error.message, xhr.status));
        } catch { reject(new ApiError('bad_response', `Unexpected server response (${xhr.status})`, xhr.status)); }
      };
      signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(form);
    });
    return attempt(true);
  },
};

export interface AdminUser extends UserView { status: 'active' | 'disabled'; lastLoginAt?: string }
export interface AdminJob { id: string; owner: string; tool: string; state: string; plan: string; createdAt: string; error?: string; bytes?: number }
export interface AdminAudit { _id: string; at: string; actor: string; action: string; target?: string; ip?: string }
export interface AdminDashboard {
  teams: { total: number; paid: number };
  users: { total: number; active7d: number; admins: number; /** Administrators with no second sign-in step. */ adminsWithoutTwoFactor: number; twoFactorRequired: boolean; byPlan: Record<string, number> };
  jobs: { total: number; byState: Record<string, number>; completed: number; failed: number };
  queue: { waiting: number; active: number };
  running: { id: string; tool: string; plan: string; runningMs: number }[];
  storage: { bytes: number };
  system: { loadavg: number[]; cpus: number; rssBytes: number; heapUsedBytes: number; freeMemBytes: number; totalMemBytes: number };
}
