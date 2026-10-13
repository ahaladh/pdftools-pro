import type Stripe from 'stripe';
import type { Logger } from 'pino';
import type { PlanId } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { BillingEventModel, UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import type { UserDoc } from '../auth/service.js';
import type { SettingsService } from '../settings/service.js';

/** Subset of the Stripe SDK we use, so tests can inject a fake client. */
export type StripeClient = Pick<Stripe, 'customers' | 'checkout' | 'billingPortal' | 'subscriptions' | 'webhooks'>;

const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);

export class BillingService {
  constructor(private env: Env, private settings: SettingsService, private log: Logger, readonly stripe: StripeClient | null) {}

  get enabled() { return !!this.stripe; }
  private need(): StripeClient { if (!this.stripe) throw new HttpError(503, 'billing_not_configured', 'Billing is not configured on this server.'); return this.stripe; }

  async checkout(user: UserDoc, plan: PlanId): Promise<string> {
    const stripe = this.need();
    const cfg = (await this.settings.get()).plans[plan];
    if (!cfg?.stripePriceId || cfg.priceCents <= 0) throw new HttpError(400, 'plan_unavailable', 'This plan is not available for purchase.');
    if (user.billing?.subscriptionId && ['active', 'trialing', 'past_due'].includes(user.billing.status)) {
      throw new HttpError(409, 'already_subscribed', 'You already have a subscription. Manage it from the billing portal.');
    }
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

  async portal(user: UserDoc): Promise<string> {
    const stripe = this.need();
    if (!user.billing?.customerId) throw new HttpError(400, 'no_customer', 'No billing account yet.');
    const s = await stripe.billingPortal.sessions.create({ customer: user.billing.customerId, return_url: `${this.env.PUBLIC_URL.replace(/\/$/, '')}/account` });
    return s.url;
  }

  async cancelForDeletion(user: UserDoc) {
    if (!this.stripe || !user.billing?.subscriptionId || ENDED.has(user.billing.status)) return;
    await this.stripe.subscriptions.cancel(user.billing.subscriptionId);
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

  private async userFor(meta: Record<string, string> | null | undefined, customerId: string | undefined): Promise<UserDoc | null> {
    if (meta?.userId && /^[a-f0-9]{24}$/.test(meta.userId)) { const u = await UserModel.findById(meta.userId); if (u) return u; }
    return customerId ? UserModel.findOne({ 'billing.customerId': customerId }) : null;
  }

  private async apply(event: Stripe.Event) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const user = await this.userFor({ userId: s.client_reference_id ?? '' }, typeof s.customer === 'string' ? s.customer : undefined);
        if (!user) return void this.log.warn({ event: event.id }, 'checkout completed for unknown user');
        user.billing = { ...(user.billing?.toObject?.() ?? user.billing ?? {}), customerId: typeof s.customer === 'string' ? s.customer : user.billing?.customerId, subscriptionId: typeof s.subscription === 'string' ? s.subscription : user.billing?.subscriptionId };
        await user.save();
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await this.userFor(sub.metadata, typeof sub.customer === 'string' ? sub.customer : undefined);
        if (!user) return void this.log.warn({ event: event.id }, 'subscription event for unknown user');
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
          customerId: typeof sub.customer === 'string' ? sub.customer : user.billing?.customerId, subscriptionId: sub.id, status,
          plan: matched ?? user.billing?.plan, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined, cancelAtPeriodEnd: sub.cancel_at_period_end,
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
}
