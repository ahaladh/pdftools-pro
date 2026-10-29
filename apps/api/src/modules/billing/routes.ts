import { Router } from 'express';
import { z } from 'zod';
import { BILLING_PROVIDERS } from '@pdftools/shared';
import { ok, wrap } from '../../middleware/common.js';
import { HttpError } from '../../utils/errors.js';
import { requireUser } from '../auth/middleware.js';
import type { BillingService } from './service.js';

export function billingRoutes(billing: BillingService, opts: { requireVerifiedEmail?: boolean; teamOf?: (user: import('../auth/service.js').UserDoc) => Promise<{ team: import('../auth/service.js').UserDoc; role: string } | null>; /** People the team already has (members plus pending invitations): it cannot buy fewer seats. */ seatFloor?: (team: import('../auth/service.js').UserDoc) => Promise<number> } = {}) {
  const r = Router();
  r.post('/checkout', requireUser, wrap(async (req, res) => {
    if (opts.requireVerifiedEmail && !req.user.emailVerifiedAt) throw new HttpError(403, 'email_unverified', 'Please confirm your email address before upgrading. You can resend the confirmation email from your account page.');
    const { plan, provider } = z.object({ plan: z.enum(['pro', 'business']), provider: z.enum(BILLING_PROVIDERS).optional() }).parse(req.body);
    ok(res, { url: await billing.checkout(req.user, plan, provider) });
  }));
  // Team billing: owner only. The subscription belongs to the team, not to the person who happened to click the button.
  const ownedTeam = async (user: import('../auth/service.js').UserDoc) => {
    const c = await opts.teamOf?.(user);
    if (!c) throw new HttpError(404, 'no_team', 'You are not in a team.');
    if (c.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the team owner can manage the team subscription.');
    return c.team;
  };
  r.post('/team/checkout', requireUser, wrap(async (req, res) => {
    if (opts.requireVerifiedEmail && !req.user.emailVerifiedAt) throw new HttpError(403, 'email_unverified', 'Please confirm your email address before upgrading.');
    const { plan, seats, provider } = z.object({ plan: z.enum(['pro', 'business']), seats: z.number().int().optional(), provider: z.enum(BILLING_PROVIDERS).optional() }).parse(req.body);
    const team = await ownedTeam(req.user);
    ok(res, { url: await billing.checkoutTeam(team, req.user, plan, { seats, provider, floor: (await opts.seatFloor?.(team)) ?? 1 }) });
  }));
  r.post('/team/seats', requireUser, wrap(async (req, res) => {
    const { seats } = z.object({ seats: z.number() }).parse(req.body);
    const team = await ownedTeam(req.user);
    ok(res, { seats: await billing.changeTeamSeats(team, seats, (await opts.seatFloor?.(team)) ?? 1) });
  }));
  r.post('/team/portal', requireUser, wrap(async (req, res) => ok(res, { url: await billing.portalTeam(await ownedTeam(req.user)) })));
  r.post('/team/cancel', requireUser, wrap(async (req, res) => { await billing.cancelAtPeriodEnd(await ownedTeam(req.user)); ok(res, { cancelAtPeriodEnd: true }); }));
  r.post('/cancel', requireUser, wrap(async (req, res) => { await billing.cancelAtPeriodEnd(req.user); ok(res, { cancelAtPeriodEnd: true }); }));
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

/** Razorpay's webhook: raw body, the signature header, and the event id header for exactly-once handling. */
export function razorpayWebhookRoute(billing: BillingService) {
  const r = Router();
  r.post('/', wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'invalid_body', 'Expected raw body.');
    const { duplicate } = await billing.handleRazorpayWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'));
    res.json({ received: true, duplicate });
  }));
  return r;
}
