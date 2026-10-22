import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import Stripe from 'stripe';
import mongoose from 'mongoose';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { register, uniqueEmail, watchConsole } from '../support/helpers';
import { API_PORT, ROOT, WEB_PORT, readState } from '../support/stack';

/**
 * Per-seat team billing in the browser, with the REAL Stripe SDK talking over HTTP to a small fake Stripe server (via
 * STRIPE_API_BASE). So what is asserted is what actually goes over the wire: form-encoded request parameters as Stripe would
 * receive them. Not covered, because it needs Stripe itself: that Stripe accepts them and that its portal/webhooks behave.
 */
const PW = 'e2e-Passw0rd-original';
const WEB3 = WEB_PORT + 20, API3 = API_PORT + 20, FAKE = API_PORT + 30;
const web3 = `http://localhost:${WEB3}`, api3 = `http://localhost:${API3}`, fakeUrl = `http://localhost:${FAKE}`;
const SECRET = 'whsec_e2e_seats';
test.use({ baseURL: web3 });
test.describe.configure({ mode: 'serial' });

// ---- the fake Stripe
interface Seen { method: string; path: string; form: Record<string, string>; auth: string | undefined }
const seen: Seen[] = [];
const fake = { quantity: 5, decline: false };
let server: Server;
const startFake = () => new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', fakeUrl);
      const form = Object.fromEntries(new URLSearchParams(raw));
      seen.push({ method: req.method ?? '', path: url.pathname, form, auth: req.headers.authorization });
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const subscription = () => ({ id: 'sub_e2e', object: 'subscription', status: 'active', items: { object: 'list', data: [{ id: 'si_e2e', object: 'subscription_item', quantity: fake.quantity }] } });
      if (req.method === 'POST' && url.pathname === '/v1/customers') return json(200, { id: 'cus_e2e', object: 'customer' });
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') return json(200, { id: 'cs_e2e', object: 'checkout.session', url: `${fakeUrl}/pay/cs_e2e` });
      if (req.method === 'GET' && url.pathname === '/v1/subscriptions/sub_e2e') return json(200, subscription());
      if (req.method === 'POST' && url.pathname === '/v1/subscriptions/sub_e2e') {
        if (fake.decline) return json(402, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } });
        fake.quantity = Number(form['items[0][quantity]']);
        return json(200, subscription());
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return void res.end(); }
      if (req.method === 'GET' && url.pathname.startsWith('/pay/')) { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<h1>Fake Stripe checkout</h1>'); }
      json(404, { error: { type: 'invalid_request_error', message: `no such fake route ${url.pathname}` } });
    });
  }).listen(FAKE, resolve);
});

// ---- a second API and web server: per-seat billing on, Stripe pointing at the fake
const kids: ChildProcess[] = [];
const up = async (url: string) => { for (let i = 0; i < 240; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`${url} did not come up`); };
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const db = async <T>(fn: (c: mongoose.Connection) => Promise<T>) => {
  const conn = await mongoose.createConnection(readState().env.MONGODB_URI!).asPromise();
  try { return await fn(conn); } finally { await conn.close(); }
};
const adminSettings = async (change: (s: { plans: Record<string, { stripePriceId?: string }> }) => void) => {
  const st = readState();
  const call = async (path: string, init: RequestInit = {}, token?: string) => (await (await fetch(`${api3}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json()) as { data: never };
  const { data: sess } = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: st.adminEmail, password: st.adminPassword }) }) as { data: { accessToken: string } };
  const { data: s } = await call('/api/admin/settings', {}, sess.accessToken) as { data: { plans: Record<string, { stripePriceId?: string }> } };
  change(s);
  await call('/api/admin/settings', { method: 'PUT', body: JSON.stringify(s) }, sess.accessToken);
};
/** What Stripe would send when the subscription changes (signed the way Stripe signs it). */
const stripeEvent = async (teamId: string, quantity: number, type = 'customer.subscription.created') => {
  const payload = JSON.stringify({ id: `evt_e2e_${Date.now()}_${Math.random()}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: {
    id: 'sub_e2e', customer: 'cus_e2e', status: 'active', metadata: { teamId }, cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
    items: { data: [{ id: 'si_e2e', quantity, price: { id: 'price_pro' } }] },
  } } });
  const header = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const r = await fetch(`${api3}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  expect(r.status).toBe(200);
};

test.beforeAll(async () => {
  test.setTimeout(150_000);
  const s = readState();
  await startFake();
  mkdirSync(join(ROOT, 'e2e/.logs'), { recursive: true });
  const out = createWriteStream(join(ROOT, 'e2e/.logs/seats-stack.log'));
  const start = (cmd: string, args: string[], env: Record<string, string>, cwd: string) => {
    const p = spawn(cmd, args, { cwd, env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout?.pipe(out); p.stderr?.pipe(out); kids.push(p);
  };
  start(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], {
    ...s.env, PORT: String(API3), CORS_ORIGINS: web3, PUBLIC_URL: web3, QUEUE_DRIVER: 'inline',
    STRIPE_SECRET_KEY: 'sk_test_fake_e2e', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: 'price_pro', STRIPE_API_BASE: fakeUrl,
    TEAM_BILLING: 'per_seat', TEAM_MIN_SEATS: '2', TEAM_MAX_SEATS: '20',
  }, join(ROOT, 'apps/api'));
  await up(`${api3}/health`);
  start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB3), '--strictPort', '--host', 'localhost'], { API_URL: api3 }, join(ROOT, 'apps/web'));
  await up(`${web3}/`);
  // stored settings take precedence over the environment, and an earlier spec saved some: make sure the Pro plan has its price
  await adminSettings((st) => { st.plans.pro!.stripePriceId = 'price_pro'; });
});
test.afterAll(async () => {
  await adminSettings((st) => { delete st.plans.pro!.stripePriceId; }).catch(() => undefined);
  for (const p of kids) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } }
  server?.close();
});

test('a team buys seats per seat, changes them later, and is told when the card is declined', async ({ page }) => {
  test.setTimeout(150_000);
  const mon = watchConsole(page);
  const email = uniqueEmail('seat-owner');
  await register(page, email, PW);
  await page.goto('/account');
  await page.getByLabel('What should the team be called?').fill('Acme Design');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Design' })).toBeVisible();
  // two more people are already in the team: it needs at least three seats
  const teamId = await db(async (c) => {
    const o = await c.collection('users').findOne({ email });
    const t = await c.collection('teams').findOne({ ownerId: o!._id });
    for (let i = 0; i < 2; i++) {
      const id = new mongoose.Types.ObjectId();
      await c.collection('users').insertOne({ _id: id, email: `seat-m${i}-${Date.now()}@example.com`, passwordHash: 'x', role: 'user', plan: 'free', status: 'active', createdAt: new Date(), updatedAt: new Date() });
      await c.collection('teammembers').insertOne({ teamId: t!._id, userId: id, role: 'member', createdAt: new Date(), updatedAt: new Date() });
    }
    return String(t!._id);
  });
  await page.reload();

  // choosing seats: never fewer than the people already there
  const billing = page.getByLabel('Team', { exact: true });
  const seats = billing.getByLabel('Seats to buy');
  await expect(seats).toHaveValue('3');
  await expect(billing).toContainText('Between 3 and 20');
  const subscribe = billing.getByRole('button', { name: /Subscribe team to Pro/ });
  await seats.fill('2'); await expect(subscribe).toBeDisabled();
  await seats.fill('21'); await expect(subscribe).toBeDisabled();
  await seats.fill('abc'); await expect(subscribe).toBeDisabled();
  await seats.fill('5'); await expect(subscribe).toBeEnabled();
  await expect(subscribe).toContainText('/month'); // an estimate from the plan's price
  await axe(page, 'per-seat checkout');

  // what the real SDK put on the wire for the checkout session
  await subscribe.click();
  await expect(page).toHaveURL(`${fakeUrl}/pay/cs_e2e`);
  const co = seen.find((r) => r.path === '/v1/checkout/sessions')!;
  expect(co.auth).toBe('Bearer sk_test_fake_e2e');
  expect(co.form).toMatchObject({
    mode: 'subscription', client_reference_id: `team:${teamId}`,
    'line_items[0][price]': 'price_pro', 'line_items[0][quantity]': '5',
    'line_items[0][adjustable_quantity][enabled]': 'true', 'line_items[0][adjustable_quantity][minimum]': '3', 'line_items[0][adjustable_quantity][maximum]': '20',
    'subscription_data[metadata][teamId]': teamId, 'subscription_data[metadata][plan]': 'pro',
  });

  // Stripe tells us the team subscribed with five seats
  fake.quantity = 5;
  await stripeEvent(teamId, 5);
  await page.goto('/account');
  await expect(billing.getByLabel('Seats', { exact: true }).first()).toContainText('3 of 5 seats used');
  await expect(billing).toContainText('Subscription active');

  // changing seats: the owner sees what is allowed, and what goes to Stripe is a prorated update of the existing item
  const change = billing.getByRole('textbox', { name: /^Seats/ });
  const update = billing.getByRole('button', { name: 'Update seats' });
  await expect(change).toHaveValue('5');
  await expect(update).toBeDisabled(); // unchanged
  await change.fill('2'); await expect(update).toBeDisabled(); // fewer than the people already there
  await change.fill('25'); await expect(update).toBeDisabled();
  await change.fill('8'); await update.click();
  await expect(billing.getByLabel('Seats', { exact: true }).first()).toContainText('3 of 8 seats used');
  const up1 = seen.filter((r) => r.method === 'POST' && r.path === '/v1/subscriptions/sub_e2e').at(-1)!;
  expect(up1.form).toEqual({ 'items[0][id]': 'si_e2e', 'items[0][quantity]': '8', proration_behavior: 'create_prorations', payment_behavior: 'error_if_incomplete' });
  await axe(page, 'seat change');

  // a declined card: the seat count stays, and the person is told why in plain words
  fake.decline = true;
  await change.fill('12'); await update.click();
  await expect(page.getByRole('alert').filter({ hasText: 'card on file was declined' })).toBeVisible();
  await expect(billing.getByLabel('Seats', { exact: true }).first()).toContainText('3 of 8 seats used');
  fake.decline = false;

  expect(mon.problems.filter((p) => !/status of (402)/.test(p))).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});
