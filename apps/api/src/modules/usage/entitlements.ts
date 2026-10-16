import type { Request } from 'express';
import type { PlanConfig, PlanId } from '@pdftools/shared';
import { HttpError } from '../../utils/errors.js';
import type { JobStore } from '../jobs/types.js';
import type { SettingsService } from '../settings/service.js';
import type { UsageStore } from './store.js';

/** Plan resolution and enforcement. All limits come from settings; nothing is hardcoded here. */
export class Entitlements {
  constructor(private settings: SettingsService, private usage: UsageStore, private jobs: JobStore, private storageMB?: () => Promise<number>, private maxStorageMB = 0) {}

  planId(req: Request): PlanId { return req.user ? (req.effectivePlan ?? (req.user.plan as PlanId)) : 'guest'; }
  async planFor(req: Request): Promise<PlanConfig> { return this.settings.plan(this.planId(req)); }

  /** Throws an HttpError describing exactly which limit blocked the request. */
  async check(req: Request, toolId: string): Promise<PlanConfig> {
    const s = await this.settings.get();
    const plan = s.plans[this.planId(req)]!;
    if (s.maintenance) throw new HttpError(503, 'maintenance', 'The service is temporarily unavailable for maintenance.');
    if (s.disabledTools.includes(toolId)) throw new HttpError(403, 'tool_disabled', 'This tool is temporarily disabled.');
    if (plan.blockedTools.includes(toolId)) {
      throw new HttpError(403, 'upgrade_required', req.user ? 'This tool is not included in your plan. Upgrade to use it.' : 'This tool needs a paid plan. Sign in and upgrade to use it.');
    }
    if (this.storageMB && this.maxStorageMB > 0 && (await this.storageMB()) >= this.maxStorageMB) {
      throw new HttpError(503, 'storage_full', 'The service is temporarily at capacity. Please try again in a few minutes.');
    }
    const [active, ...used] = await Promise.all([this.jobs.activeCount(req.owner), ...req.usageKeys.map((k) => this.usage.ops(k))]);
    if (active >= plan.maxConcurrentJobs) throw new HttpError(429, 'too_many_jobs', 'You already have jobs in progress. Please wait for them to finish.');
    if (Math.max(0, ...used) + active >= plan.dailyOps) {
      throw new HttpError(429, 'quota_exceeded', `You have reached today's limit of ${plan.dailyOps} operations on the ${plan.name} plan.${req.user ? '' : ' Create a free account for a higher limit.'}`);
    }
    return plan;
  }
}
