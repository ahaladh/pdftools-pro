import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authedFetch, getToken, refreshSession, RefreshError, setToken } from './session';

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const fresh = { user: { id: '1' }, accessToken: 'new-token', expiresIn: 900 };

describe('session', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { setToken(null); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('shares one refresh request between concurrent callers and keeps the token in memory only', async () => {
    fetchMock.mockResolvedValue(ok(fresh));
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a?.accessToken).toBe('new-token'); expect(b?.accessToken).toBe('new-token');
    expect(getToken()).toBe('new-token');
    expect(JSON.stringify({ ...localStorage })).not.toContain('new-token');
    expect(fetchMock.mock.calls[0]![1].headers['X-PDFTools-CSRF']).toBe('1'); // CSRF header always sent
  });

  it('retries a 401 once with a refreshed token', async () => {
    setToken('old');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok(fresh)) // refresh
      .mockResolvedValueOnce(ok({ hello: 1 }));
    const res = await authedFetch('/api/me');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer old');
    expect(fetchMock.mock.calls[2]![1].headers.Authorization).toBe('Bearer new-token');
  });

  it('rejects with kind "unavailable" on network errors and 5xx, without touching the token', async () => {
    setToken('keep-me');
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await expect(refreshSession()).rejects.toMatchObject({ kind: 'unavailable' });
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 503 }));
    await expect(refreshSession()).rejects.toBeInstanceOf(RefreshError);
    expect(getToken()).toBe('keep-me');
  });

  it('does NOT sign out when the refresh endpoint is merely unreachable', async () => {
    setToken('old');
    const signedOut = vi.fn(); window.addEventListener('pt:signed-out', signedOut);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockRejectedValueOnce(new TypeError('network down'));
    const res = await authedFetch('/api/me');
    expect(res.status).toBe(401);
    expect(signedOut).not.toHaveBeenCalled();
    window.removeEventListener('pt:signed-out', signedOut);
  });

  it('signs out (and does not loop) when refresh is rejected', async () => {
    setToken('old');
    const signedOut = vi.fn(); window.addEventListener('pt:signed-out', signedOut);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{"ok":false}', { status: 401 }));
    const res = await authedFetch('/api/me');
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signedOut).toHaveBeenCalled();
    expect(getToken()).toBeNull();
  });

  it('does not attach credentials or refresh for anonymous callers', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await authedFetch('/api/config');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });
});
