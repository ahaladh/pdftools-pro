import { test, expect } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { ROOT } from '../support/stack';
import { NGINX, startEdge, type Edge } from '../support/edge';

/**
 * Verifies what the Docker images would contain WITHOUT a Docker daemon: it executes the real Dockerfiles' COPY and `npm` steps
 * in clean directories (infrastructure/scripts/sim-docker-build.mjs), then starts the resulting production tree behind nginx and
 * runs the post-deploy smoke test and the doctor against it. Opt in with E2E_VERIFY_IMAGES=1 (it re-installs dependencies twice).
 * It does NOT replace `docker build`: apt packages, USER, HEALTHCHECK and tini only exist in a real image (CI builds those).
 */
test.skip(!process.env.E2E_VERIFY_IMAGES, 'set E2E_VERIFY_IMAGES=1 to run (slow: two clean npm installs)');
test.skip(!NGINX && !process.env.CI, 'nginx not available');
test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);
test.use({ ignoreHTTPSErrors: true });

const run = promisify(execFile);
const OUT = process.env.E2E_IMAGES_DIR ?? '/tmp/pdftools-image-sim';
const sim = (dockerfile: string, target: string, extra: string[] = []) =>
  run(process.execPath, [join(ROOT, 'infrastructure/scripts/sim-docker-build.mjs'), `infrastructure/docker/${dockerfile}`, '--target', target, '--out', join(OUT, dockerfile), ...extra], { cwd: ROOT, maxBuffer: 50 * 1024 * 1024, timeout: 600_000 });

let apiRoot = '', webRoot = '', api: ChildProcess, edge: Edge, apiLog = '';
const SITE = 'https://localhost:4444';
const secrets = { DOWNLOAD_SECRET: randomBytes(32).toString('hex') };

test.beforeAll(async () => {
  // Building both images takes ~50s on a fast machine and about twice that on a CI runner: the 90s default was too tight.
  test.setTimeout(300_000);
  if (!process.env.E2E_IMAGES_REUSE) {
    await Promise.all([
      sim('Dockerfile.api', 'runtime'),
      // PRERENDER_BROWSER=system: the image uses Playwright's bundled Chromium; here we use the machine's Chrome.
      sim('Dockerfile.web', 'build', ['--build-arg', `SITE_URL=${SITE}`, '--env', 'PRERENDER_BROWSER=system']),
    ]);
  }
  apiRoot = join(OUT, 'Dockerfile.api/runtime/rootfs/app');
  webRoot = join(OUT, 'Dockerfile.web/build/rootfs/app/apps/web/dist');
});
test.afterAll(() => { edge?.stop(); try { process.kill(-api.pid!, 'SIGTERM'); } catch { /* gone */ } });

test.describe('API image contents', () => {
  test('production dependencies only: runtime libraries present, build and test tooling absent', () => {
    for (const p of ['express', 'bullmq', 'mongoose', 'ioredis', 'prom-client', '@cantoo/pdf-lib', 'fflate', 'stripe', 'jose']) expect(existsSync(join(apiRoot, 'node_modules', p)), p).toBe(true);
    for (const p of ['typescript', 'vitest', 'tsx', 'mongodb-memory-server', 'redis-memory-server', 'supertest', '@playwright/test', 'vite']) expect(existsSync(join(apiRoot, 'node_modules', p)), `${p} must not ship`).toBe(false);
    for (const f of ['server.js', 'worker.js', 'migrate.js', 'doctor.js']) expect(existsSync(join(apiRoot, 'apps/api/dist', f)), f).toBe(true);
    expect(existsSync(join(apiRoot, 'packages/pdf-core/dist/child.js'))).toBe(true); // the isolated job process entry
    expect(readdirSync(join(apiRoot, 'apps/api/dist')).filter((f) => f.endsWith('.test.js'))).toEqual([]); // no tests in the image
    expect(existsSync(join(apiRoot, 'apps/api/src'))).toBe(false);                                         // no sources
  });

  test('workspace links are relative, so the tree is relocatable (as in a real image)', () => {
    for (const p of ['shared', 'pdf-core', 'api']) {
      const l = join(apiRoot, 'node_modules/@pdftools', p);
      expect(lstatSync(l).isSymbolicLink(), p).toBe(true);
      expect(readlinkSync(l), p).toMatch(/^\.\.\//);
    }
  });
});

test.describe('web image contents', () => {
  test('the build ships a prerendered site, a pristine app shell, and SEO files for the configured origin', () => {
    for (const f of ['index.html', 'app-shell.html', 'sitemap.xml', 'robots.txt', 'merge/index.html', 'compress/index.html', 'assets']) expect(existsSync(join(webRoot, f)), f).toBe(true);
    expect(readFileSync(join(webRoot, 'app-shell.html'), 'utf8')).toContain('<div id="root"></div>');
    expect(readFileSync(join(webRoot, 'merge/index.html'), 'utf8')).toContain(`<link rel="canonical" href="${SITE}/merge">`);
    expect(readFileSync(join(webRoot, 'sitemap.xml'), 'utf8')).toContain(`<loc>${SITE}/merge</loc>`);
    expect(readFileSync(join(webRoot, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    expect(existsSync(join(webRoot, '_test.pdf'))).toBe(false); // no stray dev fixtures
  });
});

test.describe('the built production tree, running', () => {
  test.beforeAll(async () => {
    const env = {
      PATH: process.env.PATH!, NODE_ENV: 'production', PORT: '4203', STORAGE_DIR: join(OUT, 'storage'), TRUST_PROXY: '1', ...secrets,
      PUBLIC_URL: SITE, CORS_ORIGINS: SITE, RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX_PER_WINDOW: '100000', DAILY_OPS_GUEST: '1000', WORKER_CONCURRENCY: '1', APP_VERSION: 'image-sim',
    };
    api = spawn(process.execPath, ['apps/api/dist/server.js'], { cwd: apiRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    api.stdout!.on('data', (d: Buffer) => { apiLog += d; }); api.stderr!.on('data', (d: Buffer) => { apiLog += d; });
    for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:4203/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
    edge = startEdge({ apiAddr: '127.0.0.1:4203', httpPort: 4480 + 1, httpsPort: 4444, webRoot });
    await new Promise((r) => setTimeout(r, 800));
  });

  test('starts from the image tree with only the files the Dockerfile copied', () => {
    expect(apiLog).toContain('API listening on :4203 (version image-sim)');
    expect(apiLog).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });

  test('post-deploy smoke test passes against it through nginx + TLS (real merge job, download, delete)', async () => {
    const { stdout } = await run(process.execPath, [join(ROOT, 'infrastructure/scripts/smoke.mjs'), edge.httpsUrl, '--insecure', '--json'], { timeout: 120_000 }).catch((e) => ({ stdout: String(e.stdout ?? e) }));
    const r = JSON.parse(stdout);
    expect(r.results.filter((x: { ok: boolean }) => !x.ok), JSON.stringify(r.results.filter((x: { ok: boolean }) => !x.ok))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(8);
  });

  test('the smoke test really fails when the service is down or broken (it can detect problems)', async () => {
    const dead = await run(process.execPath, [join(ROOT, 'infrastructure/scripts/smoke.mjs'), 'http://127.0.0.1:1', '--json'], { timeout: 120_000 }).then(() => ({ code: 0 }), (e) => ({ code: e.code as number }));
    expect(dead.code).toBe(1);
    expect((await run(process.execPath, [join(ROOT, 'infrastructure/scripts/smoke.mjs')]).catch((e) => ({ code: e.code }))) as { code: number }).toMatchObject({ code: 2 }); // usage error
  });

  test('doctor runs from the image tree: engines found, kernel limits enforced', async () => {
    const env = { PATH: process.env.PATH!, NODE_ENV: 'development', STORAGE_DIR: join(OUT, 'doctor-storage') };
    const { stdout } = await run(process.execPath, ['apps/api/dist/doctor.js', '--json'], { cwd: apiRoot, env, timeout: 120_000 });
    const r = JSON.parse(stdout) as { ok: boolean; checks: { name: string; level: string }[] };
    expect(r.ok).toBe(true);
    for (const n of ['engine: gs', 'engine: soffice', 'engine: prlimit', 'kernel memory limits', 'storage writable']) expect(r.checks.find((c) => c.name === n)!.level, n).toBe('pass');
  });

  test('worker and migrate entry points exist and fail with a clear message when misconfigured (no stack traces)', async () => {
    const env = { PATH: process.env.PATH!, NODE_ENV: 'production', ...secrets };
    const w = await run(process.execPath, ['apps/api/dist/worker.js'], { cwd: apiRoot, env, timeout: 30_000 }).then(() => ({ stderr: '', code: 0 }), (e) => ({ stderr: String(e.stderr), code: e.code as number }));
    expect(w.code).not.toBe(0);
    expect(w.stderr).toMatch(/worker requires REDIS_URL and MONGODB_URI/);
    const m = await run(process.execPath, ['apps/api/dist/migrate.js', 'status'], { cwd: apiRoot, env, timeout: 30_000 }).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code as number, stderr: String(e.stderr) }));
    expect(m.code).toBe(2);
    expect(m.stderr).toMatch(/MONGODB_URI is not set/);
  });
});
