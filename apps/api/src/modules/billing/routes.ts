import { Router } from 'express';
import { z } from 'zod';
import { ok, wrap } from '../../middleware/common.js';
import { HttpError } from '../../utils/errors.js';
import { requireUser } from '../auth/middleware.js';
import type { BillingService } from './service.js';

export function billingRoutes(billing: BillingService) {
  const r = Router();
  r.post('/checkout', requireUser, wrap(async (req, res) => {
    const { plan } = z.object({ plan: z.enum(['pro', 'business']) }).parse(req.body);
    ok(res, { url: await billing.checkout(req.user, plan) });
  }));
  r.post('/portal', requireUser, wrap(async (req, res) => ok(res, { url: await billing.portal(req.user) })));
  return r;
}

/** Mounted with express.raw BEFORE the JSON parser; no identity/cookies, authenticity is the Stripe signature. */
export function webhookRoute(billing: BillingService) {
  const r = Router();
  r.post('/', wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'invalid_body', 'Expected raw body.');
    const { duplicate } = await billing.handleWebhook(req.body, req.get('stripe-signature'));
    res.json({ received: true, duplicate });
  }));
  return r;
}
