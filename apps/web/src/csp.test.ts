import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CSP, SECURITY_HEADERS } from '../csp';

describe('Content-Security-Policy', () => {
  it('forbids inline/eval scripts, plugins, framing and foreign form targets', () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("form-action 'self'");
    expect(CSP).not.toMatch(/\*|https?:/); // no wildcard or third-party origins
  });
  it('is identical in the nginx snippet that ships to production (no drift)', () => {
    const nginx = readFileSync(resolve(process.cwd(), '../../infrastructure/nginx/snippets/pdftools-security-headers.conf'), 'utf8');
    expect(nginx).toContain(`Content-Security-Policy "${CSP}"`);
  });
  it('sets the companion headers', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});
