import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolId } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { limitArgs } from './exec.js';
import { processTool } from './processors.js';
import type { ProcessContext, ProcessResult } from './types.js';

export interface IsolationOptions {
  /**
   * Address-space cap for the whole job process, enforced by the kernel (RLIMIT_AS). Unlike a V8 heap
   * limit this also covers Buffers/typed arrays, which is where PDF and image decoders allocate.
   * Node needs roughly 1.5 GB of address space just to start, and engine caps must not exceed this
   * value (a child cannot raise a limit its parent was given), so the minimum is clamped.
   */
  memoryMB?: number;
  /** CPU-time budget for the whole job process. */
  cpuSeconds?: number;
  /** Largest file the job may write. */
  fileMB?: number;
  /** Extra wall-clock time beyond ctx.timeoutMs for non-engine phases before the process group is killed. */
  graceMs?: number;
}

export const MIN_ISOLATION_MB = 1536;
const CHILD_FILE = fileURLToPath(new URL('./child.js', import.meta.url));
const PRLIMIT = '/usr/bin/prlimit';

/** True when the compiled child entry exists (it does not when running TypeScript sources directly). */
export const isolationAvailable = () => existsSync(CHILD_FILE);
const prlimitAvailable = () => { try { accessSync(PRLIMIT, constants.X_OK); return true; } catch { return false; } };

/**
 * Run a tool in a separate process (own process group) under kernel limits. A hostile document can
 * at worst exhaust that one process's quota: the API never holds the decoded data, its event loop is
 * never blocked, and cancellation/timeouts kill the whole group including any engines it started.
 */
export function processToolIsolated(tool: ToolId, ctx: ProcessContext, iso: IsolationOptions = {}): Promise<ProcessResult> {
  if (!isolationAvailable()) return processTool(tool, ctx); // dev/test against TS sources only
  const { signal, onProgress, ...data } = ctx;
  const memoryMB = Math.max(MIN_ISOLATION_MB, iso.memoryMB ?? 4096);
  const lim = limitArgs({ memoryMB, cpuSeconds: iso.cpuSeconds, fileMB: iso.fileMB });
  if (!prlimitAvailable()) return Promise.reject(new ToolError('tool_unavailable', 'Process isolation requires prlimit (util-linux) on the server'));

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(PRLIMIT, [...lim, '--', process.execPath, '--max-old-space-size=1024', CHILD_FILE], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: true, // own process group so we can kill engines too
      cwd: ctx.workDir,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ctx.workDir, LANG: 'C.UTF-8' },
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    let settled = false, killedByUs = false;
    const killGroup = () => { killedByUs = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(hard); signal?.removeEventListener('abort', onAbort); killGroup(); fn(); };
    const hard = setTimeout(() => finish(() => reject(new ToolError('timeout', 'Processing took too long and was stopped'))), ctx.timeoutMs + (iso.graceMs ?? 15_000));
    const onAbort = () => {
      child.send({ type: 'abort' }, () => undefined); // lets the job kill its engine cleanly
      setTimeout(() => finish(() => reject(new ToolError('cancelled', 'Job was cancelled'))), 1500).unref();
    };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort);

    child.on('message', (m: { type: string; p?: number; res?: ProcessResult; code?: string; message?: string; detail?: string }) => {
      if (m.type === 'progress') return void onProgress?.(m.p!);
      if (m.type === 'done') return finish(() => resolve(m.res!));
      if (m.type === 'error') {
        const e = new ToolError(m.code!, m.message!);
        (e as Error & { detail?: string }).detail = m.detail;
        return finish(() => reject(e));
      }
      finish(() => reject(new Error(m.message ?? 'job process crashed')));
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code, sig) => {
      if (settled) return;
      // Killed by the kernel (CPU limit / OOM) or died allocating beyond RLIMIT_AS.
      const oom = /allocation failed|out of memory|ENOMEM|Cannot allocate/i.test(stderr);
      if (oom || (sig === 'SIGKILL' && !killedByUs) || sig === 'SIGXCPU' || sig === 'SIGXFSZ') {
        return finish(() => reject(new ToolError('resource_limit', 'This document needs more resources than are allowed.')));
      }
      finish(() => reject(new Error(`job process exited unexpectedly (${sig ?? code}): ${stderr.slice(-300)}`)));
    });
    child.send({ type: 'run', tool, ctx: data });
  });
}
