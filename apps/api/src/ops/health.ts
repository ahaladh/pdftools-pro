import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Check { name: string; run: () => Promise<void> }
export interface CheckResult { ok: boolean; checks: Record<string, 'ok' | string> }

/** Run dependency checks in parallel, each with its own timeout. Messages are generic: this endpoint is unauthenticated. */
export async function runChecks(checks: Check[], timeoutMs = 2000): Promise<CheckResult> {
  const out: Record<string, 'ok' | string> = {};
  await Promise.all(checks.map(async (c) => {
    let t: NodeJS.Timeout;
    try {
      await Promise.race([c.run(), new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), timeoutMs); })]);
      out[c.name] = 'ok';
    } catch (e) { out[c.name] = (e as Error).message === 'timeout' ? 'timeout' : 'failed'; }
    finally { clearTimeout(t!); }
  }));
  return { ok: Object.values(out).every((v) => v === 'ok'), checks: out };
}

/** The storage directory must accept writes (a full or read-only disk makes every upload fail). */
export const storageCheck = (root: string): Check => ({
  name: 'storage',
  run: async () => {
    await mkdir(root, { recursive: true });
    const f = join(root, `.ready-${process.pid}`);
    await writeFile(f, 'ok');
    await rm(f, { force: true });
  },
});
