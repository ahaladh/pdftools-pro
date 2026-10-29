import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The few Razorpay Subscriptions calls we make, as plain REST (no SDK: four endpoints, and a thin client is easy to point at a
 * test double). Docs: https://razorpay.com/docs/api/payments/subscriptions/
 */
export interface RzSubscription {
  id: string;
  /** created | authenticated | active | pending | halted | cancelled | completed | expired | paused */
  status: string;
  plan_id: string;
  quantity?: number;
  /** Unix seconds: when the paid period ends. */
  current_end?: number | null;
  /** Hosted page where the buyer authorises the payment. */
  short_url?: string;
  customer_id?: string | null;
  /** Razorpay returns `[]` instead of `{}` when there are no notes. */
  notes?: Record<string, string> | unknown[];
}

export interface RazorpayClient {
  createSubscription(p: { planId: string; quantity: number; totalCount: number; notes: Record<string, string>; email?: string }): Promise<RzSubscription>;
  /** Change the seat count, charging/crediting the difference now. */
  updateQuantity(id: string, quantity: number): Promise<RzSubscription>;
  cancel(id: string, atCycleEnd: boolean): Promise<RzSubscription>;
}

export class RazorpayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'RazorpayError'; }
}

export class HttpRazorpay implements RazorpayClient {
  private auth: string;
  constructor(keyId: string, keySecret: string, private base = 'https://api.razorpay.com') {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    this.base = base.replace(/\/$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method, headers: { Authorization: this.auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) { throw new RazorpayError(0, 'unreachable', `Razorpay could not be reached: ${(e as Error).message}`); }
    const text = await res.text();
    let json: { error?: { code?: string; description?: string } } & Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* a non-JSON error page from a proxy */ }
    if (!res.ok) throw new RazorpayError(res.status, json.error?.code ?? 'error', json.error?.description ?? `Razorpay answered ${res.status}`);
    return json as T;
  }

  createSubscription(p: { planId: string; quantity: number; totalCount: number; notes: Record<string, string>; email?: string }) {
    return this.call<RzSubscription>('POST', '/v1/subscriptions', {
      plan_id: p.planId, quantity: p.quantity, total_count: p.totalCount, customer_notify: 1, notes: p.notes,
      ...(p.email ? { notify_info: { notify_email: p.email } } : {}),
    });
  }
  updateQuantity(id: string, quantity: number) {
    return this.call<RzSubscription>('PATCH', `/v1/subscriptions/${encodeURIComponent(id)}`, { quantity, schedule_change_at: 'now' });
  }
  cancel(id: string, atCycleEnd: boolean) {
    return this.call<RzSubscription>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  }
}

/** `X-Razorpay-Signature` is the hex HMAC-SHA256 of the exact raw body with the webhook secret. Constant-time compare. */
export function verifyRazorpaySignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Our subscription states, from Razorpay's. `null` = nothing has been paid yet, so change nothing. */
export function mapRazorpayStatus(status: string): 'active' | 'past_due' | 'unpaid' | 'canceled' | null {
  switch (status) {
    case 'active': return 'active';
    case 'pending': return 'past_due'; // a charge failed and Razorpay is retrying: access continues, as for Stripe's past_due
    case 'halted': case 'paused': return 'unpaid'; // retries exhausted or paused: access ends
    case 'cancelled': case 'completed': case 'expired': return 'canceled';
    default: return null; // created, authenticated
  }
}
