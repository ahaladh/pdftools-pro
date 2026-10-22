import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';

/** Parse a dotenv-style file the way a shell or docker compose would: `KEY=value`, comments and blank lines ignored. */
const parse = (text: string) => Object.entries(Object.fromEntries(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])));
const example = parse(readFileSync(join(process.cwd(), '../../.env.example'), 'utf8'));

describe('.env.example', () => {
  it('every line is accepted exactly as shipped (blank secrets mean "not set"; nothing is rejected)', () => {
    expect(example.filter(([, v]) => v === '').length).toBeGreaterThan(5); // it does ship blanks for values the operator fills in
    const rejected: string[] = [];
    for (const [k, v] of example) { try { loadEnv({ NODE_ENV: 'development', [k]: v }); } catch (e) { rejected.push(`${k}=${JSON.stringify(v)}: ${(e as Error).message.split('\n')[1]?.trim()}`); } }
    expect(rejected).toEqual([]);
    // and all of it at once, as a copied file would be
    expect(() => loadEnv({ ...Object.fromEntries(example), NODE_ENV: 'development' })).not.toThrow();
  });

  it('a blank optional secret is "not set" (so production still demands the ones it requires), and a blank that is a real answer stays one', () => {
    const e = loadEnv({ NODE_ENV: 'development', TWO_FACTOR_KEY: '', STRIPE_API_BASE: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', METRICS_TOKEN: '', DOWNLOAD_SECRET: '', JWT_ACCESS_SECRET: '' });
    expect(e.TWO_FACTOR_KEY).toBeUndefined(); expect(e.STRIPE_API_BASE).toBeUndefined(); expect(e.ADMIN_EMAIL).toBeUndefined(); expect(e.METRICS_TOKEN).toBeUndefined();
    expect(e.GENERATED).toEqual({ download: true, jwt: true }); // generated for this process, exactly as when unset
    expect(() => loadEnv({ NODE_ENV: 'production', DOWNLOAD_SECRET: '' })).toThrow(/DOWNLOAD_SECRET .* is required in production/); // a blank secret is not a configured one
    expect(loadEnv({ NODE_ENV: 'test', PREMIUM_TOOLS: '' }).PREMIUM_TOOLS).toBe(''); // "no premium tools" is a real answer
    expect(loadEnv({ NODE_ENV: 'test' }).PREMIUM_TOOLS).toBe('office-to-pdf,redact,compare');
  });

  it('a value that is set is still validated', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', TWO_FACTOR_KEY: 'too short' })).toThrow(/TWO_FACTOR_KEY/);
    expect(() => loadEnv({ NODE_ENV: 'test', STRIPE_API_BASE: 'not a url' })).toThrow(/STRIPE_API_BASE/);
    expect(() => loadEnv({ NODE_ENV: 'test', ADMIN_EMAIL: 'nope' })).toThrow(/ADMIN_EMAIL/);
    expect(() => loadEnv({ NODE_ENV: 'test', TEAM_BILLING: '' })).toThrow(/TEAM_BILLING/); // an enum setting must be a real value (the example ships a real one)
  });
});
