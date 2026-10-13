import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { runDoctor } from './ops/doctor.js';

/**
 * Preflight: `node dist/doctor.js [--deep] [--json]`. Exit code 0 = safe to start, 1 = at least one failure.
 * Run it after every config change and as a deploy gate. --deep also converts a document under the real limits.
 */
async function main(argv: string[]) {
  let env;
  try { env = loadEnv(); } catch (e) { console.error(`✖ configuration is invalid: ${(e as Error).message}`); return 1; }
  const { ok, checks } = await runDoctor(env, { deep: argv.includes('--deep') });
  if (argv.includes('--json')) console.log(JSON.stringify({ ok, checks }, null, 2));
  else {
    const icon = { pass: '✔', warn: '⚠', fail: '✖' } as const;
    for (const c of checks) console.log(`${icon[c.level]} ${c.name.padEnd(48)} ${c.detail}`);
    const n = (l: string) => checks.filter((c) => c.level === l).length;
    console.log(`\n${n('pass')} passed, ${n('warn')} warning(s), ${n('fail')} failure(s)`);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
