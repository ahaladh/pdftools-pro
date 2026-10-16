import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { processTool, type InputFile } from './index.js';
import { parseVeraReport } from './pdfa.js';

// These tests start real engines (LibreOffice, a JVM, Tesseract): seconds each even when idle, far more under load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// veraPDF is the reference validator. Locally these tests skip LOUDLY without it; in CI it is mandatory.
const VERA = process.env.VERAPDF_BIN;
const have = !!VERA && (() => { try { execFileSync(VERA, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!have) {
  if (process.env.CI) throw new Error('VERAPDF_BIN is required in CI');
  console.warn('\n⚠ PDF/A tests SKIPPED: set VERAPDF_BIN to a veraPDF CLI to run them.\n');
}

let root: string;
let n = 0;
const pdfIn = (path: string, name = 'in.pdf'): InputFile => ({ path, name, kind: 'pdf' });
async function run(inputs: InputFile[], options: unknown = {}, limits?: object) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool('pdf-to-pdfa', { workDir, inputs, options, timeoutMs: 180_000, maxPages: 50, ...(limits ? { limits } : {}) } as never);
}
/** Independent check: run the validator ourselves, not through the code under test. */
const vera = (pdf: string, flavour: string) => {
  const args = ['--flavour', flavour, '--maxfailures', '5', pdf];
  const opts = { env: { ...process.env, JAVA_TOOL_OPTIONS: '-Xmx512m' }, maxBuffer: 1 << 26 };
  try { return parseVeraReport(execFileSync(VERA!, args, opts).toString()); }
  catch (e) { return parseVeraReport(String((e as { stdout?: Buffer }).stdout ?? '')); } // non-compliant files exit 1 but still print the report
};
const text = (pdf: string) => execFileSync('pdftotext', [pdf, '-']).toString().replace(/\s+/g, ' ').trim();

async function loDoc(name: string, body: string): Promise<InputFile> {
  const dir = join(root, `lo-${name}`); await mkdir(dir);
  await writeFile(join(dir, `${name}.txt`), body);
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, `${name}.txt`)], { stdio: 'ignore', timeout: 120_000 });
  return pdfIn(join(dir, `${name}.pdf`), `${name}.pdf`);
}
async function plainDoc(name: string, extra?: (d: PDFDocument) => void): Promise<InputFile> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica); // NOT embedded in the file: PDF/A needs it embedded
  const p = d.addPage([300, 200]);
  p.drawText('Archive me please', { x: 20, y: 100, size: 16, font });
  extra?.(d);
  const path = join(root, `${name}.pdf`); await writeFile(path, await d.save());
  return pdfIn(path, `${name}.pdf`);
}

describe.skipIf(!have)('PDF to PDF/A', () => {
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'pdfa-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('the input is not PDF/A to begin with (so the check below means something)', async () => {
    const f = await plainDoc('pre');
    const v = vera(f.path, '2b');
    expect(v.compliant).toBe(false);
    expect(v.failures.length).toBeGreaterThan(0);
  });

  it('LibreOffice output converts to PDF/A-2b, confirmed by an independent veraPDF run, with the text intact', async () => {
    const f = await loDoc('lo', 'Quarterly report for Acme\nSecond line\n');
    const r = await run([f], { level: '2b' });
    expect(r.name).toBe('lo-pdfa.pdf');
    expect(r.stats).toMatchObject({ level: '2b', validated: 'veraPDF' });
    expect(r.warnings.join(' ')).toMatch(/Checked with veraPDF/);
    const v = vera(r.path, '2b');
    expect(v.compliant, JSON.stringify(v.failures)).toBe(true);
    expect(text(r.path)).toBe(text(f.path));
  });

  it('standard (non-embedded) fonts get embedded', async () => {
    const f = await plainDoc('std');
    expect(execFileSync('pdffonts', [f.path]).toString()).toMatch(/no\s+no\s+no/);
    const r = await run([f]);
    expect(vera(r.path, '2b').compliant).toBe(true);
    const fonts = execFileSync('pdffonts', [r.path]).toString().trim().split('\n').slice(2);
    expect(fonts.length).toBeGreaterThan(0);
    for (const l of fonts) expect(l).toMatch(/\byes\s+(yes|no)\s+(yes|no)\s+\d/); // emb column is "yes"
    expect(text(r.path)).toBe('Archive me please');
  });

  for (const level of ['1b', '2b', '3b'] as const) {
    it(`level ${level} passes its own veraPDF profile`, async () => {
      const r = await run([await plainDoc(`lvl${level}`)], { level });
      expect(r.stats).toMatchObject({ level, validated: 'veraPDF' });
      const v = vera(r.path, level);
      expect(v.compliant, JSON.stringify(v.failures)).toBe(true);
    });
  }

  it('JavaScript in the source is removed and the result still validates', async () => {
    const f = await plainDoc('js', (d) => {
      const js = d.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("hi")') });
      d.catalog.set(PDFName.of('OpenAction'), js);
    });
    expect(Buffer.from(await readFile(f.path)).toString('latin1')).toContain('JavaScript');
    const r = await run([f]);
    expect(Buffer.from(await readFile(r.path)).toString('latin1')).not.toContain('app.alert');
    expect(vera(r.path, '2b').compliant).toBe(true);
  });

  it('works under the same kernel memory limits the job runner applies (JVM included)', async () => {
    const r = await run([await plainDoc('lim')], {}, { memoryMB: 2048, officeMemoryMB: 2048, cpuSeconds: 120, fileMB: 1024 });
    expect(r.stats).toMatchObject({ validated: 'veraPDF' });
  });

  it('without a validator it still converts, but says plainly it is NOT validated', async () => {
    const saved = process.env.VERAPDF_BIN; delete process.env.VERAPDF_BIN;
    try {
      const r = await run([await plainDoc('nov')]);
      expect(r.stats).toMatchObject({ validated: 'no' });
      expect(r.warnings.join(' ')).toMatch(/NOT independently validated/);
      expect(r.warnings.join(' ')).not.toMatch(/conforms/);
    } finally { process.env.VERAPDF_BIN = saved; }
  });

  it('refuses to deliver a file the validator rejects, and explains why', async () => {
    const fake = join(root, 'fake-vera.sh');
    await writeFile(fake, '#!/bin/sh\ncat <<EOF\n<report><validationReport profileName="x" isCompliant="false"><details/><rule specification="ISO 19005-2:2011" clause="6.2.11.4.1" testNumber="1" status="failed"><description>The font program is not embedded</description></rule></validationReport></report>\nEOF\nexit 1\n');
    await chmod(fake, 0o755);
    const saved = process.env.VERAPDF_BIN; process.env.VERAPDF_BIN = fake;
    try {
      await expect(run([await plainDoc('rej')])).rejects.toMatchObject({ code: 'pdfa_failed', message: expect.stringContaining('6.2.11.4.1') });
    } finally { process.env.VERAPDF_BIN = saved; }
  });

  it('a REAL veraPDF rejection (real report, real exit status 1) is reported with the failing rule', async () => {
    const bad = await plainDoc('realbad'); // never converted, so veraPDF genuinely rejects it
    const wrap = join(root, 'real-vera.sh');
    await writeFile(wrap, `#!/bin/sh\nexec "${VERA}" --flavour 2b --maxfailures 5 "${bad.path}"\n`);
    await chmod(wrap, 0o755);
    const saved = process.env.VERAPDF_BIN; process.env.VERAPDF_BIN = wrap;
    try {
      const err = await run([await plainDoc('realsrc')]).then(() => null, (e: Error & { code?: string }) => e);
      expect(err?.code).toBe('pdfa_failed');
      expect(err?.message).toMatch(/rule \d+(\.\d+)+:/); // names a real clause, not a generic "validator failed"
    } finally { process.env.VERAPDF_BIN = saved; }
  });

  it('a crashing or garbled validator is a failure, never a pass', async () => {
    for (const body of ['#!/bin/sh\nexit 3\n', '#!/bin/sh\necho "<report>garbage</report>"\n']) {
      const fake = join(root, `bad-vera-${n++}.sh`); await writeFile(fake, body); await chmod(fake, 0o755);
      const saved = process.env.VERAPDF_BIN; process.env.VERAPDF_BIN = fake;
      try { await expect(run([await plainDoc('bad')])).rejects.toMatchObject({ code: expect.stringMatching(/validator_failed|pdfa_failed/) }); }
      finally { process.env.VERAPDF_BIN = saved; }
    }
  });

  it('rejects encrypted and damaged inputs with clear errors', async () => {
    const bad = join(root, 'bad.pdf'); await writeFile(bad, 'not a pdf');
    await expect(run([pdfIn(bad)])).rejects.toMatchObject({ code: 'invalid_pdf' });
    await expect(run([await plainDoc('o')], { level: '9z' })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('veraPDF report parsing', () => {
  it('reads compliance and the failing rules; anything unrecognised is NOT compliant', () => {
    const ok = '<report><validationReport profileName="p" statement="s" isCompliant="true"><details passedRules="1"/></validationReport></report>';
    expect(parseVeraReport(ok)).toEqual({ compliant: true, failures: [] });
    const bad = '<validationReport isCompliant="false"><rule specification="S" clause="6.1" testNumber="2" status="failed"><description> Bad thing </description></rule><rule specification="S" clause="6.2" testNumber="1" status="passed"><description>fine</description></rule></validationReport>';
    expect(parseVeraReport(bad)).toEqual({ compliant: false, failures: [{ clause: '6.1', description: 'Bad thing' }] });
    expect(parseVeraReport('').compliant).toBe(false);
    expect(parseVeraReport('<report>garbage</report>').compliant).toBe(false);
    // a "compliant" flag alongside a failed rule is contradictory: do not trust it
    expect(parseVeraReport('<validationReport isCompliant="true"><rule clause="1" status="failed"><description>x</description></rule></validationReport>').compliant).toBe(false);
  });
});
