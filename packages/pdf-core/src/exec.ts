import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { ToolError } from './errors.js';

export interface EngineLimits {
  /** Address-space cap for the engine process (RLIMIT_AS). */
  memoryMB?: number;
  /** CPU-time cap in seconds (RLIMIT_CPU); the kernel kills the process beyond it. */
  cpuSeconds?: number;
  /** Largest file the engine may write (RLIMIT_FSIZE). Stops runaway output filling the disk. */
  fileMB?: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  limits?: EngineLimits;
}

const PRLIMIT = '/usr/bin/prlimit';
let prlimitOk: boolean | undefined;
const hasPrlimit = () => (prlimitOk ??= (() => { try { accessSync(PRLIMIT, constants.X_OK); return true; } catch { return false; } })());

/** Build the argv for prlimit; exported for tests. */
export function limitArgs(l: EngineLimits): string[] {
  const a: string[] = [];
  if (l.memoryMB) a.push(`--as=${Math.floor(l.memoryMB * 1024 * 1024)}`);
  if (l.cpuSeconds) a.push(`--cpu=${Math.ceil(l.cpuSeconds)}`);
  if (l.fileMB) a.push(`--fsize=${Math.floor(l.fileMB * 1024 * 1024)}`);
  return a;
}

/**
 * Run an external utility with no shell, a minimal environment, an isolated working directory,
 * a hard timeout, cancellation support and (when `limits` is given) kernel resource limits.
 * Never interpolates user input into a shell string.
 */
export function run(bin: string, args: string[], opts: RunOptions): Promise<void> {
  let file = bin, argv = args;
  const lim = opts.limits ? limitArgs(opts.limits) : [];
  if (lim.length) {
    // Refuse to run unconfined rather than silently dropping a configured safeguard.
    if (!hasPrlimit()) return Promise.reject(new ToolError('tool_unavailable', 'Resource limits are configured but prlimit is not installed on the server'));
    file = PRLIMIT; argv = [...lim, '--', bin, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      argv,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: opts.cwd, LANG: 'C.UTF-8' },
        signal: opts.signal,
      },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        if (opts.signal?.aborted) return reject(new ToolError('cancelled', 'Job was cancelled'));
        const e0 = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e0.killed && e0.signal === 'SIGKILL') return reject(new ToolError('timeout', 'Processing took too long and was stopped'));
        // SIGKILL we did not send = the kernel enforcing RLIMIT_CPU (or the OOM killer); SIGXFSZ = output size cap.
        if (e0.signal === 'SIGKILL' || e0.signal === 'SIGXCPU' || e0.signal === 'SIGXFSZ') return reject(new ToolError('resource_limit', 'This file needs more resources than are allowed.'));
        if (e0.code === 'ENOENT') {
          return reject(new ToolError('tool_unavailable', `Required utility "${bin}" is not installed on the server`));
        }
        // Do not leak stderr (may contain paths) to users; keep it for server logs.
        const e = new ToolError('engine_failed', 'The PDF engine could not process this file. It may be damaged or unsupported.');
        (e as Error & { detail?: string }).detail = String(stderr).slice(0, 500);
        reject(e);
      },
    );
    child.stdin?.end();
  });
}
