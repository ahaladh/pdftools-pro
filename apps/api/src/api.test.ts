import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';

let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;

async function pdf(pages = 2) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([300, 300]);
  return Buffer.from(await d.save());
}

const mkEnv = (over: Record<string, string> = {}) =>
  loadEnv({ NODE_ENV: 'test', STORAGE_DIR: storage, MAX_FILE_MB: '1', MAX_FILES: '3', MAX_PAGES: '10', RETENTION_MINUTES: '1', PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '100000', RATE_LIMIT_ENABLED: 'false', ...over });

async function waitDone(agent: ReturnType<typeof request.agent>, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await agent.get(`/api/jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'api-'));
  ctx = await createApp({ env: mkEnv() });
});
afterAll(async () => { await rm(storage, { recursive: true, force: true }); });

describe('health & config', () => {
  it('serves health and public config', async () => {
    expect((await request(ctx.app).get('/health')).body.status).toBe('ok');
    const cfg = await request(ctx.app).get('/api/config');
    expect(cfg.body.data.limits.maxFileMB).toBe(1);
  });
  it('sets secure headers and no x-powered-by', async () => {
    const r = await request(ctx.app).get('/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('returns the JSON error envelope for unknown routes', async () => {
    const r = await request(ctx.app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('job lifecycle', () => {
  it('merges two PDFs end to end and the download is a valid PDF', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/merge').attach('files', await pdf(2), 'a.pdf').attach('files', await pdf(3), 'b.pdf');
    expect(sub.status).toBe(202);
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    const dl = await agent.get(job.result.downloadUrl).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect((await PDFDocument.load(dl.body)).getPageCount()).toBe(5);
  });

  it('compress reports sizes', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/compress').field('options', JSON.stringify({ preset: 'maximum-compression' })).attach('files', await pdf(2), 'a.pdf');
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    expect(job.stats.originalBytes).toBeGreaterThan(0);
  });

  it('reports processing failures on the job (malformed PDF)', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/rotate').attach('files', Buffer.from('%PDF-1.4\ngarbage'), 'x.pdf');
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('failed');
    expect(job.error.code).toBe('invalid_pdf');
  });

  it('deletes uploaded inputs once processing ends', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/rotate').attach('files', await pdf(1), 'x.pdf');
    await waitDone(agent, sub.body.data.jobId);
    const dir = await readdir(join(ctx.jobs.root, sub.body.data.jobId));
    expect(dir).not.toContain('in');
    expect(dir).not.toContain('work');
  });
});

describe('validation', () => {
  it('rejects a non-PDF disguised with a .pdf name and PDF mime', async () => {
    const r = await request(ctx.app).post('/api/pdf/rotate').attach('files', Buffer.from('MZ\x90\x00 definitely an exe'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(415);
  });
  it('rejects empty files', async () => {
    const r = await request(ctx.app).post('/api/pdf/rotate').attach('files', Buffer.alloc(0), 'empty.pdf');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('empty_file');
  });
  it('rejects oversize uploads with 413', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1.2 * 1024 * 1024)]);
    const r = await request(ctx.app).post('/api/pdf/rotate').attach('files', big, 'big.pdf');
    expect(r.status).toBe(413);
  });
  it('rejects too many files', async () => {
    let req = request(ctx.app).post('/api/pdf/merge');
    for (let i = 0; i < 4; i++) req = req.attach('files', await pdf(1), `f${i}.pdf`);
    expect((await req).status).toBe(400);
  });
  it('requires enough files and a single file for single-file tools', async () => {
    expect((await request(ctx.app).post('/api/pdf/merge').attach('files', await pdf(1), 'a.pdf')).status).toBe(400);
    const two = await request(ctx.app).post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf').attach('files', await pdf(1), 'b.pdf');
    expect(two.status).toBe(400);
  });
  it('rejects images for PDF-only tools and unknown tools', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
    expect((await request(ctx.app).post('/api/pdf/rotate').attach('files', png, 'a.png')).status).toBe(415);
    expect((await request(ctx.app).post('/api/pdf/hack').attach('files', await pdf(1), 'a.pdf')).status).toBe(404);
  });
  it('returns 501 for planned tools, never fake success', async () => {
    const r = await request(ctx.app).post('/api/pdf/ocr').attach('files', await pdf(1), 'a.pdf');
    expect(r.status).toBe(501);
  });
  it('validates options server-side', async () => {
    const r = await request(ctx.app).post('/api/pdf/rotate').field('options', JSON.stringify({ angle: 45 })).attach('files', await pdf(1), 'a.pdf');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_options');
  });
  it('neutralises path traversal in filenames', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/split').field('options', '{"mode":"each"}').attach('files', await pdf(2), '../../../etc/passwd.pdf');
    expect(sub.status).toBe(202);
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    expect(job.result.name).not.toContain('..');
    expect(job.result.name).not.toContain('/');
  });
});

describe('authorization', () => {
  it("hides other users' jobs and blocks their downloads", async () => {
    const alice = request.agent(ctx.app), mallory = request.agent(ctx.app);
    const sub = await alice.post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(alice, sub.body.data.jobId);
    expect((await mallory.get(`/api/jobs/${job.id}`)).status).toBe(404);
    expect((await mallory.post(`/api/jobs/${job.id}/cancel`)).status).toBe(404);
    // Even with a valid signed link, a different identity cannot download.
    expect((await mallory.get(job.result.downloadUrl)).status).toBe(404);
    expect((await mallory.delete(`/api/files/${job.result.fileId}`)).status).toBe(404);
    expect((await alice.get(job.result.downloadUrl)).status).toBe(200);
  });
  it('rejects missing, tampered and expired download tokens', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(a, sub.body.data.jobId);
    const base = `/api/files/${job.result.fileId}/download`;
    expect((await a.get(base)).status).toBe(403);
    expect((await a.get(`${base}?token=1.abc`)).status).toBe(403);
    const expired = createExpired(ctx.env.DOWNLOAD_SECRET, job.result.fileId);
    expect((await a.get(`${base}?token=${expired}`)).status).toBe(403);
    expect((await a.get('/api/files/not-an-id/download?token=x')).status).toBe(403);
  });
  it('lets the owner delete a result immediately', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(a, sub.body.data.jobId);
    expect((await a.delete(`/api/files/${job.result.fileId}`)).status).toBe(200);
    expect((await a.get(job.result.downloadUrl)).status).toBe(404);
    expect((await a.get(`/api/jobs/${job.id}`)).body.data.state).toBe('expired');
  });
});

import { createHmac } from 'node:crypto';
function createExpired(secret: string, fileId: string) {
  const exp = Math.floor(Date.now() / 1000) - 10;
  return `${exp}.${createHmac('sha256', secret).update(`${fileId}.${exp}`).digest('base64url')}`;
}

describe('retention & limits', () => {
  it('sweeps expired jobs and removes their files from disk', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(a, sub.body.data.jobId);
    expect(await readdir(ctx.jobs.root)).toContain(job.id);
    const swept = await ctx.jobs.sweep(Date.now() + 2 * 60_000);
    expect(swept).toBeGreaterThan(0);
    expect(await readdir(ctx.jobs.root)).not.toContain(job.id);
    expect((await a.get(`/api/jobs/${job.id}`)).body.data.state).toBe('expired');
  });
  it('removes the upload directory when validation fails', async () => {
    const before = (await readdir(ctx.jobs.root)).length;
    await request(ctx.app).post('/api/pdf/rotate').attach('files', Buffer.from('nope nope'), 'x.pdf');
    expect((await readdir(ctx.jobs.root)).length).toBe(before);
  });
  it('enforces per-user concurrent job limits', async () => {
    const { app } = await createApp({ env: mkEnv({ STORAGE_DIR: join(storage, 'c'), MAX_CONCURRENT_JOBS_PER_USER: '1', WORKER_CONCURRENCY: '1' }) });
    const a = request.agent(app);
    const big = await pdf(8);
    const first = await a.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ dpi: 200, format: 'png' })).attach('files', big, 'a.pdf');
    const second = await a.post('/api/pdf/rotate').attach('files', big, 'a.pdf');
    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
  });
  it('cancels a queued/running job', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ dpi: 300, format: 'png' })).attach('files', await pdf(10), 'a.pdf');
    const c = await a.post(`/api/jobs/${sub.body.data.jobId}/cancel`);
    expect(c.status).toBe(200);
    const job = await waitDone(a, sub.body.data.jobId);
    expect(['cancelled', 'completed']).toContain(job.state); // may finish before cancel lands
  });
  it('maintenance mode blocks processing', async () => {
    const { app } = await createApp({ env: mkEnv({ STORAGE_DIR: join(storage, 'm'), MAINTENANCE_MODE: 'true' }) });
    expect((await request(app).post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf')).status).toBe(503);
  });
});

describe('phase 5 tools via API', () => {
  const docx = async () => {
    const { zipSync, strToU8 } = await import('fflate');
    return Buffer.from(zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'),
    }));
  };
  it('converts DOCX to PDF, detecting Office by structure', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/office-to-pdf').attach('files', await docx(), 'memo.docx');
    expect(sub.status).toBe(202);
    const job = await waitDone(a, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    expect(job.result.name).toBe('memo.pdf');
  });
  it('rejects a ZIP renamed to .docx and an exe renamed to .docx', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zip = Buffer.from(zipSync({ 'a.txt': strToU8('hi') }));
    expect((await request(ctx.app).post('/api/pdf/office-to-pdf').attach('files', zip, 'x.docx')).status).toBe(415);
    expect((await request(ctx.app).post('/api/pdf/office-to-pdf').attach('files', Buffer.from('MZ....'), 'x.docx')).status).toBe(415);
    expect((await request(ctx.app).post('/api/pdf/office-to-pdf').attach('files', await pdf(1), 'x.pdf')).status).toBe(415);
  });
  it('protect then unlock round-trips and passwords are scrubbed from job records', async () => {
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/protect').field('options', JSON.stringify({ password: 's3cret-pw' })).attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(a, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    expect(JSON.stringify((await ctx.jobs.store.get(job.id))?.options)).not.toContain('s3cret-pw');
    const dl = await a.get(job.result.downloadUrl).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const bad = await a.post('/api/pdf/unlock').field('options', JSON.stringify({ password: 'nope', confirmAuthorized: true })).attach('files', dl.body, 'e.pdf');
    expect((await waitDone(a, bad.body.data.jobId)).error.code).toBe('wrong_password');
    const good = await a.post('/api/pdf/unlock').field('options', JSON.stringify({ password: 's3cret-pw', confirmAuthorized: true })).attach('files', dl.body, 'e.pdf');
    expect((await waitDone(a, good.body.data.jobId)).state).toBe('completed');
    const noConfirm = await a.post('/api/pdf/unlock').field('options', JSON.stringify({ password: 's3cret-pw' })).attach('files', dl.body, 'e.pdf');
    expect(noConfirm.status).toBe(400);
  });
});

describe('editor tools via API', () => {
  it('edit: places an annotation and an uploaded image; first file must be a PDF', async () => {
    const a = request.agent(ctx.app);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const opts = { annotations: [
      { type: 'text', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.1, text: 'Hi', fontSize: 14, color: '#000000', font: 'helvetica' },
      { type: 'image', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.2, imageIndex: 0, opacity: 1 },
    ] };
    const ok = await a.post('/api/pdf/edit').field('options', JSON.stringify(opts)).attach('files', await pdf(1), 'a.pdf').attach('files', png, 'sig.png');
    expect(ok.status).toBe(202);
    expect((await waitDone(a, ok.body.data.jobId)).state).toBe('completed');
    const swapped = await a.post('/api/pdf/edit').field('options', JSON.stringify(opts)).attach('files', png, 'sig.png').attach('files', await pdf(1), 'a.pdf');
    expect((await waitDone(a, swapped.body.data.jobId)).error.code).toBe('invalid_input');
  });
  it('edit: accepts a large freehand payload (>64KB of options)', async () => {
    const a = request.agent(ctx.app);
    const points = Array.from({ length: 4000 }, (_, i) => [(i % 100) / 100, ((i * 7) % 100) / 100]);
    const sub = await a.post('/api/pdf/edit').field('options', JSON.stringify({ annotations: Array.from({ length: 3 }, () => ({ type: 'draw', page: 0, points, color: '#ff0000', strokeWidth: 1, opacity: 1 })) })).attach('files', await pdf(1), 'a.pdf');
    expect(sub.status).toBe(202);
    expect((await waitDone(a, sub.body.data.jobId)).state).toBe('completed');
  });
  it('edit: rejects malformed annotations at the API boundary', async () => {
    const r = await request(ctx.app).post('/api/pdf/edit').field('options', JSON.stringify({ annotations: [{ type: 'rect', page: 0, x: 9 }] })).attach('files', await pdf(1), 'a.pdf');
    expect(r.status).toBe(400);
  });
  it('redact: burns content and the download no longer contains the text', async () => {
    const { PDFDocument: P, StandardFonts: S } = await import('@cantoo/pdf-lib');
    const d = await P.create(); const f = await d.embedFont(S.Helvetica);
    d.addPage([300, 200]).drawText('TOPSECRET-API-XYZ', { x: 20, y: 120, size: 16, font: f });
    const a = request.agent(ctx.app);
    const sub = await a.post('/api/pdf/redact').field('options', JSON.stringify({ redactions: [{ page: 0, x: 0, y: 0.2, w: 1, h: 0.3 }], dpi: 100 })).attach('files', Buffer.from(await d.save()), 'a.pdf');
    const job = await waitDone(a, sub.body.data.jobId);
    expect(job.state).toBe('completed');
    const dl = await a.get(job.result.downloadUrl).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.body.toString('latin1')).not.toContain('TOPSECRET');
    expect(job.warnings.join()).toMatch(/no longer selectable/);
  });
});
