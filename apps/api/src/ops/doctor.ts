import { execFile } from 'node:child_process';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { zipSync, strToU8 } from 'fflate';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { processToolIsolated, engineEnv } from '@pdftools/pdf-core';
import { ClamdScanner } from '../modules/security/antivirus.js';
import { adminTwoFactorRequired } from '../modules/auth/policy.js';
import { webauthnConfig, webauthnProblems } from '../modules/auth/webauthn-config.js';
import type { Env } from '../config/env.js';
import { connectDb, disconnectDb } from '../db/models.js';
import { migrationStatus } from '../db/migrations.js';

const exec = promisify(execFile);
export type Level = 'pass' | 'warn' | 'fail';
export interface DoctorCheck { name: string; level: Level; detail: string }

const ENGINES: [string, string[]][] = [
  ['gs', ['--version']], ['pdftoppm', ['-v']], ['pdftotext', ['-v']], ['pdftohtml', ['-v']], ['pdfimages', ['-v']],
  ['convert', ['-version']], ['soffice', ['--version']], ['prlimit', ['--version']],
];
const weak = (s: string | undefined) => !s || s.length < 32 || /^(x+|0+|changeme|change-me|secret|password)/i.test(s);

/** Pure configuration review. Exported for unit tests; production-only rules apply when NODE_ENV=production. */
export function checkConfig(env: Env): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });
  const prod = env.NODE_ENV === 'production';
  add('environment', prod ? 'pass' : 'warn', prod ? 'NODE_ENV=production' : `NODE_ENV=${env.NODE_ENV}: production-only checks are advisory`);
  const sev = (bad: boolean): Level => (bad ? (prod ? 'fail' : 'warn') : 'pass');

  add('download secret', sev(env.GENERATED.download || weak(env.DOWNLOAD_SECRET)), env.GENERATED.download ? 'DOWNLOAD_SECRET not set (random per start: download links break on restart and across instances)' : weak(env.DOWNLOAD_SECRET) ? 'DOWNLOAD_SECRET is short or looks like a placeholder' : 'set');
  if (env.MONGODB_URI) add('jwt secret', sev(env.GENERATED.jwt || weak(env.JWT_ACCESS_SECRET)), env.GENERATED.jwt || weak(env.JWT_ACCESS_SECRET) ? 'JWT_ACCESS_SECRET missing, short or a placeholder (sessions break across instances/restarts)' : 'set');
  add('public url is https', sev(!env.PUBLIC_URL.startsWith('https://')), env.PUBLIC_URL);
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  add('cors origins', sev(origins.some((o) => !o.startsWith('https://') || o === '*')), origins.join(', ') || '(none)');
  add('reverse proxy trust', env.TRUST_PROXY >= 1 ? 'pass' : prod ? 'warn' : 'pass', env.TRUST_PROXY >= 1 ? `TRUST_PROXY=${env.TRUST_PROXY}` : 'TRUST_PROXY=0: behind a proxy every visitor shares one IP for rate limits and guest quotas');
  add('rate limiting', sev(!env.RATE_LIMIT_ENABLED), env.RATE_LIMIT_ENABLED ? 'enabled' : 'DISABLED');
  add('antivirus', 'pass', env.AV_MODE === 'enforce' ? `ClamAV scanning on (${env.CLAMD_SOCKET ?? `${env.CLAMD_HOST}:${env.CLAMD_PORT}`}); if it cannot answer, uploads are ${env.AV_FAIL === 'open' ? 'allowed with a warning' : 'refused'}` : 'off: uploads are not virus-scanned (recommended on for a public deployment: see docs/SECURITY.md)');
  add('job isolation', sev(!env.ISOLATE_JOBS), env.ISOLATE_JOBS ? `process isolation on (cap ${env.ISOLATION_MEMORY_MB} MB)` : 'DISABLED: documents are processed inside the API/worker process');
  add('metrics endpoint', env.METRICS_TOKEN ? 'pass' : 'warn', env.METRICS_TOKEN ? 'protected by METRICS_TOKEN' : prod ? '/metrics is disabled (set METRICS_TOKEN to enable scraping)' : 'open (development)');
  if (env.MONGODB_URI) {
    add('email delivery', env.SMTP_URL ? 'pass' : 'warn', env.SMTP_URL ? 'SMTP configured' : 'SMTP_URL not set: password-reset and email-confirmation messages cannot be delivered');
    add('two-factor key', env.TWO_FACTOR_KEY ? 'pass' : prod ? 'warn' : 'pass', env.TWO_FACTOR_KEY ? 'TWO_FACTOR_KEY set' : 'TWO_FACTOR_KEY not set: authenticator secrets are encrypted with JWT_ACCESS_SECRET, so rotating that secret would lock every 2FA user out. Set a separate TWO_FACTOR_KEY (32+ chars)');
    try {
      const wa = webauthnConfig(env), problems = webauthnProblems(wa);
      add('security keys (WebAuthn)', problems.length ? (prod ? 'fail' : 'warn') : 'pass', problems.length ? problems.join('; ') : `RP ID ${wa.rpID}, origins ${wa.origins.join(', ')} (changing the RP ID later makes every registered key unusable)`);
    } catch { add('security keys (WebAuthn)', 'fail', 'PUBLIC_URL is not a valid URL, so security keys cannot work'); }
    if (env.TWO_FACTOR_KEY_PREVIOUS.length) add('two-factor key rotation', 'warn', `${env.TWO_FACTOR_KEY_PREVIOUS.length} previous key(s) configured: a rotation is in progress. Run \`rotate-2fa status\`; once everything is on the current key, remove TWO_FACTOR_KEY_PREVIOUS`);
    {
      const stripeOn = !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
      const bad = env.TEAM_BILLING === 'per_seat' && env.TEAM_MIN_SEATS > env.TEAM_MAX_SEATS;
      add('team billing', bad ? 'fail' : env.TEAM_BILLING === 'per_seat' && !stripeOn ? 'warn' : 'pass',
        bad ? `TEAM_MIN_SEATS (${env.TEAM_MIN_SEATS}) is above TEAM_MAX_SEATS (${env.TEAM_MAX_SEATS}): no seat count would be valid`
          : env.TEAM_BILLING === 'per_seat' ? (stripeOn ? `per seat (${env.TEAM_MIN_SEATS} to ${env.TEAM_MAX_SEATS} seats): the plan's Stripe price must be a per-seat price` : 'TEAM_BILLING=per_seat but Stripe is not configured: teams cannot subscribe')
            : 'flat price; seats come from TEAM_SEATS_*');
    }
    if (env.STRIPE_API_BASE) add('stripe api base', prod ? 'fail' : 'warn', `STRIPE_API_BASE=${env.STRIPE_API_BASE}: Stripe calls go there instead of api.stripe.com (test double); never use in production`);
    add('admin two-step sign-in', adminTwoFactorRequired(env) ? 'pass' : prod ? 'warn' : 'pass', adminTwoFactorRequired(env) ? 'required for administrators' : prod ? 'REQUIRE_ADMIN_2FA=false: administrators can use the admin area with just a password (use only briefly, to recover)' : 'off (default outside production)');
    add('verified email for checkout', env.REQUIRE_VERIFIED_EMAIL ? 'pass' : prod ? 'warn' : 'pass', env.REQUIRE_VERIFIED_EMAIL ? 'required' : 'REQUIRE_VERIFIED_EMAIL is off: an unconfirmed address can start a paid checkout');
    add('bootstrap admin', env.ADMIN_PASSWORD ? 'warn' : 'pass', env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD is still set: remove it after the first start' : 'not set');
  }
  const stripeBits = [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET].filter(Boolean).length;
  add('billing', stripeBits === 1 ? 'fail' : 'pass', stripeBits === 2 ? 'Stripe configured' : stripeBits === 0 ? 'not configured (checkout disabled)' : 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together');
  if (stripeBits === 2 && !env.STRIPE_PRICE_PRO && !env.STRIPE_PRICE_BUSINESS) add('billing prices', 'warn', 'no Stripe price ids in env (they can still be set in the admin settings)');
  if (env.QUEUE_DRIVER === 'inline' && env.WORKER_CONCURRENCY > 4) add('inline concurrency', 'warn', 'many inline jobs share the API container; consider QUEUE_DRIVER=bullmq with workers');
  return out;
}

/** Engines for optional features: absence is a warning that names what stops working, not a failed deployment. */
const OPTIONAL: { bin: () => string | undefined; args: string[]; missing: string }[] = [
  { bin: () => 'tesseract', args: ['--version'], missing: 'OCR will be unavailable (set PDFTOOLS_BIN_DIR/TESSDATA_PREFIX or install tesseract-ocr)' },
  { bin: () => process.env.VERAPDF_BIN, args: ['--version'], missing: 'PDF/A results will be marked "not independently validated" (set VERAPDF_BIN to a veraPDF CLI)' },
];

async function engines(): Promise<DoctorCheck[]> {
  const env = engineEnv(tmpdir()); // the same PATH/variables jobs use
  const required = ENGINES.map(async ([bin, args]): Promise<DoctorCheck> => {
    try { const { stdout, stderr } = await exec(bin, args, { timeout: 20_000, env }); return { name: `engine: ${bin}`, level: 'pass', detail: (stdout + stderr).split('\n')[0]!.trim().slice(0, 80) }; }
    catch (e) { return { name: `engine: ${bin}`, level: 'fail', detail: (e as { code?: string }).code === 'ENOENT' ? 'not installed' : 'failed to run' }; }
  });
  const optional = OPTIONAL.map(async (o): Promise<DoctorCheck> => {
    const bin = o.bin();
    const name = `engine: ${bin ? bin.split('/').pop() : 'veraPDF'} (optional)`;
    if (!bin) return { name, level: 'warn', detail: o.missing };
    try { const { stdout, stderr } = await exec(bin, o.args, { timeout: 30_000, env: { ...env, JAVA_TOOL_OPTIONS: '-Xmx256m' } }); return { name, level: 'pass', detail: (stdout + stderr).split('\n').find((l) => l.trim())!.trim().slice(0, 80) }; }
    catch { return { name, level: 'warn', detail: o.missing }; }
  });
  return Promise.all([...required, ...optional]);
}

/** Prove the kernel really enforces the memory cap the isolation relies on (not just that prlimit exists). */
async function limitsEnforced(): Promise<DoctorCheck> {
  const run = (mb: number, alloc: number) => exec('/usr/bin/prlimit', [`--as=${mb * 1024 * 1024}`, '--', process.execPath, '-e', `Buffer.alloc(${alloc}*1024*1024)`], { timeout: 20_000 }).then(() => true, () => false);
  const small = await run(2048, 100), big = await run(2048, 2600);
  return small && !big
    ? { name: 'kernel memory limits', level: 'pass', detail: 'RLIMIT_AS is enforced (a 2.6 GB allocation is refused under a 2 GB cap)' }
    : { name: 'kernel memory limits', level: 'fail', detail: small ? 'RLIMIT_AS is NOT enforced: oversized allocations succeed under a cap' : 'node cannot start under a 2 GB address-space cap' };
}

async function storage(env: Env): Promise<DoctorCheck[]> {
  const dir = join(resolve(env.STORAGE_DIR), 'jobs');
  try {
    await mkdir(dir, { recursive: true });
    const f = join(dir, `.doctor-${process.pid}`); await writeFile(f, 'x'); await rm(f);
    const s = await statfs(dir); const freeGB = (s.bavail * s.bsize) / 1e9;
    return [{ name: 'storage writable', level: 'pass', detail: dir }, { name: 'free disk space', level: freeGB < 0.5 ? 'fail' : freeGB < 5 ? 'warn' : 'pass', detail: `${freeGB.toFixed(1)} GB free${env.MAX_STORAGE_MB ? `; app cap ${env.MAX_STORAGE_MB} MB` : ''}` }];
  } catch { return [{ name: 'storage writable', level: 'fail', detail: `cannot write to ${dir}` }]; }
}

async function deep(env: Env): Promise<DoctorCheck[]> {
  const dir = join(resolve(env.STORAGE_DIR), 'jobs', `.doctor-deep-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>doctor</w:t></w:r></w:p></w:body></w:document>'),
  });
  const input = join(dir, 'doctor.docx'); await writeFile(input, docx);
  const iso = Math.max(1536, env.ISOLATION_MEMORY_MB);
  const limits = { memoryMB: Math.min(env.ENGINE_MEMORY_MB, iso), officeMemoryMB: Math.min(env.ENGINE_OFFICE_MEMORY_MB, iso), cpuSeconds: env.ENGINE_CPU_SECONDS, fileMB: env.ENGINE_MAX_FILE_MB };
  const w = join(dir, 'w'); await mkdir(w);
  try {
    const t0 = Date.now();
    const r = await processToolIsolated('office-to-pdf', { workDir: w, inputs: [{ path: input, name: 'doctor.docx', kind: 'office' }], options: {}, timeoutMs: 90_000, maxPages: 10, limits }, { memoryMB: iso });
    return [{ name: 'end-to-end: office conversion under the production limits', level: 'pass', detail: `${r.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s` }];
  } catch (e) { return [{ name: 'end-to-end: office conversion under the production limits', level: 'fail', detail: (e as Error).message }]; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export async function runDoctor(env: Env, opts: { deep?: boolean } = {}): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node version', level: major >= 20 ? 'pass' : 'fail', detail: process.version });
  checks.push(...checkConfig(env), ...(await engines()), await limitsEnforced(), ...(await storage(env)));

  if (env.MONGODB_URI) {
    try {
      await connectDb(env.MONGODB_URI);
      await mongoose.connection.db!.admin().ping();
      const s = await migrationStatus();
      checks.push({ name: 'mongodb', level: 'pass', detail: 'reachable' });
      checks.push({ name: 'database migrations', level: s.unknown.length ? 'fail' : s.pending.length ? 'warn' : 'pass', detail: s.unknown.length ? `database is NEWER than this code: ${s.unknown.join(', ')}` : s.pending.length ? `pending: ${s.pending.join(', ')} (applied automatically at API start unless MIGRATIONS=check/off)` : 'up to date' });
    } catch (e) { checks.push({ name: 'mongodb', level: 'fail', detail: `unreachable (${(e as Error).message.slice(0, 80)})` }); }
    finally { await disconnectDb().catch(() => undefined); }
  }
  if (env.AV_MODE === 'enforce') {
    const p = await new ClamdScanner({ host: env.CLAMD_HOST, port: env.CLAMD_PORT, socketPath: env.CLAMD_SOCKET, timeoutMs: 5000 }).ping();
    checks.push({ name: 'antivirus scanner', level: p.ok ? 'pass' : env.AV_FAIL === 'closed' ? 'fail' : 'warn',
      detail: p.ok ? `clamd reachable (${p.version})` : `clamd unreachable (${p.error}): ${env.AV_FAIL === 'closed' ? 'every upload would be refused' : 'uploads are being accepted unscanned'}` });
  }
  if (env.QUEUE_DRIVER === 'bullmq') {
    const r = new Redis(env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    r.on('error', () => undefined);
    try { await r.connect(); await r.ping(); const pol = (await r.config('GET', 'maxmemory-policy')) as string[]; checks.push({ name: 'redis', level: 'pass', detail: 'reachable' }); checks.push({ name: 'redis eviction policy', level: pol[1] === 'noeviction' ? 'pass' : 'warn', detail: `maxmemory-policy=${pol[1]}${pol[1] === 'noeviction' ? '' : ' (queued jobs can be evicted under memory pressure; use noeviction)'}` }); }
    catch { checks.push({ name: 'redis', level: 'fail', detail: 'unreachable' }); }
    finally { r.disconnect(); }
  }
  if (opts.deep) checks.push(...(await deep(env)));
  return { ok: checks.every((c) => c.level !== 'fail'), checks };
}
