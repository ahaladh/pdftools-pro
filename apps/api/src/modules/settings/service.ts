import { appSettingsSchema, type AppSettings, type PlanConfig, type PlanId } from '@pdftools/shared';
import { SettingModel } from '../../db/models.js';

export interface SettingsStore {
  load(): Promise<unknown | null>;
  save(value: AppSettings): Promise<void>;
}

export class MemorySettingsStore implements SettingsStore {
  private v: AppSettings | null = null;
  async load() { return this.v; }
  async save(v: AppSettings) { this.v = v; }
}

export class MongoSettingsStore implements SettingsStore {
  async load() { const doc = (await SettingModel.findById('app').lean()) as { value?: unknown } | null;
    return doc?.value ?? null; }
  async save(v: AppSettings) { await SettingModel.findByIdAndUpdate('app', { value: v }, { upsert: true }); }
}

/** Runtime-configurable settings with a short cache. Stored values are re-validated on load. */
export class SettingsService {
  private cache: { at: number; value: AppSettings } | null = null;
  constructor(private store: SettingsStore, private defaults: AppSettings, private ttlMs = 3000) {}

  async get(): Promise<AppSettings> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    let value = this.defaults;
    const stored = await this.store.load();
    if (stored) {
      const parsed = appSettingsSchema.safeParse(stored);
      if (parsed.success) value = parsed.data; // a corrupt document falls back to defaults rather than breaking requests
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async plan(id: PlanId): Promise<PlanConfig> { return (await this.get()).plans[id]!; }

  async update(next: AppSettings): Promise<AppSettings> {
    const value = appSettingsSchema.parse(next);
    await this.store.save(value);
    this.cache = { at: Date.now(), value };
    return value;
  }
}
