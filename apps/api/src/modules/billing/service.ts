import type Stripe from 'stripe';
import type { Logger } from 'pino';
import { createHash } from 'node:crypto';
import type { BillingProvider, PlanId } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { BillingEventModel, TeamModel, UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import type { UserDoc } from '../auth/service.js';
import type { SettingsService } from '../settings/service.js';
import { seatLimits } from './seats.js';
import { mapRazorpayStatus, RazorpayError, verifyRazorpaySignature, type RazorpayClient, type RzSubscription } from './razorpay.js';

/** Subset of the Stripe SDK we use, so tests can inject a fake client. */
export type StripeClient = Pick<Stripe, 'customers' | 'checkout' | 'billingPortal' | 'subscriptions' | 'webhooks'>;

const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);

export class BillingService {
  constructor(private env: Env, private settings: SettingsService, private log: Logger, readonly stripe: StripeClient | null, readonly razorpay: RazorpayClient | null = null) {}

  get enabled() { return !!this.stripe || !!this.razorpay; }
  /** The gateways this server can take payment through. */
  get providers(): BillingProvider[] { return [...(this.stripe ? ['stripe' as const] : []), ...(this.razorpay ? ['razorpay' as const] : [])]; }
  private need(): StripeClient { if (!this.stripe) throw new HttpError(503, 'billing_not_configured', 'Billing is not configured on this server.'); return this.stripe; }
  private needRz(): RazorpayClient { if (!this.razorpay) throw new HttpError(503, 'billing_not_configured', 'Razorpay is not configured on this server.'); return this.razorpay; }

  /** The gateway a purchase goes through: the one asked for, else Stripe when it is configured, else Razorpay. */
  private pick(asked?: BillingProvider): BillingProvider {
    if (!this.enabled) throw new HttpError(503, 'billing_not_configured', 'Billing is not configured on this server.');
    if (asked) {
      if (!this.providers.includes(asked)) throw new HttpError(400, 'provider_unavailable', `${asked === 'stripe' ? 'Stripe' : 'Razorpay'} is not available on this server.`);
      return asked;
    }
    return this.providers[0]!;
  }
  /** Which gateway holds a person's or team's subscription (Stripe when unrecorded: every subscription from before Razorpay existed). */
  private providerOf(holder: UserDoc): BillingProvider { return holder.billing?.provider === 'razorpay' ? 'razorpay' : 'stripe'; }

  /** Create the Razorpay subscription and hand back its hosted payment page; the webhook grants the plan once the first payment lands. */
  private async rzSubscribe(plan: PlanId, seats: number, notes: Record<string, string>, email: string): Promise<string> {
    const rz = this.needRz();
    const cfg = (await this.settings.get()).plans[plan];
    if (!cfg?.razorpayPlanId || cfg.priceCents <= 0) throw new HttpError(400, 'plan_unavailable', 'This plan is not available for purchase with Razorpay.');
    let sub: RzSubscription;
    try { sub = await rz.createSubscription({ planId: cfg.razorpayPlanId, quantity: seats, totalCount: 120, notes: { ...notes, plan }, email }); }
    catch (e) { this.log.error({ err: e }, 'razorpay: could not create the subscription'); throw new HttpError(502, 'billing_error', 'Could not start checkout. Please try again.'); }
    if (!sub.short_url) throw new HttpError(502, 'billing_error', 'Could not start checkout.');
    return sub.short_url;
  }

  async checkout(user: UserDoc, plan: PlanId, provider?: BillingProvider): Promise<string> {
    const via = this.pick(provider);
    if (user.billing?.subscriptionId && ['active', 'trialing', 'past_due'].includes(user.billing.status)) {
      throw new HttpError(409, 'already_subscribed', 'You already have a subscription. Manage it from your account.');
    }
    if (via === 'razorpay') return this.rzSubscribe(plan, 1, { userId: String(user._id) }, user.email);
    const stripe = this.need();
    const cfg = (await this.settings.get()).plans[plan];
    if (!cfg?.stripePriceId || cfg.priceCents <= 0) throw new HttpError(400, 'plan_unavailable', 'This plan is not available for purchase.');
    let customerId: string | undefined = user.billing?.customerId;
    if (!customerId) {
      const c = await stripe.customers.create({ email: user.email, metadata: { userId: String(user._id) } });
      customerId = c.id;
      user.billing = { ...(user.billing?.toObject?.() ?? user.billing ?? {}), customerId };
      await user.save();
    }
    const base = this.env.PUBLIC_URL.replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: customerId, client_reference_id: String(user._id),
      line_items: [{ price: cfg.stripePriceId, quantity: 1 }],
      subscription_data: { metadata: { userId: String(user._id), plan } },
      success_url: `${base}/account?checkout=success`, cancel_url: `${base}/pricing?checkout=cancelled`,
    });
    if (!session.url) throw new HttpError(502, 'billing_error', 'Could not start checkout.');
    return session.url;
  }

  get perSeat() { return this.env.TEAM_BILLING === 'per_seat'; }

  /** Validate a seat count against the limits (and the people the team already has, `floor`). */
  private checkSeats(seats: unknown, floor: number): number {
    const { min, max } = seatLimits(this.env, floor);
    if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < min || seats > max) {
      throw new HttpError(400, 'invalid_seats', `Choose a whole number of seats from ${min} to ${max}${floor >= min && floor > 1 ? ` (the team already has ${floor} people and invitations)` : ''}.`);
    }
    return seats;
  }

  /**
   * A team subscribes as itself: its own Stripe customer and subscription, so billing survives members and owners changing.
   * Per seat, the plan's price is charged for each seat bought; the payer may adjust the quantity on Stripe's page within the same limits.
   */
  async checkoutTeam(team: UserDoc, owner: UserDoc, plan: PlanId, opts: { seats?: number; floor?: number; provider?: BillingProvider } = {}): Promise<string> {
    const via = this.pick(opts.provider);
    if (!this.perSeat && opts.seats !== undefined) throw new HttpError(400, 'not_per_seat', 'This server charges teams a flat price, not per seat.');
    const floor = opts.floor ?? 1;
    const seats = this.perSeat ? this.checkSeats(opts.seats ?? seatLimits(this.env, floor).min, floor) : 1;
    if (team.billing?.subscriptionId && ['active', 'trialing', 'past_due'].includes(team.billing.status)) {
      throw new HttpError(409, 'already_subscribed', 'This team already has a subscription. Manage it from the team page.');
    }
    if (via === 'razorpay') return this.rzSubscribe(plan, seats, { teamId: String(team._id) }, owner.email);
    const stripe = this.need();
    const cfg = (await this.settings.get()).plans[plan];
    if (!cfg?.stripePriceId || cfg.priceCents <= 0) throw new HttpError(400, 'plan_unavailable', 'This plan is not available for purchase.');
    let customerId: string | undefined = team.billing?.customerId;
    if (!customerId) {
      const c = await stripe.customers.create({ email: owner.email, name: team.name, metadata: { teamId: String(team._id) } });
      customerId = c.id;
      team.billing = { ...(team.billing?.toObject?.() ?? team.billing ?? {}), customerId };
      await team.save();
    }
    const base = this.env.PUBLIC_URL.replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: customerId, client_reference_id: `team:${team._id}`,
      line_items: [this.perSeat
        ? { price: cfg.stripePriceId, quantity: seats, adjustable_quantity: { enabled: true, minimum: seatLimits(this.env, floor).min, maximum: seatLimits(this.env, floor).max } }
        : { price: cfg.stripePriceId, quantity: 1 }],
      subscription_data: { metadata: { teamId: String(team._id), plan } },
      success_url: `${base}/account?checkout=success`, cancel_url: `${base}/pricing?checkout=cancelled`,
    });
    if (!session.url) throw new HttpError(502, 'billing_error', 'Could not start checkout.');
    return session.url;
  }

  /**
   * Change how many seats a subscribed team pays for. Stripe prorates (an increase is charged now, a decrease credited on the
   * next invoice) and an increase whose payment fails is refused, so nobody gets seats they have not paid for. Stripe's answer is
   * applied at once; the webhook that follows carries the same quantity.
   */
  async changeTeamSeats(team: UserDoc, seats: unknown, floor: number): Promise<number> {
    if (!this.perSeat) throw new HttpError(409, 'not_per_seat', 'This server charges teams a flat price, so there are no seats to change.');
    const b = team.billing;
    if (!b?.subscriptionId || !['active', 'trialing'].includes(b.status)) throw new HttpError(409, 'no_subscription', 'Subscribe the team first; seats can be changed once there is an active subscription.');
    const wanted = this.checkSeats(seats, floor);
    if (this.providerOf(team) === 'razorpay') return this.changeSeatsRazorpay(team, b.subscriptionId, wanted);
    const stripe = this.need();
    let current: Stripe.Subscription, updated: Stripe.Subscription;
    try {
      current = await stripe.subscriptions.retrieve(b.subscriptionId);
      const item = current.items.data[0];
      if (!item) throw new HttpError(502, 'billing_error', 'Could not read the team subscription.');
      if (item.quantity === wanted) return wanted;
      updated = await stripe.subscriptions.update(b.subscriptionId, { items: [{ id: item.id, quantity: wanted }], proration_behavior: 'create_prorations', payment_behavior: 'error_if_incomplete' });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if ((e as { type?: string }).type === 'StripeCardError') throw new HttpError(402, 'payment_failed', 'The card on file was declined, so the seats were not added. Update the payment method from "Manage team billing" and try again.');
      this.log.error({ err: e }, 'could not change team seats');
      throw new HttpError(502, 'billing_error', 'Could not change the number of seats right now. Please try again.');
    }
    const q = updated.items.data[0]?.quantity ?? wanted;
    team.set('billing.seats', q);
    team.set('billing.eventAt', Math.floor(Date.now() / 1000));
    await team.save();
    return q;
  }

  /** Razorpay charges the difference when the quantity changes; a refused payment leaves the seats as they were. */
  private async changeSeatsRazorpay(team: UserDoc, subscriptionId: string, wanted: number): Promise<number> {
    const rz = this.needRz();
    if ((team.billing?.seats ?? 0) === wanted) return wanted;
    let updated: RzSubscription;
    try { updated = await rz.updateQuantity(subscriptionId, wanted); }
    catch (e) {
      this.log.error({ err: e }, 'razorpay: could not change team seats');
      if (e instanceof RazorpayError && e.status >= 400 && e.status < 500) throw new HttpError(402, 'payment_failed', 'The seats could not be changed (the payment method was refused or the change is not allowed right now). Nothing was charged.');
      throw new HttpError(502, 'billing_error', 'Could not change the number of seats right now. Please try again.');
    }
    const q = updated.quantity ?? wanted;
    team.set('billing.seats', q);
    team.set('billing.eventAt', Math.floor(Date.now() / 1000));
    await team.save();
    return q;
  }

  /**
   * Razorpay has no customer portal: stop renewal from here instead. The plan stays until the end of the paid period; the webhook
   * that Razorpay sends at the end is what takes the plan away. Stripe subscriptions are managed from Stripe's portal.
   */
  async cancelAtPeriodEnd(holder: UserDoc): Promise<void> {
    const b = holder.billing;
    if (this.providerOf(holder) !== 'razorpay') throw new HttpError(409, 'use_portal', 'This subscription is managed from the billing portal.');
    if (!b?.subscriptionId || !['active', 'trialing', 'past_due'].includes(b.status)) throw new HttpError(409, 'no_subscription', 'There is no active subscription to cancel.');
    try { await this.needRz().cancel(b.subscriptionId, true); }
    catch (e) { this.log.error({ err: e }, 'razorpay: could not cancel'); throw new HttpError(502, 'billing_error', 'Could not cancel the subscription right now. Please try again.'); }
    holder.set('billing.cancelAtPeriodEnd', true);
    await holder.save();
  }

  async portalTeam(team: UserDoc): Promise<string> {
    if (this.providerOf(team) === 'razorpay' && team.billing?.subscriptionId) throw new HttpError(409, 'no_portal', 'This subscription is paid through Razorpay, which has no billing portal. Use "Cancel subscription" to stop renewal.');
    const stripe = this.need();
    if (!team.billing?.customerId) throw new HttpError(400, 'no_customer', 'This team has no billing account yet.');
    return (await stripe.billingPortal.sessions.create({ customer: team.billing.customerId, return_url: `${this.env.PUBLIC_URL.replace(/\/$/, '')}/account` })).url;
  }

  async portal(user: UserDoc): Promise<string> {
    if (this.providerOf(user) === 'razorpay' && user.billing?.subscriptionId) throw new HttpError(409, 'no_portal', 'This subscription is paid through Razorpay, which has no billing portal. Use "Cancel subscription" to stop renewal.');
    const stripe = this.need();
    if (!user.billing?.customerId) throw new HttpError(400, 'no_customer', 'No billing account yet.');
    const s = await stripe.billingPortal.sessions.create({ customer: user.billing.customerId, return_url: `${this.env.PUBLIC_URL.replace(/\/$/, '')}/account` });
    return s.url;
  }

  /** Works for a person or a team: both carry the same billing block. */
  async cancelForDeletion(holder: UserDoc) {
    if (!holder.billing?.subscriptionId || ENDED.has(holder.billing.status)) return;
    if (this.providerOf(holder) === 'razorpay') {
      if (!this.razorpay) throw new Error('this subscription is with Razorpay, which is not configured here, so it cannot be cancelled');
      await this.razorpay.cancel(holder.billing.subscriptionId, false);
      return;
    }
    if (!this.stripe) return;
    await this.stripe.subscriptions.cancel(holder.billing.subscriptionId);
  }

  /** Verify the signature against the RAW body, then process each event id exactly once. */
  async handleWebhook(raw: Buffer, signature: string | undefined): Promise<{ duplicate: boolean }> {
    const stripe = this.need();
    if (!this.env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'billing_not_configured', 'Webhook secret not configured.');
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(raw, signature ?? '', this.env.STRIPE_WEBHOOK_SECRET); }
    catch { throw new HttpError(400, 'invalid_signature', 'Invalid webhook signature.'); }
    try { await BillingEventModel.create({ _id: event.id, type: event.type }); }
    catch (e) { if ((e as { code?: number }).code === 11000) return { duplicate: true }; throw e; }
    try { await this.apply(event); }
    catch (e) { await BillingEventModel.deleteOne({ _id: event.id }); throw e; } // let Stripe retry
    return { duplicate: false };
  }

  private async teamFor(meta: Record<string, string> | null | undefined, customerId: string | undefined): Promise<UserDoc | null> {
    if (meta?.teamId && /^[a-f0-9]{24}$/.test(meta.teamId)) { const t = await TeamModel.findById(meta.teamId); if (t) return t; }
    return customerId ? TeamModel.findOne({ 'billing.customerId': customerId }) : null;
  }

  private async userFor(meta: Record<string, string> | null | undefined, customerId: string | undefined): Promise<UserDoc | null> {
    if (meta?.userId && /^[a-f0-9]{24}$/.test(meta.userId)) { const u = await UserModel.findById(meta.userId); if (u) return u; }
    return customerId ? UserModel.findOne({ 'billing.customerId': customerId }) : null;
  }

  private async apply(event: Stripe.Event) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const ref = s.client_reference_id ?? '';
        const user = ref.startsWith('team:')
          ? await this.teamFor({ teamId: ref.slice(5) }, typeof s.customer === 'string' ? s.customer : undefined)
          : await this.userFor({ userId: ref }, typeof s.customer === 'string' ? s.customer : undefined);
        if (!user) return void this.log.warn({ event: event.id }, 'checkout completed for unknown user');
        user.billing = { ...(user.billing?.toObject?.() ?? user.billing ?? {}), provider: 'stripe', customerId: typeof s.customer === 'string' ? s.customer : user.billing?.customerId, subscriptionId: typeof s.subscription === 'string' ? s.subscription : user.billing?.subscriptionId };
        await user.save();
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        // A subscription belongs to a team when it says so (metadata/customer), otherwise to a person. Both use the same plan mapping.
        const cust = typeof sub.customer === 'string' ? sub.customer : undefined;
        const team = await this.teamFor(sub.metadata, cust);
        const user = team ?? (await this.userFor(sub.metadata, cust));
        if (!user) return void this.log.warn({ event: event.id }, 'subscription event for unknown user or team');
        // Stripe does not promise delivery in order: an older event arriving late must not undo a newer one (for example a seat count).
        if (typeof event.created === 'number' && event.created < (user.billing?.eventAt ?? 0)) {
          return void this.log.info({ event: event.id, type: event.type }, 'stale subscription event ignored (a newer one was already applied)');
        }
        const priceId = sub.items.data[0]?.price.id;
        const plans = (await this.settings.get()).plans;
        const matched = (['pro', 'business'] as const).find((p) => plans[p].stripePriceId && plans[p].stripePriceId === priceId);
        if (!matched && event.type !== 'customer.subscription.deleted') {
          this.log.error({ event: event.id, priceId }, 'subscription uses a price that is not mapped to a plan; plan unchanged');
          return;
        }
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
        const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
        user.billing = {
          provider: 'stripe', customerId: typeof sub.customer === 'string' ? sub.customer : user.billing?.customerId, subscriptionId: sub.id, status,
          plan: matched ?? user.billing?.plan, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined, cancelAtPeriodEnd: sub.cancel_at_period_end,
          eventAt: typeof event.created === 'number' ? event.created : user.billing?.eventAt,
          // For a team the subscription's quantity is the seats it has paid for.
          ...(team ? { seats: sub.items.data[0]?.quantity ?? user.billing?.seats } : {}),
        };
        // Entitlement follows subscription state. past_due keeps access while Stripe retries payment.
        if (ENDED.has(status)) user.plan = 'free';
        else if ((status === 'active' || status === 'trialing' || status === 'past_due') && matched) user.plan = matched;
        await user.save();
        return;
      }
      default: return;
    }
  }

  /**
   * Razorpay webhooks: verify the signature over the raw body, apply each event once (Razorpay's event id header), ignore events older
   * than one already applied. The subscription says who it belongs to in its notes (we put the user or team id there at checkout).
   */
  async handleRazorpayWebhook(raw: Buffer, signature: string | undefined, eventId: string | undefined): Promise<{ duplicate: boolean }> {
    if (!this.razorpay || !this.env.RAZORPAY_WEBHOOK_SECRET) throw new HttpError(503, 'billing_not_configured', 'Razorpay webhooks are not configured.');
    if (!verifyRazorpaySignature(raw, signature, this.env.RAZORPAY_WEBHOOK_SECRET)) throw new HttpError(400, 'invalid_signature', 'Invalid webhook signature.');
    let body: { event?: string; created_at?: number; payload?: { subscription?: { entity?: RzSubscription } } };
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_body', 'Malformed webhook body.'); }
    const id = `rz:${eventId || createHash('sha256').update(raw).digest('hex')}`;
    try { await BillingEventModel.create({ _id: id, type: String(body.event ?? 'unknown') }); }
    catch (e) { if ((e as { code?: number }).code === 11000) return { duplicate: true }; throw e; }
    try { await this.applyRazorpay(id, body); }
    catch (e) { await BillingEventModel.deleteOne({ _id: id }); throw e; } // let Razorpay retry
    return { duplicate: false };
  }

  private async applyRazorpay(id: string, body: { event?: string; created_at?: number; payload?: { subscription?: { entity?: RzSubscription } } }) {
    if (!body.event?.startsWith('subscription.')) return;
    const sub = body.payload?.subscription?.entity;
    if (!sub?.id) return;
    const notes = (Array.isArray(sub.notes) ? {} : sub.notes ?? {}) as Record<string, string>;
    const team = await this.teamFor(notes, undefined) ?? (await TeamModel.findOne({ 'billing.subscriptionId': sub.id }));
    const holder = team ?? (await this.userFor(notes, undefined)) ?? (await UserModel.findOne({ 'billing.subscriptionId': sub.id }));
    if (!holder) return void this.log.warn({ event: id }, 'razorpay: subscription event for an unknown user or team');
    const b = holder.billing;
    if (typeof body.created_at === 'number' && body.created_at < (b?.eventAt ?? 0)) {
      return void this.log.info({ event: id, type: body.event }, 'razorpay: stale subscription event ignored (a newer one was already applied)');
    }
    // A second subscription must not take over a live one (for example an old payment link that gets paid after the buyer subscribed elsewhere).
    if (b?.subscriptionId && b.subscriptionId !== sub.id && ['active', 'trialing', 'past_due'].includes(b.status)) {
      return void this.log.error({ event: id, subscription: sub.id, existing: b.subscriptionId }, 'razorpay: a different subscription was paid while one is already active; ignored. Refund or cancel the extra one in the Razorpay dashboard');
    }
    const status = mapRazorpayStatus(sub.status);
    if (!status) return; // created / authenticated: nothing paid yet
    const plans = (await this.settings.get()).plans;
    const matched = (['pro', 'business'] as const).find((p) => plans[p].razorpayPlanId && plans[p].razorpayPlanId === sub.plan_id);
    if (!matched && status !== 'canceled' && status !== 'unpaid') {
      this.log.error({ event: id, planId: sub.plan_id }, 'razorpay: subscription uses a plan that is not mapped to a PDFTools plan; plan unchanged');
      return;
    }
    const sameSub = b?.subscriptionId === sub.id;
    holder.billing = {
      provider: 'razorpay', customerId: sub.customer_id ?? (sameSub ? b?.customerId : undefined), subscriptionId: sub.id, status,
      plan: matched ?? b?.plan, currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : sameSub ? b?.currentPeriodEnd : undefined,
      // Razorpay does not report "cancel at period end" on the subscription: keep what our own cancel call recorded.
      cancelAtPeriodEnd: status === 'canceled' ? false : sameSub ? !!b?.cancelAtPeriodEnd : false,
      eventAt: typeof body.created_at === 'number' ? body.created_at : b?.eventAt,
      ...(team ? { seats: sub.quantity ?? b?.seats } : {}),
    };
    if (ENDED.has(status)) holder.plan = 'free';
    else if (matched) holder.plan = matched; // active, or past_due while Razorpay retries
    await holder.save();
  }
}
