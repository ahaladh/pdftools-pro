import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pino } from 'pino';
import { connectDb, disconnectDb } from './db/models.js';
import { MIGRATIONS, SchemaTooNewError, assertSchemaNotNewer, migrationStatus, runMigrations } from './db/migrations.js';

let mongo: MongoMemoryServer;
const log = pino({ level: 'silent' });
const db = () => mongoose.connection.db!;

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await connectDb(mongo.getUri('mig')); });
afterAll(async () => { await disconnectDb(); await mongo.stop(); });
beforeEach(async () => { await db().dropDatabase(); });

describe('database migrations', () => {
  it('applies every pending migration once, in order, and is idempotent', async () => {
    expect((await migrationStatus()).pending).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await runMigrations(log)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await runMigrations(log)).toEqual([]);
    expect(await migrationStatus()).toEqual({ applied: MIGRATIONS.map((m) => m.id), pending: [], unknown: [] });
    const indexes = (await db().collection('users').indexes()).map((i) => i.name);
    expect(indexes).toContain('email_1');
    expect((await db().collection('migrations').findOne({ _id: '0001-indexes' as never }))!.appliedAt).toBeInstanceOf(Date);
    expect(await db().collection('migrations').findOne({ _id: '__lock__' as never })).toBeNull(); // lock released
  });

  it('two processes starting at once apply each migration exactly once (cross-process lock)', async () => {
    const ran: string[] = [];
    const list = MIGRATIONS.map((m) => ({ ...m, up: async () => { ran.push(m.id); await new Promise((r) => setTimeout(r, 120)); await m.up(); } }));
    const [a, b] = await Promise.all([runMigrations(log, list), runMigrations(log, list)]);
    expect([...a, ...b].sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    expect(ran.sort()).toEqual(MIGRATIONS.map((m) => m.id).sort()); // no migration body ran twice
  });

  it('refuses to run older code against a newer database', async () => {
    await runMigrations(log);
    await db().collection('migrations').insertOne({ _id: '9999-from-the-future' as never, appliedAt: new Date() });
    await expect(assertSchemaNotNewer()).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(runMigrations(log)).rejects.toThrow(/9999-from-the-future/);
    expect((await migrationStatus()).unknown).toEqual(['9999-from-the-future']);
  });

  it('a failing migration is not recorded, leaves later ones pending, and releases the lock for the retry', async () => {
    let fail = true;
    const list = [MIGRATIONS[0]!, { id: '0100-flaky', description: 'x', up: async () => { if (fail) throw new Error('boom'); } }, { id: '0101-after', description: 'y', up: async () => undefined }];
    await expect(runMigrations(log, list)).rejects.toThrow('boom');
    expect((await migrationStatus(list)).applied).toEqual(['0001-indexes']);
    expect((await migrationStatus(list)).pending).toEqual(['0100-flaky', '0101-after']);
    fail = false;
    expect(await runMigrations(log, list)).toEqual(['0100-flaky', '0101-after']);
  });

  it('normalizes emails, but aborts WITHOUT changing anything if that would create duplicates', async () => {
    const users = db().collection('users');
    await users.insertMany([{ email: '  Alice@Example.COM ' }, { email: 'bob@example.com' }] as never);
    await runMigrations(log, MIGRATIONS.slice(0, 2));
    expect((await users.find().toArray()).map((u) => u.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);

    await db().dropDatabase();
    await users.insertMany([{ email: 'Dup@example.com' }, { email: 'dup@example.com' }] as never);
    await expect(runMigrations(log, MIGRATIONS.slice(0, 2))).rejects.toThrow(/differ only by case/);
    expect((await users.find().toArray()).map((u) => u.email).sort()).toEqual(['Dup@example.com', 'dup@example.com']); // untouched
    expect((await migrationStatus(MIGRATIONS.slice(0, 2))).pending).toEqual(['0002-normalize-emails']);
  });

  it('scrubs passwords that linger in historical job records and leaves other options alone', async () => {
    await db().collection('jobs').insertOne({ id: 'j1', options: { password: 'hunter2', ownerPassword: 'x', angle: 90 } } as never);
    await runMigrations(log);
    const j = await db().collection('jobs').findOne({ id: 'j1' });
    expect(j!.options).toEqual({ angle: 90 });
  });
});
