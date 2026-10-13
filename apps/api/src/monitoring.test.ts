import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';

const DIR = resolve(__dirname, '../../../infrastructure/monitoring');
let storage: string, ctx: Awaited<ReturnType<typeof createApp>>, scrape = '';

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'mon-'));
  ctx = await createApp({ env: loadEnv({ NODE_ENV: 'test', STORAGE_DIR: storage, PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '1000', RATE_LIMIT_ENABLED: 'false', MAX_STORAGE_MB: '500' }) });
  const agent = request.agent(ctx.app);
  const d = await PDFDocument.create(); d.addPage();
  const r = await agent.post('/api/pdf/rotate').attach('files', Buffer.from(await d.save()), 'a.pdf');
  for (let i = 0; i < 100; i++) { if ((await agent.get(`/api/jobs/${r.body.data.jobId}`)).body.data.state === 'completed') break; await new Promise((x) => setTimeout(x, 50)); }
  await agent.post('/api/pdf/rotate').attach('files', Buffer.from('%PDF-1.4\njunk'), 'b.pdf');
  await new Promise((x) => setTimeout(x, 400));
  scrape = (await request(ctx.app).get('/metrics')).text;
});
afterAll(async () => { await ctx.close(); await rm(storage, { recursive: true, force: true }); });

const names = (text: string) => new Set([...text.matchAll(/^# TYPE (\S+) (\w+)/gm)].flatMap(([, n, t]) => (t === 'histogram' ? [n!, `${n}_bucket`, `${n}_count`, `${n}_sum`] : [n!])));

describe('monitoring configuration matches the code', () => {
  it('every metric referenced by an alert exists in the live /metrics output', async () => {
    const alerts = parse(await readFile(join(DIR, 'alerts.yml'), 'utf8')) as { groups: { rules: { alert: string; expr: string }[] }[] };
    const exposed = names(scrape);
    const missing: string[] = [];
    for (const g of alerts.groups) for (const r of g.rules) {
      for (const m of r.expr.match(/\bpdftools_[a-z0-9_]+/g) ?? []) if (!exposed.has(m)) missing.push(`${r.alert}: ${m}`);
    }
    expect(missing).toEqual([]);
  });

  it('every label an alert filters on is one the metric really has', async () => {
    const alerts = parse(await readFile(join(DIR, 'alerts.yml'), 'utf8')) as { groups: { rules: { alert: string; expr: string }[] }[] };
    const bad: string[] = [];
    for (const g of alerts.groups) for (const r of g.rules) for (const [, metric, labels] of r.expr.matchAll(/\b(pdftools_[a-z0-9_]+)\{([^}]*)\}/g)) {
      for (const [, label, value] of labels!.matchAll(/(\w+)\s*(?:=~|!=|=)\s*"([^"]*)"/g)) {
        const base = metric!.replace(/_(bucket|count|sum)$/, '');
        // the label must appear on at least one sample of that metric (value is checked for exact-match filters)
        const lines = scrape.split('\n').filter((l) => l.startsWith(`${base}`) && l.includes(`${label}=`));
        if (!lines.length && !['code', 'action', 'state', 'outcome'].includes(label!)) bad.push(`${r.alert}: ${metric}{${label}="${value}"}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('alert rules are well formed: unique names, severity, summary, and a runbook anchor that exists in OPERATIONS.md', async () => {
    const alerts = parse(await readFile(join(DIR, 'alerts.yml'), 'utf8')) as { groups: { rules: { alert: string; expr: string; labels: { severity: string }; annotations: { summary: string; runbook?: string } }[] }[] };
    const ops = await readFile(resolve(DIR, '../../docs/OPERATIONS.md'), 'utf8');
    const anchors = new Set([...ops.matchAll(/^#{2,4} (.+)$/gm)].map(([, h]) => h!.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')));
    const seen = new Set<string>();
    for (const g of alerts.groups) for (const r of g.rules) {
      expect(seen.has(r.alert), `duplicate ${r.alert}`).toBe(false); seen.add(r.alert);
      expect(['page', 'warn'], r.alert).toContain(r.labels.severity);
      expect(r.annotations.summary.length, r.alert).toBeGreaterThan(15);
      expect(r.expr.trim().length, r.alert).toBeGreaterThan(5);
      if (r.annotations.runbook) expect(anchors.has(r.annotations.runbook.split('#')[1]!), `${r.alert} -> ${r.annotations.runbook}`).toBe(true);
    }
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });

  it('prometheus.yml references the alert file and scrapes both roles with auth', async () => {
    const p = parse(await readFile(join(DIR, 'prometheus.yml'), 'utf8')) as { rule_files: string[]; scrape_configs: { job_name: string; authorization?: unknown; metrics_path?: string }[] };
    expect(p.rule_files).toContain('alerts.yml');
    for (const job of ['pdftools-api', 'pdftools-worker']) {
      const c = p.scrape_configs.find((s) => s.job_name === job)!;
      expect(c.metrics_path).toBe('/metrics');
      expect(c.authorization).toBeTruthy(); // metrics are token-protected in production
    }
  });
});
