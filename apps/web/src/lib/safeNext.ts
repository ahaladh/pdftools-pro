/**
 * Only allow same-site, absolute-path redirects. Rejects "//host", "/\\host", "https://..." and
 * anything with control characters, so a crafted ?next= cannot send a user to another origin.
 */
export function safeNext(raw: string | null | undefined, fallback = '/account'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return fallback;
  return raw;
}
