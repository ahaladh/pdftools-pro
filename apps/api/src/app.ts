import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import Stripe from 'stripe';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { PLAN_IDS, TOOLS, type PublicConfig } from '@pdftools/shared';
import { loadEnv, type Env } from './config/env.js';
import { connectDb } from './db/models.js';
import { errorHandler, notFound, ok } from './middleware/common.js';
import { HttpError } from './utils/errors.js';
import { MemoryJobStore, type JobStore } from './modules/jobs/types.js';
import { MongoJobStore } from './modules/jobs/mongo-store.js';
import { JobService } from './modules/jobs/service.js';
import { JobRunner } from './modules/jobs/runner.js';
import { BullQueue, InlineQueue, type JobQueue } from './modules/jobs/queue.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { pdfRoutes } from './modules/pdf/routes.js';
import { buildOpenApi } from './modules/openapi.js';
import { MemoryUsageStore, MongoUsageStore } from './modules/usage/store.js';
import { Entitlements } from './modules/usage/entitlements.js';
import { MemorySettingsStore, MongoSettingsStore, SettingsService } from './modules/settings/service.js';
import { defaultSettings } from './modules/settings/defaults.js';
import { identity } from './modules/auth/middleware.js';
import { authRoutes, setRefreshCookie } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { adminTwoFactorRequired } from './modules/auth/policy.js';
import { SecurityKeyService } from './modules/auth/webauthn.js';
import { AuditService } from './modules/auth/audit.js';
import { accountRoutes } from './modules/account/routes.js';
import { BillingService, type StripeClient } from './modules/billing/service.js';
import { billingRoutes, webhookRoute } from './modules/billing/routes.js';
import { TeamService } from './modules/teams/service.js';
import { teamRoutes } from './modules/teams/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import mongoose from 'mongoose';
import { assertSchemaNotNewer, migrationStatus, runMigrations } from './db/migrations.js';
import { Metrics, metricsHandler } from './ops/metrics.js';
import { runChecks, storageCheck, type Check } from './ops/health.js';
import { ConsoleMailer, SmtpMailer, UnconfiguredMailer, type Mailer } from './modules/mail/mailer.js';

export interface AppDeps { env?: Env; store?: JobStore; log?: Logger; mailer?: Mailer; stripe?: StripeClient | null }

/** Point the Stripe SDK at another host (Stripe's own `stripe-mock`, or a test double); unset means the real Stripe API. */
function stripeHost(base: string | undefined): Stripe.StripeConfig | undefined {
  if (!base) return undefined;
  const u = new URL(base);
  return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80'), protocol: u.protocol === 'https:' ? 'https' : 'http' };
}

export async function createApp(deps: AppDeps = {}) {
  const env = deps.env ?? loadEnv();
  const log = deps.log ?? pino({ level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] });
  const accounts = !!env.MONGODB_URI;
  if (accounts) {
    await connectDb(env.MONGODB_URI!);
    // Refuse to run older code against a newer schema (a rollback without restoring data); then migrate per policy.
    await assertSchemaNotNewer();
    if (env.MIGRATIONS === 'auto') await runMigrations(log);
    else if (env.MIGRATIONS === 'check') { const s = await migrationStatus(); if (s.pending.length) throw new Error(`pending database migrations: ${s.pending.join(', ')}. Run "node dist/migrate.js up" first.`); }
  }

  // Gauges needing I/O are refreshed at scrape time; `jobs` is assigned below, before the first scrape can happen.
  let jobs!: JobService;
  const metrics = new Metrics('api', env.APP_VERSION, async () => {
    const q = await jobs.queueStats().catch(() => null);
    if (q) { metrics.queueDepth.set({ state: 'waiting' }, q.waiting); metrics.queueDepth.set({ state: 'active' }, q.active); }
    metrics.storageBytes.set(await jobs.storageBytes().catch(() => 0));
    metrics.storageLimitBytes.set(env.MAX_STORAGE_MB * 1024 * 1024);
    metrics.running.set(jobs.runner?.activeCount ?? 0);
    metrics.draining.set(state.draining ? 1 : 0);
  });
  const state = { draining: false };

  const usage = accounts ? new MongoUsageStore() : new MemoryUsageStore();
  const jobStore: JobStore = deps.store ?? (accounts ? new MongoJobStore() : new MemoryJobStore());
  const settings = new SettingsService(accounts ? new MongoSettingsStore() : new MemorySettingsStore(), defaultSettings(env), 3000, log);
  // 'inline' processes jobs in this process; 'bullmq' only enqueues and separate workers (worker.ts) process.
  const runner = env.QUEUE_DRIVER === 'inline' ? new JobRunner(env, jobStore, usage, log, metrics) : null;
  const queue: JobQueue = runner ? new InlineQueue(runner, () => env.WORKER_CONCURRENCY) : new BullQueue(env.REDIS_URL!);
  jobs = new JobService(env, jobStore, log, queue, runner, metrics);
  await jobs.init();
  const entitlements = new Entitlements(settings, usage, jobStore, env.MAX_STORAGE_MB > 0 ? async () => (await jobs.storageBytes()) / 1048576 : undefined, env.MAX_STORAGE_MB);
  const audit = new AuditService(log, accounts, metrics);

  const mailer: Mailer = deps.mailer ?? (env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : env.NODE_ENV === 'production' ? new UnconfiguredMailer() : new ConsoleMailer(log));
  const stripe: StripeClient | null = deps.stripe !== undefined ? deps.stripe : env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, stripeHost(env.STRIPE_API_BASE)) : null;
  const billing = new BillingService(env, settings, log, accounts ? stripe : null);

  const mongoJobs = jobStore instanceof MongoJobStore ? jobStore : null;
  const teams = new TeamService(env, mailer, audit, log, { cancelSubscription: (t) => billing.cancelForDeletion(t) }, usage, settings);
  const auth = new AuthService(env, mailer, audit, log, {
    cancelSubscription: (u) => billing.cancelForDeletion(u),
    leaveTeam: (u) => teams.onAccountDeletion(u),
    deleteUserData: async (owner) => {
      if (mongoJobs) { for (const j of await mongoJobs.listByOwner(owner)) await jobs.expire(j, 'user'); await mongoJobs.deleteByOwner(owner); }
      await usage.deleteKey(owner);
      await usage.deleteMemberUsage(owner.replace(/^u:/, ''));
    },
  });
  const securityKeys = new SecurityKeyService(env, auth, audit);
  if (accounts) await auth.seedAdmin();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(pinoHttp({
    logger: log,
    // One id per request, end to end: adopt the proxy's X-Request-Id when it looks sane (it is client-influenced, so it
    // is validated, never trusted blindly), otherwise mint one. It is echoed in the response for support/debugging.
    genReqId: (req, res) => {
      const h = req.headers['x-request-id'];
      const id = typeof h === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(h) ? h : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Log method/route/status only: never query strings (signed tokens) or bodies.
    serializers: { req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }), res: (r) => ({ statusCode: r.statusCode }) },
  }));
  app.use(metrics.httpMiddleware());
  // HSTS matches the policy nginx applies to the static site (2 years, subdomains) so the browser sees one consistent policy.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' }, hsts: { maxAge: 63072000, includeSubDomains: true } }));
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-PDFTools-CSRF'] }));

  // Stripe needs the exact raw bytes to verify its signature, so this precedes every body parser.
  // No identity, cookies or CORS reliance: the signature is the credential.
  if (accounts) app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), webhookRoute(billing));

  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));

  // Liveness: the process is up and its event loop answers. No dependencies, so a database blip never restarts the app.
  app.get('/health', (_req, res) => { res.json({ status: 'ok', version: env.APP_VERSION, uptimeSeconds: Math.round(process.uptime()) }); });
  // Readiness: safe to receive traffic? Fails while draining or when a dependency is down, so a load balancer stops routing here.
  const readiness: Check[] = [storageCheck(jobs.root)];
  if (accounts) readiness.push({ name: 'mongo', run: async () => { await mongoose.connection.db!.admin().ping(); } });
  if (queue.ping) readiness.push({ name: 'redis', run: () => queue.ping!() });
  app.get('/ready', async (_req, res) => {
    if (state.draining) return void res.status(503).json({ status: 'draining' });
    const r = await runChecks(readiness);
    res.status(r.ok ? 200 : 503).json({ status: r.ok ? 'ready' : 'unavailable', checks: r.checks });
  });
  // Prometheus scrape endpoint at the root (not under /api), so a reverse proxy that only forwards /api never exposes it.
  app.get('/metrics', metricsHandler(metrics, { production: env.NODE_ENV === 'production', token: env.METRICS_TOKEN }));

  const limiter = (windowS: number, max: number) => rateLimit({
    windowMs: windowS * 1000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    handler: (_req, res) => { res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } }); },
  });

  app.use('/api', limiter(env.RATE_LIMIT_WINDOW_SECONDS, env.RATE_LIMIT_MAX_PER_WINDOW), identity(env, accounts));

  app.get('/api/config', async (_req, res) => {
    const s = await settings.get();
    const g = s.plans.guest;
    const cfg: PublicConfig = {
      brand: env.BRAND_NAME, maintenance: s.maintenance,
      limits: { maxFileMB: g.maxFileMB, maxFiles: g.maxFiles, maxPages: g.maxPages, retentionMinutes: g.retentionMinutes },
      features: { accounts, billing: billing.enabled, adminTwoFactor: adminTwoFactorRequired(env), teamBilling: env.TEAM_BILLING },
    };
    ok(res, cfg);
  });
  app.get('/api/tools', async (_req, res) => {
    const s = await settings.get();
    ok(res, TOOLS.filter((t) => !s.disabledTools.includes(t.id)).map(({ options: _o, ...t }) => ({ ...t, premium: s.plans.free.blockedTools.includes(t.id) })));
  });
  app.get('/api/plans', async (_req, res) => {
    const s = await settings.get();
    ok(res, PLAN_IDS.map((id) => { const { stripePriceId, ...p } = s.plans[id]; return { ...p, purchasable: billing.enabled && !!stripePriceId && p.priceCents > 0 }; }));
  });

  const disabled = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(new HttpError(503, 'accounts_disabled', 'Accounts are not enabled on this server.'));
  if (accounts) {
    app.use('/api/auth', limiter(600, 40), authRoutes(env, auth, securityKeys));
    app.use('/api/me', accountRoutes({ auth, securityKeys, jobs, usage, settings, refreshCookie: (res, s) => setRefreshCookie(env, res, s) }));
    app.use('/api/billing', billingRoutes(billing, { requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL, teamOf: (u) => teams.context(u), seatFloor: (t) => teams.seatFloor(t) }));
    app.use('/api/teams', teamRoutes(teams));
    app.use('/api/admin', adminRoutes({ teams, env, jobs, jobStore: jobStore as MongoJobStore, settings, audit, auth }));
  } else {
    for (const p of ['/api/auth', '/api/me', '/api/billing', '/api/teams', '/api/admin']) app.use(p, disabled);
  }

  app.use('/api/pdf', pdfRoutes(env, jobs, entitlements));
  app.use('/api/jobs', jobRoutes(jobs));
  app.use('/api/files', fileRoutes(env, jobs));
  if (env.NODE_ENV !== 'production') app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(buildOpenApi(env.BRAND_NAME)));
  app.get('/api/openapi.json', (_req, res) => { res.json(buildOpenApi(env.BRAND_NAME)); });

  app.use(notFound);
  app.use(errorHandler(log, (code, status) => metrics.apiErrors.inc({ code, status: String(status) })));
  return { app, jobs, env, settings, usage, auth, billing, mailer, metrics, setDraining: (v = true) => { state.draining = v; }, close: async () => { await queue.close(); } };
}
