import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { JobRunner } from './modules/jobs/runner.js';
import { MemoryJobStore, type JobRecord } from './modules/jobs/types.js';
import { MemoryUsageStore } from './modules/usage/store.js';

const exists = (p: string) => access(p).then(() => true, () => false);

/** Records what was true at the moment the final outcome is published. */
class SpyStore extends MemoryJobStore {
  atFinal: { stillRunning: boolean; workGone: boolean; inGone: boolean } | undefined;
  constructor(private probe: () => Promise<NonNullable<SpyStore['atFinal']>>) { super(); }
  override async transition(id: string, from: Parameters<MemoryJobStore['transition']>[1], patch: Partial<JobRecord>) {
    if (patch.state === 'completed') this.atFinal = await this.probe();
    return super.transition(id, from, patch);
  }
}

describe('JobRunner and graceful shutdown', () => {
  it('stays "running" until its scratch files are deleted and its outcome is published', async () => {
    // Graceful shutdown waits for running jobs to leave this set. If the entry were dropped earlier, a SIGTERM
    // arriving during cleanup would let the process exit with scratch files left and the job still "processing".
    const root = await mkdtemp(join(tmpdir(), 'runner-'));
    const dir = join(root, 'job1');
    await mkdir(join(dir, 'in'), { recursive: true });
    const d = await PDFDocument.create(); d.addPage([100, 100]);
    const input = join(dir, 'in', 'a.pdf');
    await writeFile(input, await d.save());

    const env = loadEnv({ NODE_ENV: 'test', STORAGE_DIR: root, ISOLATE_JOBS: 'false' });
    let runner!: JobRunner;
    const store = new SpyStore(async () => ({
      stillRunning: runner.runningSnapshot().some((j) => j.id === 'job1'),
      workGone: !(await exists(join(dir, 'work'))),
      inGone: !(await exists(join(dir, 'in'))),
    }));
    runner = new JobRunner(env, store, new MemoryUsageStore(), pino({ level: 'silent' }));
    await store.create({
      id: 'job1', owner: 'g:x', tool: 'rotate', state: 'queued', progress: 0, options: { angle: 90, pages: 'all' },
      inputs: [{ path: input, name: 'a.pdf', kind: 'pdf' }], dir, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      warnings: [], plan: 'free', priority: 0, limits: { maxPages: 10 }, usageKeys: [],
    });
    await runner.process('job1');
    expect((await store.get('job1'))?.state).toBe('completed');
    expect(store.atFinal).toEqual({ stillRunning: true, workGone: true, inGone: true });
    expect(runner.activeCount).toBe(0); // and it is released afterwards
  });
});
