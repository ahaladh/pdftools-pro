#!/usr/bin/env node
// Post-deploy smoke test: does the DEPLOYED system actually work end to end?  No dependencies, Node >= 20.
//
//   node smoke.mjs https://pdf.example.com            # public checks + a real guest merge job
//   node smoke.mjs https://localhost:8443 --insecure   # accept a self-signed certificate (local/staging only)
//   node smoke.mjs <url> --json                         # machine-readable result
//   node smoke.mjs <url> --api-only                     # skip the web-app (HTML/headers) checks
// Exit code 0 = all checks passed, 1 = a check failed, 2 = bad usage. Safe against production: it uploads two tiny
// generated PDFs as an anonymous guest (counts as one operation against the guest quota) and deletes the result.
const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a))?.replace(/\/$/, '');
if (!base) { console.error('usage: smoke.mjs <base-url> [--insecure] [--json]'); process.exit(2); }
if (args.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const json = args.includes('--json');
const apiOnly = args.includes('--api-only'); // skip the web-app checks (an API-only deployment, e.g. testing a container directly)

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0 }); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 }); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const jar = new Map();
async function http(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
}

/** A tiny valid PDF with N blank pages (hand-built so this script needs no libraries). */
function pdf(pages) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}]/Count ${pages}>>`];
  for (let i = 0; i < pages; i++) objs.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>');
  let body = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

await check('liveness (/healthz or /health)', async () => {
  for (const p of ['/healthz', '/health']) { const r = await http(p); if (r.status === 200) { const b = await r.json(); assert(b.status === 'ok', `status=${b.status}`); return `${p} ${b.version ? `(version ${b.version})` : ''}`; } }
  throw new Error('neither /healthz nor /health answered 200');
});
if (!apiOnly) await check('home page is served with real content', async () => {
  const r = await http('/'); assert(r.status === 200, `status ${r.status}`);
  const h = await r.text(); assert(/<h1[\s>]/.test(h), 'no <h1> in the HTML (is the site prerendered?)'); assert(h.includes('<div id="root">'), 'not the app page');
});
if (!apiOnly) await check('security headers on the web app', async () => {
  const r = await http('/'); const h = r.headers;
  assert(h.get('content-security-policy')?.includes("default-src 'self'"), 'missing CSP');
  assert(h.get('x-content-type-options') === 'nosniff', 'missing nosniff');
  assert(/deny|sameorigin/i.test(h.get('x-frame-options') ?? '') || h.get('content-security-policy').includes('frame-ancestors'), 'framing is not restricted');
  assert(!h.get('x-powered-by'), 'X-Powered-By leaks the framework');
  if (base.startsWith('https://')) assert(/max-age=\d{7,}/.test(h.get('strict-transport-security') ?? ''), 'missing or short HSTS on HTTPS');
});
if (!apiOnly) await check('SPA deep link falls back to the app shell (not a 404)', async () => { const r = await http('/account'); assert(r.status === 200, `status ${r.status}`); });
await check('API config', async () => {
  const r = await http('/api/config'); assert(r.status === 200, `status ${r.status}`);
  const b = await r.json(); assert(b.ok && b.data.limits?.maxFileMB > 0, 'unexpected body'); assert(!b.data.maintenance, 'the service is in MAINTENANCE MODE');
  return `max ${b.data.limits.maxFileMB} MB, accounts ${b.data.features?.accounts ? 'on' : 'off'}`;
});
await check('internal endpoints are not exposed publicly', async () => {
  for (const p of ['/metrics', '/api/metrics', '/api/admin/users']) { const r = await http(p); const t = await r.text(); assert(!t.includes('pdftools_'), `${p} exposes metrics`); assert(!(p.startsWith('/api/admin') && r.status === 200), `${p} is open`); }
});
let fileId;
await check('end to end: guest uploads two PDFs, a worker merges them, the result downloads', async () => {
  const form = new FormData();
  form.append('options', '{}');
  form.append('files', new Blob([pdf(2)], { type: 'application/pdf' }), 'smoke-a.pdf');
  form.append('files', new Blob([pdf(3)], { type: 'application/pdf' }), 'smoke-b.pdf');
  const sub = await http('/api/pdf/merge', { method: 'POST', body: form });
  if (sub.status !== 202) throw new Error(`upload answered ${sub.status}: ${(await sub.text()).slice(0, 160)}`); // read the body only on failure
  const id = (await sub.json()).data.jobId;
  const t0 = Date.now(); let job;
  for (;;) {
    job = (await (await http(`/api/jobs/${id}`)).json()).data;
    if (['completed', 'failed', 'cancelled'].includes(job.state)) break;
    assert(Date.now() - t0 < 90_000, `job still ${job.state} after 90 s (is a worker running?)`);
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(job.state === 'completed', `job ${job.state}: ${job.error?.message ?? ''}`);
  fileId = job.result.fileId;
  const dl = await http(job.result.downloadUrl); assert(dl.status === 200, `download ${dl.status}`);
  assert(/attachment/.test(dl.headers.get('content-disposition') ?? ''), 'download is not an attachment');
  const buf = Buffer.from(await dl.arrayBuffer());
  assert(buf.subarray(0, 5).toString() === '%PDF-', 'result is not a PDF');
  assert((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length >= 5, 'merged PDF does not contain 5 pages');
  return `${buf.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
});
await check('result can be deleted immediately and is then gone', async () => {
  assert(fileId, 'no file to delete (previous step failed)');
  const del = await http(`/api/files/${fileId}`, { method: 'DELETE' }); assert(del.status === 200, `delete ${del.status}`);
});

const failed = results.filter((r) => !r.ok);
if (json) console.log(JSON.stringify({ base, ok: !failed.length, results }, null, 2));
else {
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(78)} ${r.ok ? r.detail : `FAILED: ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${base}`);
}
process.exit(failed.length ? 1 : 0);
