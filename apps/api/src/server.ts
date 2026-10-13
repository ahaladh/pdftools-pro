import { createApp } from './app.js';

// Startup failures (bad configuration, unreachable database, pending migrations) must read as one clear line, not a stack trace.
const ctx = await createApp().catch((e: Error) => { console.error(`FATAL: could not start: ${e.message}`); process.exit(1); });
const { app, jobs, env } = ctx;
const sweeper = jobs.startSweeper();
const server = app.listen(env.PORT, () => console.log(`API listening on :${env.PORT} (version ${env.APP_VERSION})`));
server.requestTimeout = 10 * 60_000; // long enough for slow uploads of max-size files
server.keepAliveTimeout = 65_000;    // above typical load-balancer idle timeouts (60 s) to avoid 502s on reused connections

/**
 * Graceful shutdown (SIGTERM from systemd/Docker/Kubernetes):
 *  1. report not-ready so the load balancer drains us, and keep serving for SHUTDOWN_DRAIN_SECONDS;
 *  2. stop accepting connections and let in-flight requests finish;
 *  3. in inline mode, give running jobs time to finish (anything left is failed by the reaper after the restart);
 *  4. exit; a hard timeout guarantees we never hang the orchestrator.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received: draining`);
  ctx.setDraining(true);
  clearInterval(sweeper);
  const hard = setTimeout(() => { console.error('graceful shutdown timed out; exiting'); process.exit(1); }, (env.SHUTDOWN_DRAIN_SECONDS + env.SHUTDOWN_GRACE_SECONDS) * 1000);
  hard.unref();
  await new Promise((r) => setTimeout(r, env.SHUTDOWN_DRAIN_SECONDS * 1000));
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
  const until = Date.now() + env.SHUTDOWN_GRACE_SECONDS * 1000;
  while (jobs.runner && jobs.runner.activeCount > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  await ctx.close().catch(() => undefined);
  console.log('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
