import type { AppSettings, PlanConfig } from '@pdftools/shared';
import type { Env } from '../../config/env.js';

/** Built from env so deployments (and tests) control baseline limits; admins override at runtime. */
export function defaultSettings(env: Env): AppSettings {
  const premium = env.PREMIUM_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  const base: Pick<PlanConfig, 'maxFileMB' | 'maxPages' | 'maxFiles' | 'batchFiles' | 'maxConcurrentJobs' | 'retentionMinutes'> = {
    maxFileMB: env.MAX_FILE_MB, maxPages: env.MAX_PAGES, maxFiles: env.MAX_FILES, batchFiles: 0,
    maxConcurrentJobs: env.MAX_CONCURRENT_JOBS_PER_USER, retentionMinutes: env.RETENTION_MINUTES,
  };
  const plans: AppSettings['plans'] = {
    guest: { id: 'guest', name: 'Guest', ...base, dailyOps: env.DAILY_OPS_GUEST, priority: 0, blockedTools: premium, priceCents: 0, currency: 'usd',
      features: ['No account needed', 'Basic tools'] },
    free: { id: 'free', name: 'Free', ...base, retentionMinutes: Math.max(base.retentionMinutes, 120), dailyOps: env.DAILY_OPS_FREE, priority: 0, blockedTools: premium, priceCents: 0, currency: 'usd',
      features: ['Job history', 'Higher daily limit', 'Basic tools'] },
    pro: { id: 'pro', name: 'Pro', maxFileMB: 200, maxPages: 2000, maxFiles: 50, batchFiles: env.BATCH_FILES_PRO, dailyOps: 1000, maxConcurrentJobs: 5, retentionMinutes: 24 * 60, priority: 10, blockedTools: [], priceCents: 900, currency: 'usd', stripePriceId: env.STRIPE_PRICE_PRO,
      features: ['Larger files', '1,000 operations/day', 'Premium tools (Office conversion, redaction, compare)', 'Priority processing', `Batch processing (up to ${env.BATCH_FILES_PRO} files at once)`, `Team plan (up to ${env.TEAM_SEATS_PRO} people)`] },
    business: { id: 'business', name: 'Business', maxFileMB: 500, maxPages: 5000, maxFiles: 100, batchFiles: env.BATCH_FILES_BUSINESS, dailyOps: 10000, maxConcurrentJobs: 10, retentionMinutes: 72 * 60, priority: 20, blockedTools: [], priceCents: 2900, currency: 'usd', stripePriceId: env.STRIPE_PRICE_BUSINESS,
      features: ['Highest limits', '10,000 operations/day', 'All premium tools', 'Highest priority', `Batch processing (up to ${env.BATCH_FILES_BUSINESS} files at once)`, `Team accounts and shared billing (up to ${env.TEAM_SEATS_BUSINESS} people)`] },
  };
  return { maintenance: env.MAINTENANCE_MODE, disabledTools: [], plans };
}
