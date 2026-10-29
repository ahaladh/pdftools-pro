import { z } from 'zod';
import { DEFAULT_GUEST_LIMITS } from '@pdftools/shared';

const num = (d: number) => z.coerce.number().default(d);
/**
 * An optional value where an empty `KEY=` (as .env.example ships for secrets the operator fills in, or an unset compose
 * variable) simply means "not set". Not used for settings where empty is a real answer: PREMIUM_TOOLS= means "no premium tools".
 */
const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());
/** Real boolean parsing: z.coerce.boolean() would turn the string "false" into true. */
const bool = (d: boolean) => z.enum(['true', 'false', '1', '0', 'yes', 'no', '']).default(d ? 'true' : 'false').transform((v) => (v === '' ? d : v === 'true' || v === '1' || v === 'yes'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(4000),
  BRAND_NAME: z.string().default('PDFTools Pro'),
  /** Comma-separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().default(0),
  /** HMAC secret for short-lived download links. Required in production. */
  DOWNLOAD_SECRET: optional(z.string().min(32)),
  DOWNLOAD_LINK_TTL_SECONDS: num(600),
  STORAGE_DIR: z.string().default('./data'),
  MAX_FILE_MB: num(DEFAULT_GUEST_LIMITS.maxFileBytes / 1024 / 1024),
  MAX_FILES: num(DEFAULT_GUEST_LIMITS.maxFiles),
  MAX_PAGES: num(DEFAULT_GUEST_LIMITS.maxPages),
  MAX_CONCURRENT_JOBS_PER_USER: num(DEFAULT_GUEST_LIMITS.maxConcurrentJobs),
  /** Jobs running at once across the whole process (inline queue). */
  WORKER_CONCURRENCY: num(2),
  JOB_TIMEOUT_SECONDS: num(DEFAULT_GUEST_LIMITS.jobTimeoutMs / 1000),
  RETENTION_MINUTES: num(DEFAULT_GUEST_LIMITS.retentionMinutes),
  CLEANUP_INTERVAL_SECONDS: num(60),
  RATE_LIMIT_WINDOW_SECONDS: num(600),
  RATE_LIMIT_MAX_PER_WINDOW: num(60),
  MAINTENANCE_MODE: bool(false),
  LOG_LEVEL: z.string().default('info'),

  // --- operations ---
  APP_VERSION: z.string().default('dev'),
  /** Bearer token for /metrics. In production /metrics is disabled unless this is set. */
  METRICS_TOKEN: optional(z.string().min(16)),
  /** On SIGTERM: report not-ready for this long so the load balancer stops sending traffic, then stop accepting. */
  SHUTDOWN_DRAIN_SECONDS: num(5),
  /** Then wait at most this long for in-flight requests and (inline mode) running jobs before exiting. */
  SHUTDOWN_GRACE_SECONDS: num(30),
  /** Port for the worker's /health, /ready and /metrics (0 = disabled). Bind to an internal interface only. */
  WORKER_HEALTH_PORT: num(0),

  /** auto = apply pending migrations at API start (lock-protected); check = refuse to start if any are pending; off = never. Workers never migrate. */
  MIGRATIONS: z.enum(['auto', 'check', 'off']).default('auto'),

  // --- job execution ---
  /** 'inline' runs jobs inside the API process; 'bullmq' enqueues to Redis for separate worker processes. */
  QUEUE_DRIVER: z.enum(['inline', 'bullmq']).default('inline'),
  REDIS_URL: z.string().optional(),
  /** Run each job in its own kernel-limited process (strongly recommended). */
  ISOLATE_JOBS: bool(true),
  /** Address-space cap for the whole job process (min 1536; engine caps must not exceed it). */
  ISOLATION_MEMORY_MB: num(4096),
  ENGINE_MEMORY_MB: num(2048),
  ENGINE_OFFICE_MEMORY_MB: num(4096),
  ENGINE_CPU_SECONDS: num(120),
  ENGINE_MAX_FILE_MB: num(1024),
  /** A processing job with no heartbeat for this long is failed as lost (worker crashed). */
  HEARTBEAT_STALE_SECONDS: num(30),
  /** A queued job nobody picked up for this long is failed. */
  QUEUE_TIMEOUT_SECONDS: num(900),
  /** Refuse new jobs when stored data exceeds this many MB (0 = unlimited). */
  MAX_STORAGE_MB: num(0),
  /** How long the stored-bytes figure is cached (seconds). */
  STORAGE_CACHE_SECONDS: num(10),
  RATE_LIMIT_ENABLED: bool(true),

  // --- accounts (enabled only when MONGODB_URI is set; otherwise guest-only mode) ---
  MONGODB_URI: z.string().optional(),
  /** HMAC secret for access tokens. Required (>=32 chars) in production when accounts are enabled. */
  JWT_ACCESS_SECRET: optional(z.string().min(32)),
  ACCESS_TOKEN_TTL_MINUTES: num(15),
  REFRESH_TOKEN_TTL_DAYS: num(30),
  /** Public origin of the site; used in emails and billing redirects. */
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  /**
   * WebAuthn relying party (security keys). Defaults: the hostname and origin of PUBLIC_URL. Change them only if the site is
   * served from several origins; a key registered under one RP ID never works under another.
   */
  WEBAUTHN_RP_ID: z.string().optional(),
  WEBAUTHN_ORIGINS: z.string().optional(),
  SMTP_URL: z.string().optional(),
  /**
   * Administrators must have a second sign-in step (authenticator app or security key) before the admin area opens.
   * Unset: on in production, off elsewhere (so development and tests work without enrolling). Set to false only briefly,
   * to recover when the only administrator has lost every factor.
   */
  REQUIRE_ADMIN_2FA: z.enum(['true', 'false', '1', '0', 'yes', 'no', '']).optional().transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1' || v === 'yes')),
  /** When on, an unverified email cannot start a paid checkout. Recommended in production. */
  REQUIRE_VERIFIED_EMAIL: bool(false),
  /** Seats per team plan (members plus pending invitations). A team without a subscription has one: its owner. */
  TEAM_SEATS_PRO: num(3),
  TEAM_SEATS_BUSINESS: num(10),
  /**
   * How a team pays. `flat`: one subscription at a flat price, seats from TEAM_SEATS_* (the default). `per_seat`: the plan's
   * Stripe price is charged *per seat* and the team's seats are the subscription's quantity (bounded by the two below).
   * Before switching an existing deployment, set the quantity of existing team subscriptions to the seats those teams have.
   */
  TEAM_BILLING: z.enum(['flat', 'per_seat']).default('flat'),
  TEAM_MIN_SEATS: num(2),
  TEAM_MAX_SEATS: num(100),
  TEAM_INVITE_TTL_DAYS: num(7),
  /**
   * Virus scanning of uploads with ClamAV (clamd). `off` (default): no scanning. `enforce`: every upload is scanned before any job
   * exists. If the scanner cannot answer, uploads are refused (AV_FAIL=closed, default) or allowed with a warning (open).
   * clamd's StreamMaxLength (25 MB by default) must be raised to the largest upload you allow, or bigger files are refused.
   */
  AV_MODE: z.enum(['off', 'enforce']).default('off'),
  AV_FAIL: z.enum(['closed', 'open']).default('closed'),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: num(3310),
  /** Unix socket of clamd; used instead of host/port when set. */
  CLAMD_SOCKET: optional(z.string()),
  AV_TIMEOUT_SECONDS: num(60),
  /** Batch processing: most files one batch job may take on each paid plan (0 turns batch off for that plan). Admins can change it at runtime. */
  BATCH_FILES_PRO: num(20),
  BATCH_FILES_BUSINESS: num(100),
  /** A batch gets `JOB_TIMEOUT_SECONDS` for each file, for at most this many files' worth in total. */
  BATCH_TIMEOUT_FACTOR: num(10),
  /** Talk to Stripe at this URL instead of api.stripe.com: for `stripe-mock` or a test double. Never set it in production. */
  STRIPE_API_BASE: optional(z.string().url()),
  VERIFY_TOKEN_TTL_HOURS: num(24),
  /** Encrypts two-factor secrets at rest. Falls back to JWT_ACCESS_SECRET; set it separately so rotating the JWT secret does not lock users out. */
  TWO_FACTOR_KEY: optional(z.string().min(32)),
  /**
   * Earlier values of TWO_FACTOR_KEY (or the JWT secret it replaced), comma-separated, only while rotating: secrets sealed
   * with them still open, new ones are sealed with the current key. Remove once `rotate-2fa status` shows nothing left on them.
   */
  TWO_FACTOR_KEY_PREVIOUS: z.string().optional().transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    .refine((l) => l.length <= 3 && l.every((k) => k.length >= 32), 'TWO_FACTOR_KEY_PREVIOUS: up to 3 keys, each at least 32 characters, comma-separated'),
  MAIL_FROM: z.string().default('PDFTools Pro <no-reply@localhost>'),
  /** Optional first-admin bootstrap: created at startup only if no user has this email. */
  ADMIN_EMAIL: optional(z.string().email()),
  ADMIN_PASSWORD: optional(z.string().min(12)),

  // --- billing (Stripe). Unset => billing endpoints report "not configured". ---
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  // --- billing (Razorpay): a second gateway beside Stripe, for sellers in India and buyers who pay by UPI, Indian cards or netbanking.
  // Needs the key pair AND the webhook secret. Unset => Razorpay is simply not offered. ---
  RAZORPAY_KEY_ID: optional(z.string().min(1)),
  RAZORPAY_KEY_SECRET: optional(z.string().min(1)),
  RAZORPAY_WEBHOOK_SECRET: optional(z.string().min(8)),
  /** Razorpay plan ids (dashboard > Subscriptions > Plans) that sell Pro and Business. Can also be set in the admin settings. */
  RAZORPAY_PLAN_PRO: optional(z.string().min(1)),
  RAZORPAY_PLAN_BUSINESS: optional(z.string().min(1)),
  /** Talk to Razorpay at this URL instead of api.razorpay.com: for a test double. Never set it in production. */
  RAZORPAY_API_BASE: optional(z.string().url()),

  // --- default entitlements (admin can override at runtime via settings) ---
  DAILY_OPS_GUEST: num(30),
  DAILY_OPS_FREE: num(60),
  /** Comma-separated tool ids that free/guest plans cannot use. */
  PREMIUM_TOOLS: z.string().default('office-to-pdf,redact,compare'),
});

export type Env = z.infer<typeof schema> & { DOWNLOAD_SECRET: string; JWT_ACCESS_SECRET: string; /** True when the secret was not supplied and a random per-process one is in use. */ GENERATED: { download: boolean; jwt: boolean } };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) {
    // One readable line per problem instead of a Zod stack trace.
    throw new Error(`Invalid configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const parsed = r.data;
  if (parsed.NODE_ENV === 'production' && !parsed.DOWNLOAD_SECRET) {
    throw new Error('DOWNLOAD_SECRET (>=32 chars) is required in production');
  }
  // In dev/test a random per-process secret is fine: links die on restart.
  const secret = parsed.DOWNLOAD_SECRET ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  if (parsed.QUEUE_DRIVER === 'bullmq' && (!parsed.REDIS_URL || !parsed.MONGODB_URI)) {
    throw new Error('QUEUE_DRIVER=bullmq requires REDIS_URL and MONGODB_URI (workers share job state through MongoDB)');
  }
  if (parsed.MONGODB_URI && parsed.NODE_ENV === 'production' && !parsed.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET (>=32 chars) is required in production when MONGODB_URI is set');
  }
  const jwt = parsed.JWT_ACCESS_SECRET ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  return { ...parsed, DOWNLOAD_SECRET: secret, JWT_ACCESS_SECRET: jwt, GENERATED: { download: !parsed.DOWNLOAD_SECRET, jwt: !parsed.JWT_ACCESS_SECRET } };
}
