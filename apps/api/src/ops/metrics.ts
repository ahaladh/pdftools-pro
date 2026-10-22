import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. One registry per process (not the global one) so tests can run several apps.
 * Label values are all low-cardinality: tool ids, fixed outcomes, route *patterns* (never raw paths or ids).
 */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration = new Histogram({ name: 'pdftools_http_request_duration_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120], registers: [this.registry] });
  readonly jobsTotal = new Counter({ name: 'pdftools_jobs_total', help: 'Finished jobs', labelNames: ['tool', 'outcome'], registers: [this.registry] });
  readonly jobFailures = new Counter({ name: 'pdftools_job_failures_total', help: 'Failed jobs by error code', labelNames: ['code'], registers: [this.registry] });
  readonly jobDuration = new Histogram({ name: 'pdftools_job_duration_seconds', help: 'Time from claim to outcome', labelNames: ['tool'], buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300], registers: [this.registry] });
  readonly reaped = new Counter({ name: 'pdftools_reaped_jobs_total', help: 'Jobs failed by the reaper', labelNames: ['code'], registers: [this.registry] });
  readonly apiErrors = new Counter({ name: 'pdftools_api_errors_total', help: 'Error responses by code', labelNames: ['code', 'status'], registers: [this.registry] });
  readonly auditEvents = new Counter({ name: 'pdftools_audit_events_total', help: 'Audit events (logins, resets, admin changes...)', labelNames: ['action'], registers: [this.registry] });
  readonly avScans = new Counter({ name: 'pdftools_av_scans_total', help: 'Uploaded files by virus-scan result (clean, infected, error, error_allowed)', labelNames: ['result'], registers: [this.registry] });
  readonly queueDepth = new Gauge({ name: 'pdftools_queue_jobs', help: 'Jobs in the queue by state', labelNames: ['state'], registers: [this.registry] });
  readonly storageBytes = new Gauge({ name: 'pdftools_storage_bytes', help: 'Bytes held in job storage', registers: [this.registry] });
  readonly storageLimitBytes = new Gauge({ name: 'pdftools_storage_limit_bytes', help: 'Configured storage cap (MAX_STORAGE_MB); 0 = unlimited', registers: [this.registry] });
  readonly running = new Gauge({ name: 'pdftools_jobs_running', help: 'Jobs executing in this process', registers: [this.registry] });
  readonly draining = new Gauge({ name: 'pdftools_draining', help: '1 while the process is shutting down', registers: [this.registry] });
  readonly buildInfo = new Gauge({ name: 'pdftools_build_info', help: 'Build information', labelNames: ['version', 'role'], registers: [this.registry] });

  constructor(role: 'api' | 'worker', version: string, collect?: () => Promise<void>) {
    collectDefaultMetrics({ register: this.registry, prefix: 'pdftools_' });
    this.buildInfo.set({ version, role }, 1);
    // Gauges that need I/O are refreshed at scrape time, never on a timer.
    if (collect) {
      const orig = this.registry.metrics.bind(this.registry);
      this.registry.metrics = async () => { await collect().catch(() => undefined); return orig(); };
    }
  }

  /** Express middleware recording latency per route pattern. */
  httpMiddleware(): RequestHandler {
    return (req, res, next) => {
      const end = this.httpDuration.startTimer();
      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}` : 'unmatched';
        end({ method: req.method, route, status: String(res.statusCode) });
      });
      next();
    };
  }
}

/** /metrics handler. In production it is disabled unless METRICS_TOKEN is set, and then requires it. */
export function metricsHandler(m: Metrics, opts: { production: boolean; token?: string }): RequestHandler {
  return async (req, res) => {
    if (opts.production && !opts.token) return void res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Resource not found' } });
    if (opts.token) {
      const got = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
      const want = Buffer.from(opts.token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return void res.status(401).set('WWW-Authenticate', 'Bearer').json({ ok: false, error: { code: 'unauthorized', message: 'Metrics token required' } });
    }
    res.set('Content-Type', m.registry.contentType).set('Cache-Control', 'no-store').send(await m.registry.metrics());
  };
}
