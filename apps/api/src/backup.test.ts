import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDb, disconnectDb, JobModel, SettingModel, UserModel } from './db/models.js';

const run = promisify(execFile);
const SCRIPTS = resolve(__dirname, '../../../infrastructure/scripts');
const TOOLS = process.env.MONGO_TOOLS_DIR ?? join(homedir(), '.cache/pdftools/mongo-tools');
const haveTools = existsSync(join(TOOLS, 'mongodump')) || existsSync('/usr/bin/mongodump');
if (!haveTools && process.env.CI) throw new Error('mongodb-database-tools are required in CI (set MONGO_TOOLS_DIR)');
if (!haveTools) console.warn('\n⚠ backup/restore drill SKIPPED: mongodump not found. Set MONGO_TOOLS_DIR to a directory containing mongodump/mongorestore.\n');

let mongo: MongoMemoryServer, dir: string, uri: string;
const sh = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
  run('bash', [join(SCRIPTS, script), ...args], { env: { PATH: `${TOOLS}:${process.env.PATH}`, HOME: process.env.HOME!, MONGODB_URI: uri, BACKUP_DIR: dir, ...env }, timeout: 120_000 });
const fail = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected the script to fail'); }, (e: { code: number; stderr: string }) => e);

describe.skipIf(!haveTools)('backup and restore drill (real mongodump/mongorestore)', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    uri = mongo.getUri('pdftools');
    dir = await mkdtemp(join(tmpdir(), 'bk-'));
    await connectDb(uri);
  }, 120_000);
  afterAll(async () => { await disconnectDb(); await mongo.stop(); await rm(dir, { recursive: true, force: true }); });

  const seed = async () => {
    await UserModel.create({ email: 'alice@example.com', name: 'Alice', passwordHash: 'scrypt$x', plan: 'pro', role: 'admin' });
    await UserModel.create({ email: 'bob@example.com', name: 'Bob', passwordHash: 'scrypt$y' });
    await SettingModel.create({ _id: 'app', value: { maintenance: false, marker: 'before-backup' } });
    await JobModel.create({ id: 'j'.repeat(32), owner: 'u:1', tool: 'merge', state: 'completed', createdAt: Date.now(), expiresAt: Date.now() + 1e6 });
  };

  it('creates a compressed, checksummed archive, keeps credentials off the command line, and is safe to run twice', async () => {
    await seed();
    const { stdout } = await sh('backup.sh');
    expect(stdout).toMatch(/backup ok: .*pdftools-\d{8}T\d{6}Z\.archive\.gz/);
    const files = await readdir(dir);
    const archive = files.find((f) => f.endsWith('.archive.gz'))!;
    expect(files).toContain(`${archive}.sha256`);
    expect((await readFile(join(dir, archive))).subarray(0, 2).toString('hex')).toBe('1f8b'); // gzip
    expect((await readFile(join(dir, `${archive}.sha256`), 'utf8'))).toMatch(/^[a-f0-9]{64}  pdftools-/);
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);
    // the URI (with credentials) is never in a process argument list: mongodump got a config file descriptor instead
    const src = await readFile(join(SCRIPTS, 'backup.sh'), 'utf8');
    expect(src).toContain('--config <(');
    expect(src).not.toMatch(/--uri[= ]/);
    await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp
    await sh('backup.sh');
    expect((await readdir(dir)).filter((f) => f.endsWith('.archive.gz'))).toHaveLength(2);
  }, 120_000);

  it('refuses to start while another backup holds the lock', async () => {
    const holder = run('bash', ['-c', `exec 9>"${dir}/.backup.lock"; flock -n 9; sleep 4`]);
    await new Promise((r) => setTimeout(r, 600));
    const e = await fail(sh('backup.sh'));
    expect(e.code).toBe(3);
    expect(e.stderr).toMatch(/already running/);
    await holder;
  });

  it('prunes archives older than the retention window but never the newest', async () => {
    const old = join(dir, 'pdftools-20200101T000000Z.archive.gz');
    await writeFile(old, 'x'); await writeFile(`${old}.sha256`, 'x');
    const ancient = new Date('2020-01-01');
    await utimes(old, ancient, ancient);
    const { stdout } = await sh('backup.sh', [], { RETENTION_DAYS: '7' });
    expect(stdout).toContain('pruned pdftools-20200101T000000Z.archive.gz');
    const files = await readdir(dir);
    expect(files).not.toContain('pdftools-20200101T000000Z.archive.gz');
    expect(files).not.toContain('pdftools-20200101T000000Z.archive.gz.sha256');
    expect(files.filter((f) => f.endsWith('.archive.gz')).length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('rejects bad configuration clearly', async () => {
    expect((await fail(sh('backup.sh', [], { RETENTION_DAYS: 'abc' }))).code).toBe(2);
    expect((await fail(run('bash', [join(SCRIPTS, 'backup.sh')], { env: { PATH: `${TOOLS}:${process.env.PATH}`, BACKUP_DIR: dir } }))).code).toBeGreaterThan(0); // no MONGODB_URI
    expect((await fail(sh('restore.sh', ['/nonexistent.gz']))).code).toBe(2);
  });

  it('RESTORE DRILL: after the database is destroyed, the backup brings every document back intact', async () => {
    const archive = (await readdir(dir)).filter((f) => f.endsWith('.archive.gz')).sort().pop()!;
    const a = join(dir, archive);
    await mongoose.connection.db!.dropDatabase();
    expect(await UserModel.countDocuments()).toBe(0); // disaster
    const { stdout } = await sh('restore.sh', [a]);
    expect(stdout).toContain('checksum ok');
    expect(stdout).toContain('restore ok');
    expect(await UserModel.countDocuments()).toBe(2);
    const alice = await UserModel.findOne({ email: 'alice@example.com' });
    expect(alice).toMatchObject({ name: 'Alice', plan: 'pro', role: 'admin', passwordHash: 'scrypt$x' });
    expect((await SettingModel.findById('app'))!.value.marker).toBe('before-backup');
    expect(await JobModel.countDocuments({ id: 'j'.repeat(32) })).toBe(1);
    const idx = (await UserModel.collection.indexes()).find((i) => i.name === 'email_1');
    expect(idx?.unique).toBe(true); // unique email constraint restored with the data
  }, 120_000);

  it('refuses to overlay a populated database unless --drop is given, and --drop really replaces it', async () => {
    const a = join(dir, (await readdir(dir)).filter((f) => f.endsWith('.archive.gz')).sort().pop()!);
    const e = await fail(sh('restore.sh', [a]));
    expect(e.code).toBe(1);
    expect(e.stderr).toMatch(/already contains data/);
    await UserModel.create({ email: 'carol@example.com', name: 'Carol', passwordHash: 'z' }); // a change made after the backup
    await sh('restore.sh', [a, '--drop']);
    expect(await UserModel.countDocuments()).toBe(2);
    expect(await UserModel.findOne({ email: 'carol@example.com' })).toBeNull(); // replaced by the backup's state
  }, 120_000);

  it('detects a corrupted archive via its checksum and refuses to restore it', async () => {
    const a = join(dir, (await readdir(dir)).filter((f) => f.endsWith('.archive.gz')).sort().pop()!);
    const original = await readFile(a);
    await writeFile(a, Buffer.concat([original, Buffer.from('tampered')]));
    const e = await fail(sh('restore.sh', [a, '--drop']));
    expect(e.stderr).toMatch(/CHECKSUM MISMATCH/);
    expect(await UserModel.countDocuments()).toBe(2); // nothing was touched
    await writeFile(a, original);
  });

  it('--scratch verifies a backup in a throwaway database without touching production', async () => {
    const a = join(dir, (await readdir(dir)).filter((f) => f.endsWith('.archive.gz')).sort().pop()!);
    await UserModel.create({ email: 'dave@example.com', name: 'Dave', passwordHash: 'q' }); // live data newer than the backup
    const { stdout } = await sh('restore.sh', [a, '--scratch', 'pdftools_drill']);
    expect(stdout).toContain('scratch database');
    const scratch = mongoose.connection.useDb('pdftools_drill');
    expect(await scratch.collection('users').countDocuments()).toBe(2);
    expect(await UserModel.countDocuments()).toBe(3); // production untouched, still has Dave
    await scratch.dropDatabase();
    expect((await fail(sh('restore.sh', [a, '--scratch', 'bad name; rm -rf /']))).code).toBe(2);
  }, 120_000);
});
void chmod;
