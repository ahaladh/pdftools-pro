import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { isBatchable, type ToolId } from '@pdftools/shared';
import { ToolError } from './errors.js';
import type { ProcessContext, ProcessResult } from './types.js';
import type { Processor } from './helpers.js';

const MAX_LISTED = 20;

/** Add " (2)", " (3)"… before the extension until the name is unused in the archive. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!used.has(c)) { used.add(c); return c; } }
}

/**
 * Apply one single-file tool to every input in turn and return a ZIP of the results plus a report. One job, one process, so the
 * isolation, memory and time limits the job already runs under still apply. Each result is streamed into the archive and deleted
 * as soon as it is added, so memory and disk stay flat however many files there are. A file that fails (corrupt, too many pages,
 * wrong password…) is reported and the rest carry on; only if every file fails is the job a failure. Per-file deadlines stop one
 * file from using the whole batch's time; files not reached before the batch deadline are reported as not processed.
 */
export async function processBatch(tool: ToolId, ctx: ProcessContext, run: Processor): Promise<ProcessResult> {
  if (!isBatchable(tool)) throw new ToolError('invalid_input', 'This tool cannot process files in a batch.');
  if (ctx.inputs.length === 0) throw new ToolError('no_input', 'No input file');
  const overall = ctx.deadline ?? Date.now() + ctx.timeoutMs;
  const perFile = ctx.fileTimeoutMs ?? ctx.timeoutMs;
  const zipPath = join(ctx.workDir, 'batch.zip');
  const out = await open(zipPath, 'w');
  let queue: Promise<unknown> = Promise.resolve();
  let zipError: unknown;
  const zip = new Zip((err, chunk) => { if (err) zipError = err; else queue = queue.then(() => out.write(chunk)); });
  const add = async (name: string, path: string) => {
    const e = new ZipPassThrough(name); // results are already compressed (PDF, Office, images): store, do not recompress
    zip.add(e);
    for await (const chunk of createReadStream(path)) { e.push(chunk as Uint8Array, false); await queue; } // waiting on the write queue is the backpressure
    e.push(new Uint8Array(0), true);
    await queue;
  };
  const addText = async (name: string, text: string) => { const e = new ZipPassThrough(name); zip.add(e); e.push(new TextEncoder().encode(text), true); await queue; };

  const used = new Set<string>(['batch-report.txt']);
  const lines: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  let ok = 0;
  const total = ctx.inputs.length;
  try {
    for (const [i, input] of ctx.inputs.entries()) {
      if (ctx.signal?.aborted) throw new ToolError('cancelled', 'Job was cancelled');
      if (Date.now() >= overall) {
        for (const rest of ctx.inputs.slice(i)) { lines.push(`NOT PROCESSED  ${rest.name}: the time limit for the batch was reached`); failures.push(`${rest.name}: not processed, the time limit for the batch was reached`); }
        break;
      }
      const dir = join(ctx.workDir, `b${i}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const res = await run({ ...ctx, batch: false, inputs: [input], workDir: dir, deadline: Math.min(overall, Date.now() + perFile), onProgress: undefined });
        if (ctx.signal?.aborted) throw new ToolError('cancelled', 'Job was cancelled');
        const name = uniqueName(res.name, used);
        await add(name, res.path);
        ok++;
        lines.push(`OK  ${input.name} -> ${name}`);
        for (const w of res.warnings) if (warnings.length < MAX_LISTED) warnings.push(`${input.name}: ${w}`);
      } catch (e) {
        if (e instanceof ToolError && e.code === 'cancelled') throw e;
        const why = e instanceof ToolError ? e.message : 'could not be processed';
        lines.push(`FAILED  ${input.name}: ${why}`);
        failures.push(`${input.name}: ${why}`);
      } finally { await rm(dir, { recursive: true, force: true }); }
      ctx.onProgress?.(Math.round(5 + (90 * (i + 1)) / total));
    }
    if (ok === 0) throw new ToolError('batch_failed', `None of the ${total} file${total === 1 ? '' : 's'} could be processed. ${failures[0] ?? ''}`.trim());
    await addText('batch-report.txt', `Batch: ${tool}\nFiles: ${total}, processed: ${ok}, failed: ${total - ok}\n\n${lines.join('\n')}\n`);
    zip.end();
    await queue;
    if (zipError) throw new ToolError('engine_failed', 'The result archive could not be written.');
  } finally { await out.close().catch(() => undefined); }
  const shown = failures.slice(0, MAX_LISTED);
  return {
    path: zipPath, name: `batch-${tool}-${ok}-file${ok === 1 ? '' : 's'}.zip`, mime: 'application/zip',
    warnings: [...(failures.length ? [`${failures.length} of ${total} files could not be processed (see batch-report.txt in the archive): ${shown.join('; ')}${failures.length > shown.length ? '; …' : ''}`] : []), ...warnings],
    stats: { files: total, processed: ok, failed: total - ok },
  };
}
