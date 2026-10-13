import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Total size in bytes of everything under `dir` (missing dir = 0). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}
