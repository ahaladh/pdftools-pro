import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb } from './db/models.js';
import { twoFactorKeys } from './modules/auth/keyring.js';
import { inspectTwoFactorKeys, rotateTwoFactorKeys, type KeyReport } from './ops/rotate-two-factor.js';

const USAGE = `usage: rotate-2fa.js status | run [--dry-run]

Re-seals stored authenticator secrets under the current key (TWO_FACTOR_KEY, or JWT_ACCESS_SECRET if that is unset).
Earlier keys go in TWO_FACTOR_KEY_PREVIOUS (comma-separated) for as long as anything is still sealed with them.

  status           read-only report of which key each secret is under (exit 1 while anything is not on the current key)
  run --dry-run    show what would change, change nothing
  run              re-seal; safe on a live system, safe to repeat or interrupt (exit 1 if anything could not be opened)

Rotation: 1) set the new key as TWO_FACTOR_KEY and the old one in TWO_FACTOR_KEY_PREVIOUS, deploy;
          2) run this; 3) 'status' shows everything on 'current'; 4) remove TWO_FACTOR_KEY_PREVIOUS, redeploy.`;

function print(r: KeyReport, keys: number) {
  console.log(`keys configured: 1 current + ${keys - 1} previous`);
  console.log(`authenticator secrets: ${r.secrets}`);
  for (const [k, n] of Object.entries(r.byKey).sort()) console.log(`  sealed with ${k.padEnd(10)} ${n}`);
  console.log(`  format v2 (key id): ${r.byFormat.v2}, v1 (legacy): ${r.byFormat.v1}`);
  console.log(`  already on the current key: ${r.onCurrent}; need re-sealing: ${r.needsRotation}`);
  if (r.undecryptable.length) {
    console.log(`  CANNOT BE OPENED with any configured key: ${r.undecryptable.length} (left untouched). Add the key that sealed them to TWO_FACTOR_KEY_PREVIOUS,`);
    console.log('  or, if it is gone, an administrator must reset those users\' two-step sign-in (they will then set it up again). User ids:');
    for (const u of r.undecryptable.slice(0, 50)) console.log(`    ${u.userId}  (${u.field})`);
    if (r.undecryptable.length > 50) console.log(`    … and ${r.undecryptable.length - 50} more`);
  }
}

async function main(argv: string[]) {
  const [cmd, ...flags] = argv;
  if (cmd !== 'status' && cmd !== 'run') { console.error(USAGE); return 2; }
  let env;
  try { env = loadEnv(); } catch (e) { console.error(`FATAL: ${(e as Error).message}`); return 2; }
  if (!env.MONGODB_URI) { console.error('MONGODB_URI is not set: there are no accounts to rotate.'); return 2; }
  const keys = twoFactorKeys(env);
  if (!keys[0]) { console.error('No key: set TWO_FACTOR_KEY (or JWT_ACCESS_SECRET).'); return 2; }
  await connectDb(env.MONGODB_URI);
  try {
    if (cmd === 'status') {
      const r = await inspectTwoFactorKeys(keys);
      print(r, keys.length);
      return r.needsRotation || r.undecryptable.length ? 1 : 0;
    }
    const dryRun = flags.includes('--dry-run');
    const r = await rotateTwoFactorKeys(keys, { dryRun });
    print(r, keys.length);
    if (dryRun) { console.log(`\ndry run: ${r.needsRotation} would be re-sealed, nothing was changed`); return r.undecryptable.length ? 1 : 0; }
    console.log(`\nre-sealed: ${r.rotated}${r.raced ? `; changed by someone else meanwhile (run again): ${r.raced}` : ''}`);
    return r.undecryptable.length || r.raced ? 1 : 0;
  } finally { await disconnectDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
