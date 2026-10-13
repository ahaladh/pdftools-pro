import { UsageModel } from '../../db/models.js';

export const today = () => new Date().toISOString().slice(0, 10);

export interface UsageStore {
  increment(keys: string[], tool: string, day?: string): Promise<void>;
  ops(key: string, day?: string): Promise<number>;
  /** Per-day op counts for one owner key, newest last. */
  series(key: string, days: number): Promise<{ day: string; ops: number }[]>;
  deleteKey(key: string): Promise<void>;
}

const dayList = (days: number) => Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10));

export class MemoryUsageStore implements UsageStore {
  private m = new Map<string, number>();
  async increment(keys: string[], _tool: string, day = today()) { for (const k of keys) this.m.set(`${k}|${day}`, (this.m.get(`${k}|${day}`) ?? 0) + 1); }
  async ops(key: string, day = today()) { return this.m.get(`${key}|${day}`) ?? 0; }
  async series(key: string, days: number) { return dayList(days).map((day) => ({ day, ops: this.m.get(`${key}|${day}`) ?? 0 })); }
  async deleteKey(key: string) { for (const k of [...this.m.keys()]) if (k.startsWith(`${key}|`)) this.m.delete(k); }
}

export class MongoUsageStore implements UsageStore {
  async increment(keys: string[], tool: string, day = today()) {
    const safeTool = tool.replace(/[^a-z0-9-]/gi, '_');
    await Promise.all(keys.map((key) => UsageModel.updateOne({ key, day }, { $inc: { ops: 1, [`byTool.${safeTool}`]: 1 } }, { upsert: true })));
  }
  async ops(key: string, day = today()) { const doc = (await UsageModel.findOne({ key, day }).lean()) as { ops?: number } | null;
    return doc?.ops ?? 0; }
  async series(key: string, days: number) {
    const list = dayList(days);
    const rows = await UsageModel.find({ key, day: { $in: list } }).lean();
    const map = new Map(rows.map((r) => [r.day, r.ops as number]));
    return list.map((day) => ({ day, ops: map.get(day) ?? 0 }));
  }
  async deleteKey(key: string) { await UsageModel.deleteMany({ key }); }
}
