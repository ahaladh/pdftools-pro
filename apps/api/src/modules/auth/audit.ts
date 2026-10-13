import type { Request } from 'express';
import type { Logger } from 'pino';
import { AuditModel } from '../../db/models.js';
import type { Metrics } from '../../ops/metrics.js';

export class AuditService {
  constructor(private log: Logger, private enabled: boolean, private metrics?: Metrics) {}
  /** Never include secrets or document data in `meta`. Failures are logged, never thrown. */
  async record(actor: string, action: string, opts: { target?: string; req?: Request; meta?: Record<string, unknown> } = {}) {
    this.log.info({ actor, action, target: opts.target }, 'audit');
    this.metrics?.auditEvents.inc({ action });
    if (!this.enabled) return;
    try { await AuditModel.create({ actor, action, target: opts.target, ip: opts.req?.ip, meta: opts.meta }); }
    catch (e) { this.log.error({ err: e }, 'audit write failed'); }
  }
}
