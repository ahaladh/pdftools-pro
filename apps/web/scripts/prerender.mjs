// Prerender the public, indexable pages into static HTML so crawlers (and users on slow devices) get real content
// without running JavaScript. The SPA still boots over the top and takes over.
//
//   SITE_URL=https://pdf.example.com npm run build -w @pdftools/web     (runs automatically after `vite build`)
//
// Output: dist/index.html is the prerendered home page, dist/<route>/index.html for every other public route, and
// dist/app-shell.html is the untouched SPA shell (the fallback for client-side routes like /account).
// Needs a browser: system Chrome (channel "chrome") or PRERENDER_BROWSER=/path/to/chromium. Skip with PRERENDER=0.
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { TOOLS } from '@pdftools/shared';

const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('prerender: dist/index.html not found; run vite build first'); process.exit(1); }

// ALWAYS keep a pristine copy of the shell, even when prerendering is skipped: nginx falls back to it for client-side routes
// (/account, /admin, unknown paths), so a build without it would 404 on every deep link.
const shell = join(dist, 'app-shell.html');
if (!existsSync(shell)) copyFileSync(join(dist, 'index.html'), shell);
if (process.env.PRERENDER === '0') { console.log('prerender skipped (PRERENDER=0); app-shell.html written'); process.exit(0); }
const site = (process.env.SITE_URL ?? '').replace(/\/$/, '');
if (!site && process.env.PRERENDER_ALLOW_LOCAL !== '1') {
  console.error('prerender: set SITE_URL (the public origin) so canonical URLs in the snapshots are correct. For a local build use PRERENDER_ALLOW_LOCAL=1.');
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.mjs': 'text/javascript', '.txt': 'text/plain', '.xml': 'application/xml' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = shell; // SPA fallback to the pristine shell
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const routes = ['/', '/tools', '/view', '/privacy', '/terms', ...TOOLS.map((t) => `/${t.id}`)];
// PRERENDER_BROWSER: unset or "system" = system Chrome; "bundled" = Playwright's own Chromium (the Docker build image); else a path to a browser.
const pb = process.env.PRERENDER_BROWSER;
const launch = pb === 'bundled' ? {} : pb && pb !== 'system' ? { executablePath: pb } : { channel: 'chrome' };
const browser = await chromium.launch({ ...launch, headless: true });
let failed = 0;
try {
  for (const route of routes) {
    const page = await browser.newPage();
    // The API is not running at build time: answer the few calls public pages make with neutral defaults.
    // (They only affect numbers like "up to 50 MB"; the live app re-renders with real values on load.)
    await page.route('**/api/**', (r) => {
      const url = new URL(r.request().url());
      if (url.pathname === '/api/config') return r.fulfill({ json: { ok: true, data: { brand: process.env.VITE_BRAND_NAME ?? 'PDFTools Pro', maintenance: false, limits: { maxFileMB: 50, maxFiles: 20, maxPages: 500, retentionMinutes: 60 }, features: { accounts: false, billing: false } } } });
      return r.fulfill({ status: 503, json: { ok: false, error: { code: 'prerender', message: 'not available at build time' } } });
    });
    await page.goto(origin + route, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 15_000 });
    await page.waitForFunction(() => !!document.querySelector('link[rel=canonical]'), null, { timeout: 15_000 });
    let html = await page.content();
    await page.close();

    // The build-time origin must never leak into what crawlers see.
    html = html.replaceAll(origin, site || '');
    if (html.includes('127.0.0.1:')) { console.error(`prerender: ${route} still references the local build origin`); failed++; continue; }
    // useSeo builds canonical URLs as SITE_URL + path, so the snapshot must say exactly that.
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    if (site && canonical !== `${site}${route}`) { console.error(`prerender: ${route} has canonical ${canonical}, expected ${site}${route}`); failed++; continue; }
    const out = route === '/' ? join(dist, 'index.html') : join(dist, route, 'index.html');
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, '<!doctype html>' + html.replace(/^<!DOCTYPE html>/i, ''));
    console.log(`prerendered ${route}`);
  }
} finally { await browser.close(); server.close(); }
if (failed) { console.error(`prerender: ${failed} page(s) failed`); process.exit(1); }
console.log(`prerender: ${routes.length} pages written`);
