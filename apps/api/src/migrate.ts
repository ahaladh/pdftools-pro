import { pathToFileURL } from 'node:url';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb } from './db/models.js';
import { MIGRATIONS, migrationStatus, runMigrations } from './db/migrations.js';

/** CLI: `node dist/migrate.js status` | `node dist/migrate.js up`. Run `up` as a deploy step before starting new code. */
async function main(cmd = 'status') {
  let env;
  try { env = loadEnv(); } catch (e) { console.error(`FATAL: ${(e as Error).message}`); return 2; }
  if (!env.MONGODB_URI) { console.error('MONGODB_URI is not set: nothing to migrate (guest-only mode).'); return 2; }
  const log = pino({ level: env.LOG_LEVEL });
  await connectDb(env.MONGODB_URI);
  try {
    if (cmd === 'up') {
      const done = await runMigrations(log);
      console.log(done.length ? `applied: ${done.join(', ')}` : 'already up to date');
      return 0;
    }
    if (cmd === 'status') {
      const s = await migrationStatus();
      for (const m of MIGRATIONS) console.log(`${s.applied.includes(m.id) ? '[x]' : '[ ]'} ${m.id}  ${m.description}`);
      for (const u of s.unknown) console.log(`[!] ${u}  (unknown to this version: database is newer than the code)`);
      return s.pending.length || s.unknown.length ? 1 : 0;
    }
    console.error('usage: migrate.js [status|up]');
    return 2;
  } finally { await disconnectDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv[2]));
