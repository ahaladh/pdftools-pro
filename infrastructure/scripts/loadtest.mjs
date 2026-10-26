#!/usr/bin/env node
// Load test: N concurrent anonymous users each repeat "merge two PDFs -> wait for the result -> download -> delete" for a while,
// with a light stream of read-only requests alongside.  No dependencies, Node >= 20.
//
//   node loadtest.mjs http://localhost:4000 --users 20 --seconds 60
//   node loadtest.mjs https://staging.example.com --users 10 --seconds 120 --json
//
// It reports latency percentiles per stage, throughput and every error by kind, and exits 1 if the error rate is above --max-error-rate
// (default 1%) or the p95 end-to-end time is above --max-p95-ms (default 20000).
// RUN IT ONLY AGAINST A SYSTEM YOU OWN: every user is a real upload and a real job.  The server must allow the traffic: raise
// DAILY_OPS_GUEST and MAX_CONCURRENT_JOBS_PER_USER and turn RATE_LIMIT_ENABLED off for a capacity test, or leave them on to see
// what real visitors would hit (429s are counted separately from failures).  Numbers describe THAT machine, not production.
const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a))?.replace(/\/$/, '');
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : dflt; };
if (!base) { console.error('usage: loadtest.mjs <base-url> [--users 20] [--seconds 60] [--pages 3] [--max-error-rate 0.01] [--max-p95-ms 20000] [--json]'); process.exit(2); }
if (args.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const USERS = opt('users', 20), SECONDS = opt('seconds', 60), PAGES = opt('pages', 3);
const MAX_ERR = opt('max-error-rate', 0.01), MAX_P95 = opt('max-p95-ms', 20_000);

function pdf(pages) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', `<</Type/Pages/Kids[${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}]/Count ${pages}>>`];
  for (let i = 0; i < pages; i++) objs.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>');
  let body = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const A = pdf(PAGES), B = pdf(PAGES);

const lat = { submit: [], total: [], download: [], read: [] };
const errors = new Map(); let rateLimited = 0, completed = 0, attempts = 0;
const bump = (k) => errors.set(k, (errors.get(k) ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]); };

/** One user: its own cookie jar, so the server sees distinct guests (the IP is shared, as in a test from one machine). */
function session() {
  const jar = new Map();
  return async (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
}

const deadline = Date.now() + SECONDS * 1000;
async function user(n) {
  const http = session();
  await sleep((n * 1000) / Math.max(USERS, 1)); // spread the start over a second, not a thundering herd
  while (Date.now() < deadline) {
    attempts++;
    const t0 = performance.now();
    try {
      const form = new FormData();
      form.append('options', '{}');
      form.append('files', new Blob([A], { type: 'application/pdf' }), 'a.pdf');
      form.append('files', new Blob([B], { type: 'application/pdf' }), 'b.pdf');
      const sub = await http('/api/pdf/merge', { method: 'POST', body: form });
      lat.submit.push(performance.now() - t0);
      if (sub.status === 429) { rateLimited++; await sleep(500); continue; }
      if (sub.status !== 202) { bump(`submit ${sub.status}`); await sub.arrayBuffer(); await sleep(250); continue; }
      const id = (await sub.json()).data.jobId;
      let job;
      for (let i = 0; ; i++) {
        const r = await http(`/api/jobs/${id}`);
        if (r.status !== 200) { bump(`poll ${r.status}`); await r.arrayBuffer(); job = null; break; }
        job = (await r.json()).data;
        if (['completed', 'failed', 'cancelled'].includes(job.state)) break;
        if (performance.now() - t0 > 120_000) { bump('timeout (>120 s)'); job = null; break; }
        await sleep(Math.min(100 + i * 50, 500));
      }
      if (!job) continue;
      if (job.state !== 'completed') { bump(`job ${job.state}`); continue; }
      const d0 = performance.now();
      const dl = await http(job.result.downloadUrl); const buf = Buffer.from(await dl.arrayBuffer());
      lat.download.push(performance.now() - d0);
      if (dl.status !== 200 || buf.subarray(0, 5).toString() !== '%PDF-') { bump(`download ${dl.status}`); continue; }
      lat.total.push(performance.now() - t0); completed++;
      const r0 = performance.now(); const c = await http('/api/config'); await c.arrayBuffer();
      if (c.status === 200) lat.read.push(performance.now() - r0); else bump(`config ${c.status}`);
      await (await http(`/api/files/${job.result.fileId}`, { method: 'DELETE' })).arrayBuffer();
    } catch (e) { bump(`${e.name}: ${String(e.message).slice(0, 60)}`); await sleep(250); }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
const wall = (Date.now() - started) / 1000;
const failed = [...errors.values()].reduce((a, b) => a + b, 0);
const summary = {
  base, users: USERS, seconds: Math.round(wall), pages: PAGES, attempts, completed, rateLimited, failed,
  errorRate: attempts ? +(failed / attempts).toFixed(4) : 0, jobsPerSecond: +(completed / wall).toFixed(2),
  errors: Object.fromEntries(errors),
  latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: pct(v, 100) }])),
};
const p95 = summary.latencyMs.total.p95;
const ok = attempts > 0 && completed > 0 && summary.errorRate <= MAX_ERR && p95 !== null && p95 <= MAX_P95;
if (args.includes('--json')) console.log(JSON.stringify({ ok, ...summary }, null, 2));
else {
  console.log(`${USERS} users for ${summary.seconds}s against ${base}: ${completed}/${attempts} jobs completed (${summary.jobsPerSecond}/s), ${rateLimited} rate-limited, ${failed} failed (${(summary.errorRate * 100).toFixed(2)}%)`);
  for (const [k, v] of Object.entries(summary.latencyMs)) console.log(`  ${k.padEnd(9)} n=${String(v.n).padEnd(6)} p50=${v.p50}ms  p95=${v.p95}ms  p99=${v.p99}ms  max=${v.max}ms`);
  if (errors.size) console.log('  errors:', JSON.stringify(summary.errors));
  console.log(ok ? 'PASS' : `FAIL (error rate limit ${MAX_ERR * 100}%, p95 limit ${MAX_P95} ms)`);
}
process.exit(ok ? 0 : 1);
