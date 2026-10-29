import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Razorpay Subscriptions REST API, for tests: the REAL HttpRazorpay client talks to it over HTTP, so the
 * request shapes, auth header and error handling are exercised. It knows only the four calls we make, written from Razorpay's
 * public docs; it is NOT Razorpay (see docs: nothing here has run against the real service).
 */
export interface SeenRequest { method: string; path: string; auth: string | undefined; body: Record<string, unknown> }

export class FakeRazorpay {
  readonly keyId = 'rzp_test_key'; readonly keySecret = 'rzp_test_secret';
  seen: SeenRequest[] = [];
  /** Answer the next call with this error instead (Razorpay's `{error:{code,description}}` shape). */
  failNext: { status: number; code: string; description: string } | null = null;
  /** Real accounts without the Subscriptions product answer 401 {"error":"Unauthorized"} (a bare string) on /v1/subscriptions and /v1/plans while every other endpoint works. */
  subscriptionsEnabled = true;
  private subs = new Map<string, { id: string; plan_id: string; quantity: number; status: string; notes: unknown }>();
  private n = 0;
  /** The id of the subscription most recently created. */
  get lastId() { return `sub_fake${this.n}`; }
  private server!: Server; port = 0;

  async start() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get base() { return `http://127.0.0.1:${this.port}`; }
  async stop() { await new Promise((r) => this.server.close(r)); }
  reset() { this.seen = []; this.failNext = null; this.subscriptionsEnabled = true; }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const path = req.url ?? '';
    this.seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const expected = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    if (!this.subscriptionsEnabled && /^\/v1\/(subscriptions|plans)/.test(path)) return send(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && /^\/v1\/(orders|subscriptions)\?/.test(path)) return send(200, { entity: 'collection', count: 0, items: [] });
    if (this.failNext) { const f = this.failNext; this.failNext = null; return send(f.status, { error: { code: f.code, description: f.description } }); }
    if (req.method === 'POST' && path === '/v1/subscriptions') {
      if (typeof body.plan_id !== 'string' || typeof body.total_count !== 'number') return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'plan_id and total_count are required' } });
      const id = `sub_fake${++this.n}`;
      const s = { id, plan_id: body.plan_id, quantity: (body.quantity as number) ?? 1, status: 'created', notes: body.notes ?? [] };
      this.subs.set(id, s);
      return send(200, { ...s, short_url: `https://rzp.test/${id}`, customer_id: null });
    }
    const m = /^\/v1\/subscriptions\/([^/]+)(\/cancel)?$/.exec(path);
    const s = m ? this.subs.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m) return send(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
    if (!s) return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
    if (req.method === 'PATCH' && !m[2]) { s.quantity = body.quantity as number; return send(200, s); }
    if (req.method === 'POST' && m[2]) { s.status = body.cancel_at_cycle_end ? s.status : 'cancelled'; return send(200, s); }
    return send(405, { error: { code: 'BAD_REQUEST_ERROR', description: 'method not allowed' } });
  }
}
