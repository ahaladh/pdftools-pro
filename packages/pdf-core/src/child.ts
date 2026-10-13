import { ToolError } from './errors.js';
import { processTool } from './processors.js';
import type { ToolId } from '@pdftools/shared';
import type { ProcessContext } from './types.js';

/**
 * Entry point of the isolated job process (spawned by isolated.ts under kernel resource limits).
 * Protocol: parent sends {type:'run', tool, ctx}; we answer with progress/done/error messages.
 */
type RunMsg = { type: 'run'; tool: ToolId; ctx: Omit<ProcessContext, 'signal' | 'onProgress'> } | { type: 'abort' };
const ac = new AbortController();

// If the parent (API/worker) dies, the IPC channel closes: take this whole process group (including any
// engines we started) down with it instead of leaving orphans burning CPU until their timeout.
process.on('disconnect', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } });
const send = (m: unknown) => process.send?.(m);

process.on('message', async (m: RunMsg) => {
  if (m.type === 'abort') return ac.abort();
  try {
    const res = await processTool(m.tool, { ...m.ctx, signal: ac.signal, onProgress: (p) => send({ type: 'progress', p }) });
    send({ type: 'done', res });
  } catch (e) {
    if (e instanceof ToolError) send({ type: 'error', code: e.code, message: e.message, detail: (e as { detail?: string }).detail });
    else send({ type: 'crash', message: e instanceof Error ? e.message : String(e) });
  }
  setImmediate(() => process.exit(0));
});
