import type { Request } from 'express';
import type { PlanConfig, PlanId } from '@pdftools/shared';
import { HttpError } from '../../utils/errors.js';
import type { JobStore } from '../jobs/types.js';
import type { SettingsService } from '../settings/service.js';
import type { UsageStore } from './store.js';
import { memberKey } from '../teams/plan.js';

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
    if (req.pool) {
      // Shared pool: one counter for the team, sized by how many people are in it. Concurrency stays per person.
      // Jobs in flight anywhere in the team count too: they are not in the shared counter until they finish.
      const [mine, myUnits, inFlight, used] = await Promise.all([this.jobs.activeCount(req.owner), this.jobs.activeUnits(req.owner), Promise.all(req.pool.memberIds.map((id) => this.jobs.activeUnits(`u:${id}`))).then((a) => a.reduce((x, y) => x + y, 0)), this.usage.ops(req.pool.key)]);
      if (mine >= plan.maxConcurrentJobs) throw new HttpError(429, 'too_many_jobs', 'You already have jobs in progress. Please wait for them to finish.');
      const limit = plan.dailyOps * req.pool.members;
      if (used + inFlight >= limit) {
        throw new HttpError(429, 'quota_exceeded', `Your team “${req.pool.teamName}” has used today's shared allowance of ${limit} operations (${plan.dailyOps} for each of its ${req.pool.members} member${req.pool.members === 1 ? '' : 's'}). It resets tomorrow; a team owner can add people to raise it.`);
      }
      // The team may also limit what any one person can draw from the pool in a day.
      if (req.pool.memberCap) {
        const yours = await this.usage.ops(memberKey(req.pool.teamId, String(req.user?._id)));
        if (yours + myUnits >= req.pool.memberCap) {
          throw new HttpError(429, 'member_cap_reached', `Your team “${req.pool.teamName}” limits each person to ${req.pool.memberCap} operations a day, and you have reached it. It resets tomorrow; a team owner can raise the limit.`);
        }
      }
      return plan;
    }
    const [active, activeU, ...used] = await Promise.all([this.jobs.activeCount(req.owner), this.jobs.activeUnits(req.owner), ...req.usageKeys.map((k) => this.usage.ops(k))]);
    if (active >= plan.maxConcurrentJobs) throw new HttpError(429, 'too_many_jobs', 'You already have jobs in progress. Please wait for them to finish.');
    if (Math.max(0, ...used) + activeU >= plan.dailyOps) {
      throw new HttpError(429, 'quota_exceeded', `You have reached today's limit of ${plan.dailyOps} operations on the ${plan.name} plan.${req.user ? '' : ' Create a free account for a higher limit.'}`);
    }
    return plan;
  }

  /**
   * A batch counts one operation per file. The size is only known once the upload has been read, so this runs then: is there room
   * for all of it today? The job's own reservation already counts as one unit, hence the `- 1`. Throws with how much is left.
   */
  async ensureUnits(req: Request, plan: PlanConfig, units: number): Promise<void> {
    if (units <= 1) return;
    if (req.pool) {
      const [myUnits, inFlight, used] = await Promise.all([this.jobs.activeUnits(req.owner), Promise.all(req.pool.memberIds.map((id) => this.jobs.activeUnits(`u:${id}`))).then((a) => a.reduce((x, y) => x + y, 0)), this.usage.ops(req.pool.key)]);
      const limit = plan.dailyOps * req.pool.members;
      const left = limit - used - (inFlight - 1);
      if (units > left) throw new HttpError(429, 'quota_exceeded', `This batch of ${units} files is more than your team's shared allowance has left today (${Math.max(0, left)} of ${limit}). Send fewer files, or try again tomorrow.`);
      if (req.pool.memberCap) {
        const mine = limitLeft(req.pool.memberCap, await this.usage.ops(memberKey(req.pool.teamId, String(req.user?._id))), myUnits - 1);
        if (units > mine) throw new HttpError(429, 'member_cap_reached', `This batch of ${units} files would take you past your team's limit of ${req.pool.memberCap} operations a day per person (${mine} left today). Send fewer files, or ask a team owner to raise the limit.`);
      }
      return;
    }
    const [activeU, ...used] = await Promise.all([this.jobs.activeUnits(req.owner), ...req.usageKeys.map((k) => this.usage.ops(k))]);
    const left = plan.dailyOps - Math.max(0, ...used) - (activeU - 1);
    if (units > left) throw new HttpError(429, 'quota_exceeded', `This batch of ${units} files is more than the ${Math.max(0, left)} operation${left === 1 ? '' : 's'} left today on the ${plan.name} plan. Send fewer files, or try again tomorrow.`);
  }
}

const limitLeft = (cap: number, used: number, inFlight: number) => Math.max(0, cap - used - inFlight);
