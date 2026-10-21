import { UsageModel } from '../../db/models.js';

export const today = () => new Date().toISOString().slice(0, 10);

export interface UsageStore {
  increment(keys: string[], tool: string, day?: string): Promise<void>;
  ops(key: string, day?: string): Promise<number>;
  /** Per-day op counts for one owner key, newest last. */
  series(key: string, days: number): Promise<{ day: string; ops: number }[]>;
  deleteKey(key: string): Promise<void>;
  /** Today's (or `day`'s) counts for every key beginning with `prefix`. */
  opsByPrefix(prefix: string, day?: string): Promise<Record<string, number>>;
  /** Remove a person's share of any team pool, and everything a team's pool recorded (account or team deletion). */
  deleteMemberUsage(userId: string): Promise<void>;
  deleteTeamUsage(teamId: string): Promise<void>;
}

const HEX24 = /^[a-f0-9]{24}$/;

const dayList = (days: number) => Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10));

export class MemoryUsageStore implements UsageStore {
  private m = new Map<string, number>();
  async increment(keys: string[], _tool: string, day = today()) { for (const k of keys) this.m.set(`${k}|${day}`, (this.m.get(`${k}|${day}`) ?? 0) + 1); }
  async ops(key: string, day = today()) { return this.m.get(`${key}|${day}`) ?? 0; }
  async series(key: string, days: number) { return dayList(days).map((day) => ({ day, ops: this.m.get(`${key}|${day}`) ?? 0 })); }
  async deleteKey(key: string) { for (const k of [...this.m.keys()]) if (k.startsWith(`${key}|`)) this.m.delete(k); }
  async opsByPrefix(prefix: string, day = today()) { const out: Record<string, number> = {}; for (const [k, v] of this.m) { const [key, d] = k.split('|'); if (d === day && key!.startsWith(prefix)) out[key!] = v; } return out; }
  async deleteMemberUsage(userId: string) { if (!HEX24.test(userId)) return; for (const k of [...this.m.keys()]) if (new RegExp(`^tm:[a-f0-9]{24}:${userId}\\|`).test(k)) this.m.delete(k); }
  async deleteTeamUsage(teamId: string) { for (const k of [...this.m.keys()]) if (k.startsWith(`t:${teamId}|`) || k.startsWith(`tm:${teamId}:`)) this.m.delete(k); }
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
  async opsByPrefix(prefix: string, day = today()) {
    const rows = await UsageModel.find({ key: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, day }).lean();
    return Object.fromEntries(rows.map((r) => [r.key as string, r.ops as number]));
  }
  async deleteMemberUsage(userId: string) { if (HEX24.test(userId)) await UsageModel.deleteMany({ key: { $regex: `^tm:[a-f0-9]{24}:${userId}$` } }); }
  async deleteTeamUsage(teamId: string) { if (HEX24.test(teamId)) await UsageModel.deleteMany({ $or: [{ key: `t:${teamId}` }, { key: { $regex: `^tm:${teamId}:` } }] }); }
}
