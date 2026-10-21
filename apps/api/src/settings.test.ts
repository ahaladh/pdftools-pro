import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb, SettingModel } from './db/models.js';
import { MongoSettingsStore, SettingsService, withoutNulls } from './modules/settings/service.js';
import { defaultSettings } from './modules/settings/defaults.js';

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await connectDb(mongo.getUri('pdftools')); }, 120_000);
afterAll(async () => { await disconnectDb(); await mongo?.stop(); });

// No Stripe price ids in the environment: pro/business get `stripePriceId: undefined`, which MongoDB hands back as null.
const defaults = () => defaultSettings(loadEnv({ NODE_ENV: 'test' }));
/** A service with no cache, so every get() reads the store: this is what other instances (and the next cache refresh) see. */
const fresh = (log?: { warn: (o: object, m: string) => void }) => new SettingsService(new MongoSettingsStore(), defaults(), 0, log);

describe('saved settings survive a reload from MongoDB', () => {
  it('an administrator\'s changes are still in effect after the cache expires, even with no Stripe price ids configured', async () => {
    const writer = new SettingsService(new MongoSettingsStore(), defaults(), 3000);
    const s = await writer.get();
    await writer.update({ ...s, maintenance: true, disabledTools: ['merge'], plans: { ...s.plans, pro: { ...s.plans.pro, dailyOps: 3 } } });
    // and what is stored no longer contains nulls at all (the load side tolerates old documents, but new ones should be clean)
    const raw = JSON.stringify(((await SettingModel.findById('app').lean()) as { value: unknown }).value);
    expect(raw).not.toContain(':null');
    const reader = await fresh().get(); // what a reload, another instance or the next cache refresh sees
    expect(reader.maintenance).toBe(true);
    expect(reader.disabledTools).toEqual(['merge']);
    expect(reader.plans.pro.dailyOps).toBe(3);
    expect(Object.values(reader.plans).every((p) => p.stripePriceId === undefined || typeof p.stripePriceId === 'string')).toBe(true);
  });

  it('a document already stored with nulls (as earlier versions wrote it) loads with its changes intact', async () => {
    const s = defaults();
    await SettingModel.findByIdAndUpdate('app', { value: { ...s, maintenance: true, plans: { ...s.plans, pro: { ...s.plans.pro, dailyOps: 7, stripePriceId: null }, business: { ...s.plans.business, stripePriceId: null } } } }, { upsert: true });
    const warn = vi.fn();
    const got = await fresh({ warn }).get();
    expect(got.maintenance).toBe(true); expect(got.plans.pro.dailyOps).toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a document that is really invalid falls back to defaults, and says so', async () => {
    await SettingModel.findByIdAndUpdate('app', { value: { plans: 'nope' } }, { upsert: true });
    const warn = vi.fn();
    expect((await fresh({ warn }).get()).plans.pro.name).toBe('Pro');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toMatch(/NOT in effect/);
  });

  it('withoutNulls removes null and undefined everywhere, and nothing else', () => {
    expect(withoutNulls({ a: 1, b: null, c: undefined, d: [1, null, { e: null, f: 0 }], g: { h: false, i: '' } })).toEqual({ a: 1, d: [1, null, { f: 0 }], g: { h: false, i: '' } });
  });
});
