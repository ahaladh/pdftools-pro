/**
 * Content-Security-Policy for the SPA. Single source of truth: used by `vite preview` (so the
 * end-to-end browser tests run under the real policy) and checked against infrastructure/nginx/default.conf.
 * - no inline/eval scripts; styles allow inline because React sets style attributes
 * - pdf.js runs its worker from our own origin (and blob: for its fake-worker fallback)
 * - data:/blob: images for canvas thumbnails and signature previews
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
