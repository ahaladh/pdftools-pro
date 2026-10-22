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

/**
 * Drop nulls and undefined, recursively. The schema has no nullable fields, but a value that was `undefined` when saved (an
 * optional price id with no env var) comes back from MongoDB as `null`, which would fail validation and silently discard the
 * administrator's whole settings document.
 */
export function withoutNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withoutNulls) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, withoutNulls(x)])) as T;
  return v;
}

/**
 * A settings document stored before a plan field existed has no value for it. Take the deployment's default for that plan
 * (rather than the schema's neutral one) so an upgrade does not silently switch a feature off for everyone.
 */
export function withNewFieldDefaults(stored: unknown, defaults: AppSettings): unknown {
  const s = stored as { plans?: Record<string, Record<string, unknown>> } | null;
  if (!s || typeof s !== 'object' || !s.plans || typeof s.plans !== 'object') return stored;
  const plans = Object.fromEntries(Object.entries(s.plans).map(([id, p]) => [id, p && typeof p === 'object' && p.batchFiles === undefined && id in defaults.plans ? { ...p, batchFiles: defaults.plans[id as keyof AppSettings['plans']].batchFiles } : p]));
  return { ...s, plans };
}

/** Runtime-configurable settings with a short cache. Stored values are re-validated on load. */
export class SettingsService {
  private cache: { at: number; value: AppSettings } | null = null;
  constructor(private store: SettingsStore, private defaults: AppSettings, private ttlMs = 3000, private log?: { warn: (o: object, msg: string) => void }) {}

  async get(): Promise<AppSettings> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    let value = this.defaults;
    const stored = await this.store.load();
    if (stored) {
      const parsed = appSettingsSchema.safeParse(withoutNulls(withNewFieldDefaults(stored, this.defaults)));
      if (parsed.success) value = parsed.data;
      // A corrupt document falls back to defaults rather than breaking requests, but never silently: the administrator's changes are being ignored.
      else this.log?.warn({ issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }, 'stored settings are invalid: using defaults, so saved changes are NOT in effect');
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async plan(id: PlanId): Promise<PlanConfig> { return (await this.get()).plans[id]!; }

  async update(next: AppSettings): Promise<AppSettings> {
    const value = withoutNulls(appSettingsSchema.parse(next));
    await this.store.save(value);
    this.cache = { at: Date.now(), value };
    return value;
  }
}
