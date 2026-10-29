import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { register, uniqueEmail } from '../support/helpers';
import { API_PORT, ROOT, WEB_PORT, readState } from '../support/stack';
import { FakeRazorpay } from '../../apps/api/src/testing/fakerazorpay';

/**
 * Paying through Razorpay in the browser. The REAL server code talks over HTTP to a fake Razorpay (RAZORPAY_API_BASE), and the
 * "payment" is the signed webhook Razorpay would send, so what is asserted is what goes over the wire and what the buyer sees.
 * Both gateways are configured, as a server selling worldwide would. Not covered, because it needs Razorpay itself: that Razorpay
 * accepts these requests, its hosted payment page, and its real webhook payloads.
 */
const WEB4 = WEB_PORT + 21, API4 = API_PORT + 21;
const web4 = `http://localhost:${WEB4}`, api4 = `http://localhost:${API4}`;
const SECRET = 'whsec_e2e_razorpay';
test.use({ baseURL: web4 });
test.describe.configure({ mode: 'serial' });

const fake = new FakeRazorpay();
const kids: ChildProcess[] = [];
const up = async (url: string) => { for (let i = 0; i < 240; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`${url} did not come up`); };
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const adminSettings = async (change: (s: { plans: Record<string, { stripePriceId?: string; razorpayPlanId?: string }> }) => void) => {
  const st = readState();
  const call = async (path: string, init: RequestInit = {}, token?: string) => (await (await fetch(`${api4}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json());
  const { data: sess } = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: st.adminEmail, password: st.adminPassword }) }) as { data: { accessToken: string } };
  const { data: s } = await call('/api/admin/settings', {}, sess.accessToken) as { data: { plans: Record<string, { stripePriceId?: string; razorpayPlanId?: string }> } };
  change(s);
  await call('/api/admin/settings', { method: 'PUT', body: JSON.stringify(s) }, sess.accessToken);
};
/** What Razorpay sends when a subscription changes, signed the way Razorpay signs it. */
let n = 0;
const razorpayEvent = async (userId: string, subId: string, status: string, event: string, createdAt = Math.floor(Date.now() / 1000)) => {
  const body = JSON.stringify({ entity: 'event', event, created_at: createdAt, payload: { subscription: { entity: {
    id: subId, plan_id: 'plan_pro_e2e', quantity: 1, status, notes: { userId, plan: 'pro' }, current_end: Math.floor(Date.now() / 1000) + 30 * 86400, customer_id: null,
  } } } });
  const r = await fetch(`${api4}/api/billing/razorpay/webhook`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-razorpay-event-id': `evt_e2e_${Date.now()}_${n++}`, 'x-razorpay-signature': createHmac('sha256', SECRET).update(body).digest('hex') },
  });
  expect(r.status, await r.text()).toBe(200);
};

test.beforeAll(async () => {
  test.setTimeout(150_000);
  const s = readState();
  await fake.start();
  mkdirSync(join(ROOT, 'e2e/.logs'), { recursive: true });
  const out = createWriteStream(join(ROOT, 'e2e/.logs/razorpay-stack.log'));
  const start = (cmd: string, args: string[], env: Record<string, string>, cwd: string) => {
    const p = spawn(cmd, args, { cwd, env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout?.pipe(out); p.stderr?.pipe(out); kids.push(p);
  };
  start(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], {
    ...s.env, PORT: String(API4), CORS_ORIGINS: web4, PUBLIC_URL: web4, QUEUE_DRIVER: 'inline',
    RAZORPAY_KEY_ID: fake.keyId, RAZORPAY_KEY_SECRET: fake.keySecret, RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_API_BASE: fake.base,
    // Stripe configured too (never called in this spec; it is here so the buyer has a choice)
    STRIPE_SECRET_KEY: 'sk_test_fake_e2e', STRIPE_WEBHOOK_SECRET: 'whsec_e2e_stripe_unused', STRIPE_API_BASE: fake.base,
  }, join(ROOT, 'apps/api'));
  await up(`${api4}/health`);
  start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB4), '--strictPort', '--host', 'localhost'], { API_URL: api4 }, join(ROOT, 'apps/web'));
  await up(`${web4}/`);
  // stored settings take precedence over the environment, and earlier specs saved some: map Pro to a Stripe price and a Razorpay plan
  await adminSettings((st) => { st.plans.pro!.stripePriceId = 'price_pro_e2e'; st.plans.pro!.razorpayPlanId = 'plan_pro_e2e'; delete st.plans.business!.razorpayPlanId; delete st.plans.business!.stripePriceId; });
});
test.afterAll(async () => {
  await adminSettings((st) => { delete st.plans.pro!.stripePriceId; delete st.plans.pro!.razorpayPlanId; }).catch(() => undefined);
  for (const p of kids) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } }
  await fake.stop();
});

test('a buyer picks Razorpay, pays, sees the plan, and can stop renewal; the plan ends when the period does', async ({ page }) => {
  await page.route('https://rzp.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Fake Razorpay checkout</h1>' })); // the hosted page is Razorpay's, not ours
  const email = uniqueEmail('rzp');
  await register(page, email, 'e2e-Passw0rd-original');
  const login = await (await fetch(`${api4}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'e2e-Passw0rd-original' }) })).json() as { data: { user: { id: string } } };
  const user = { data: { id: login.data.user.id } };

  // 1. the pricing page offers both gateways; choosing Razorpay sends the buyer to Razorpay's page, with the subscription created for them
  await page.goto('/pricing');
  const choice = page.getByRole('group', { name: 'Pay with' });
  await expect(choice.getByRole('radio')).toHaveCount(2);
  await expect(page.getByText(/Payments are handled by Stripe and Razorpay/)).toBeVisible();
  await axe(page, 'pricing with two gateways');
  await choice.getByRole('radio', { name: /Razorpay/ }).check();
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page.getByRole('heading', { name: 'Fake Razorpay checkout' })).toBeVisible();
  const created = fake.seen.find((r) => r.path === '/v1/subscriptions');
  expect(created?.body).toMatchObject({ plan_id: 'plan_pro_e2e', quantity: 1, notes: { userId: user.data.id, plan: 'pro' } });
  const subId = fake.lastId;

  // 2. nothing is granted by merely asking: still free until the payment arrives
  await page.goto('/account');
  await expect(page.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);

  // 3. the payment lands (Razorpay's signed webhook): the account shows the subscription, with no Stripe portal button
  await razorpayEvent(user.data.id, subId, 'active', 'subscription.activated');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Cancel subscription' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage billing' })).toHaveCount(0);
  await axe(page, 'account with a Razorpay subscription');

  // 4. cancelling asks first, then stops renewal and says the plan runs on
  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('button', { name: 'Cancel subscription' })).toBeVisible(); // backing out changed nothing
  expect(fake.seen.filter((r) => r.path.endsWith('/cancel'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  await page.getByRole('button', { name: 'Yes, cancel renewal' }).click();
  await expect(page.getByText(/will not renew; your plan runs until/)).toBeVisible();
  expect(fake.seen.filter((r) => r.path === `/v1/subscriptions/${subId}/cancel`).map((r) => r.body)).toEqual([{ cancel_at_cycle_end: 1 }]);
  await page.reload();
  await expect(page.getByText(/will not renew; your plan runs until/)).toBeVisible(); // it was recorded, not just shown

  // 5. the period ends: Razorpay says so, and the plan goes away
  await razorpayEvent(user.data.id, subId, 'completed', 'subscription.completed', Math.floor(Date.now() / 1000) + 5);
  await page.reload();
  await expect(page.getByText(/will not renew/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Upgrade' })).toBeVisible();
});

test('a failure to reach Razorpay is a plain message, not a stack trace, and nothing is charged or granted', async ({ page }) => {
  await register(page, uniqueEmail('rzpfail'), 'e2e-Passw0rd-original');
  await page.goto('/pricing');
  await page.getByRole('radio', { name: /Razorpay/ }).check();
  fake.failNext = { status: 400, code: 'BAD_REQUEST_ERROR', description: 'The plan id provided does not exist (internal)' };
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not start checkout');
  await expect(page.getByRole('alert')).not.toContainText(/internal|plan id/i);
  await expect(page).toHaveURL(/\/pricing/);
});
