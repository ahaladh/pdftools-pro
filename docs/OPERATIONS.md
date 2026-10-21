# Operations guide

Day-2 operations for a running deployment: what to watch, what the alerts mean, how to recover, how to upgrade.
Deployment itself is in [DEPLOYMENT.md](DEPLOYMENT.md); security posture in [SECURITY.md](SECURITY.md).

## The moving parts

| Component | What it does | Listens on | State |
|---|---|---|---|
| nginx | TLS, static site, edge rate limits, proxies `/api` | 80, 443 | none |
| API (`apps/api/dist/server.js`) | uploads, auth, billing, admin, job status/downloads | 4000 (internal) | none (stateless) |
| Worker (`apps/api/dist/worker.js`) | runs jobs in isolated, resource-limited child processes | health/metrics on 9101+ (internal) | none |
| Redis | job queue | 6379 (internal) | queue only; AOF on |
| MongoDB | users, sessions, settings, job metadata, usage, audit | 27017 (internal) | **everything durable** |
| Storage volume | uploaded inputs (minutes) and results (retention) | n/a | transient |

Only 80/443 may be reachable from the internet. Metrics, health ports, Redis and MongoDB are internal.

## Health and readiness

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /health` (API), `/healthz` via nginx | The process is up. No dependency checks, so a database blip never causes restarts. | liveness probes, uptime monitors |
| `GET /ready` (API, internal only) | Storage writable, MongoDB and Redis reachable, not draining. `503` otherwise, with per-check status (`ok`/`failed`/`timeout`). | load balancer / orchestrator readiness |
| Worker `/health`, `/ready`, `/metrics` on `WORKER_HEALTH_PORT` | Same, for workers (also fails once draining). | worker supervision |

On `SIGTERM` the API reports `draining` on `/ready` for `SHUTDOWN_DRAIN_SECONDS`, then stops accepting connections, then
waits up to `SHUTDOWN_GRACE_SECONDS` for in-flight requests (and inline-mode jobs). Workers stop taking jobs and finish the
ones running. Set your orchestrator's stop timeout above the sum (compose and the systemd units use 45 s / 60 s).

## Logs

* JSON, one object per line (pino for the apps, `pdftools_json` format for nginx). Ship them with journald, the Docker
  logging driver, or Loki/ELK; do not let them fill the disk (see rotation below).
* **Request ids**: nginx creates `$request_id`, passes it as `X-Request-Id`, the API adopts it (validated) and returns it. A user
  who reports a problem can send the `X-Request-Id` from their browser's network tab: grep it in nginx and API logs.
* **Never in logs**: file contents, filenames, passwords, tokens, query strings (download links carry a signed token; nginx logs
  `$uri` only). The audit collection in MongoDB records security-relevant events (logins, resets, admin changes) with actor and IP.
* Rotation: Docker `json-file` with `max-size: 50m, max-file: 5` per service, or journald `SystemMaxUse=2G`. For nginx files on a
  VPS, the distro's `logrotate` config for `/var/log/nginx/*.log` with `postrotate` `nginx -s reopen`.

## Metrics and alerts

`/metrics` is Prometheus text format on the API and each worker's internal port, token-protected (`METRICS_TOKEN`; disabled in
production if unset). Use [`infrastructure/monitoring/prometheus.yml`](../infrastructure/monitoring/prometheus.yml) and
[`alerts.yml`](../infrastructure/monitoring/alerts.yml). A test fails if an alert references a metric or label that the code
does not expose, so alerts cannot silently rot. Key series:

| Metric | Why you care |
|---|---|
| `pdftools_queue_jobs{state}` | backlog (`waiting`) and load (`active`) |
| `pdftools_jobs_total{tool,outcome}`, `pdftools_job_failures_total{code}` | throughput and failure causes |
| `pdftools_job_duration_seconds` | processing time per tool |
| `pdftools_reaped_jobs_total{code}` | `worker_lost` / `queue_timeout`: crashes and missing workers |
| `pdftools_http_request_duration_seconds{route,status}` | latency and 5xx by route *pattern* |
| `pdftools_storage_bytes`, `pdftools_storage_limit_bytes` | disk pressure (`MAX_STORAGE_MB`) |
| `pdftools_audit_events_total{action}` | login failures, resets, admin actions |
| `pdftools_process_*`, `pdftools_nodejs_*` | memory, CPU, event-loop lag |

The admin dashboard (Overview tab) shows live queue, running jobs, storage and system load without Prometheus.

## Runbooks

First step for any incident: `node apps/api/dist/doctor.js` (add `--deep` to also convert a document under the production
limits) and `node infrastructure/scripts/smoke.mjs https://your.domain`.

### API down

Alerts: `PdfToolsApiDown`, `PdfToolsPublicProbeFailing`.
1. `curl -i http://127.0.0.1:4000/health` on the host. No answer: `systemctl status pdftools-api` / `docker compose ps api`, then the last 100 log lines (`journalctl -u pdftools-api -n 100` / `docker compose logs --tail 100 api`).
2. A line starting `FATAL: could not start:` names the cause: invalid configuration (lists each variable), unreachable MongoDB/Redis, a failed migration, or "database has migrations this version does not know" (you are running older code against a newer database: deploy the newer version or restore a pre-upgrade backup).
3. `/health` ok but the public probe fails: nginx or TLS. `nginx -t`, certificate expiry (`openssl s_client -connect host:443 | openssl x509 -noout -dates`), firewall, DNS.
4. `/health` ok, `/ready` 503: read the `checks` object; the failing dependency is named (`storage`, `mongo`, `redis`).

### No workers

Alert: `PdfToolsNoWorkers`. Uploads still succeed and jobs queue; users see "Waiting in queue" and, after `QUEUE_TIMEOUT_SECONDS` (15 min), a `queue_timeout` failure.
1. Start/inspect workers: `systemctl status 'pdftools-worker@*'` / `docker compose ps worker`; `docker compose up -d --scale worker=2`.
2. Workers log `worker started` on boot; a `FATAL: could not start worker:` line gives the reason (usually Redis/MongoDB URL).
3. Verify the same `STORAGE_DIR` volume is mounted in API and workers; otherwise jobs complete but downloads 404.

### Queue backlog

Alert: `PdfToolsQueueBacklog`.
1. Is the queue draining? `pdftools_queue_jobs{state="active"}` should equal workers × `WORKER_CONCURRENCY`. If active is 0, see *No workers*.
2. Genuinely busy: add workers (`--scale worker=N` or more `pdftools-worker@N` units). CPU-heavy tools (Office conversion, high-DPI rendering, redaction) dominate; check `pdftools_job_duration_seconds` by tool.
3. One user flooding: admin → Jobs tab, filter by owner; lower that plan's `maxConcurrentJobs`/`dailyOps` in Settings, or disable the user.

### Job failures

Alert: `PdfToolsHighJobFailureRatio`.
1. `pdftools_job_failures_total` by `code`: `invalid_pdf`/`encrypted_pdf`/`unsupported_type` are user files; `resource_limit` is memory/CPU limits; `timeout` is `JOB_TIMEOUT_SECONDS`; `engine_failed`/`internal_error` are real faults; `tool_unavailable` means an engine is missing on that host.
2. `engine_failed` or `tool_unavailable` after a deploy: `node apps/api/dist/doctor.js --deep` on the failing host; compare engine versions.
3. `resource_limit` spike from legitimate files: raise `ISOLATION_MEMORY_MB`/`ENGINE_*` (container memory must cover `WORKER_CONCURRENCY × ISOLATION_MEMORY_MB` in the worst case). From abuse: see *Login attack*'s admin steps and tighten limits.

### Lost jobs

Alert: `PdfToolsWorkerLostJobs`. A job's runner stopped heartbeating (process killed). Causes: OOM killer (check `dmesg -T | grep -i kill` and container memory limits), a deploy that hard-killed workers (stop timeout too low), a host reboot.
1. Confirm graceful stops: workers should log `finishing running jobs` then `worker stopped`. If the orchestrator SIGKILLs first, raise `TimeoutStopSec`/`stop_grace_period`.
2. OOM: lower `WORKER_CONCURRENCY` or raise memory. Job processes are themselves capped (`ISOLATION_MEMORY_MB`), so an OOM kill points at an under-sized host or container.
Affected users saw "Processing was interrupted" and can retry; no data is lost (inputs are deleted only after a terminal state).

### API errors

Alert: `PdfToolsHigh5xxRate`. `pdftools_api_errors_total{code,status}` and the logs (filter `"level":50`) show which error. `internal_error` carries a stack in the API log (never in the response). A MongoDB or Redis outage shows as `queue_unavailable` (503) and a failing `/ready`.

### Login attack

Alert: `PdfToolsLoginAttack`. Accounts lock for 15 minutes after 5 failures and nginx limits `/api/auth/` per IP, so this is mostly noise, but check for a distributed attack: admin → Audit log, filter `auth.login_failed`. Block source ranges in the firewall/nginx; consider lowering `limit_req` rates. Never reveal whether an email exists. After a suspected credential leak, disable the account (admin → Users) and ask the user to reset the password.

### A user is locked out of two-step verification

They have lost their phone **and** their recovery codes. First make sure the request is genuine: this is the path an attacker would use, so confirm identity through something other than the account's own email if at all possible (a known contact, a support ticket history, payment details). Then admin → Users → find them → **Reset** in the *2-step* column. It turns 2FA off, signs them out everywhere and is recorded in the audit log (`auth.2fa_reset_by_admin`, with your user id). Tell them to turn it on again and save new recovery codes.

**An administrator is locked out of the admin area** (the page says to turn on two-step sign-in, and they cannot): they can still sign in and open their account page to enrol an authenticator app or a security key; nothing else is needed. If the **only** administrator lost their factors and recovery codes, no one can reset them from the UI. Break glass: set `REQUIRE_ADMIN_2FA=false` and restart the API, sign in as that administrator, enrol a new factor on the account page, then **remove the setting and restart**. `doctor` warns for as long as it is off in production. With several administrators, ask another one to use *Reset two-step verification* on the Users tab instead (audited).

If **security keys** stop working for everyone at once after a domain or proxy change, the RP ID or origin no longer matches what the keys were registered under (`doctor` flags a mismatch). Restore the old `PUBLIC_URL`/`WEBAUTHN_RP_ID`, or have users sign in with a recovery code and register their keys again. A single user who lost their key and their recovery codes needs the admin 2FA reset, which also removes their keys.

If **everyone** with 2FA is suddenly unable to sign in with a valid code, the encryption key probably changed: `TWO_FACTOR_KEY` (or `JWT_ACCESS_SECRET` if that is what you rely on) no longer matches what the secrets were sealed with. Restore the old value. There is no re-encryption tool yet, so do not rotate the key without one.

### Team questions

* *"My teammate cannot join."* The invitation only works for the signed-in account whose **confirmed** email matches the address it was sent to (look for `team.invited` and a failed accept in the log); a person can be in only one team at a time; and there must be a free seat.
* *"The owner left the company / is unreachable."* There is no admin override for team ownership yet. A member who is an admin cannot take it, so the owner must transfer it. If that is impossible, handle it as an account-recovery case (verify identity first), then change the owner directly in the `teams` and `teammembers` collections.
* *Seats do not match the plan after a price change:* seats come from `TEAM_SEATS_*`, not from Stripe. Lowering them never evicts members; it only blocks new invitations.

### Storage

Alert: `PdfToolsStorageNearlyFull`. Results are deleted at retention; inputs immediately after processing.
1. `du -sh $STORAGE_DIR/jobs/*` shows what is large. A sweeper runs every `CLEANUP_INTERVAL_SECONDS`; directories with no job record are removed after a 10-minute grace.
2. Lower `retentionMinutes` for plans (admin → Settings), or raise the disk. At `MAX_STORAGE_MB` new uploads get `503 storage_full` (existing results stay downloadable).
3. Disk completely full: free space first (delete old directories under `jobs/` whose job is `expired` in the admin Jobs tab), then restart workers.

## Backups and recovery

**What is backed up**: MongoDB (users, sessions, plans/settings, job metadata, usage, audit). **Not backed up, by design**: the storage volume (transient files), Redis (queue only).

* Schedule: `pdftools-backup.timer` (daily 02:30, `Persistent=true`) or cron/compose running
  [`infrastructure/scripts/backup.sh`](../infrastructure/scripts/backup.sh). It writes `pdftools-<UTC timestamp>.archive.gz` plus a `.sha256`, takes a lock so runs never overlap, prunes beyond `RETENTION_DAYS`, and keeps credentials out of the process list.
* **Copy backups off the machine** (object storage, another host) and encrypt them at that layer: archives contain password hashes and personal data. A backup that lives only on the database host does not survive that host.
* **Restore** ([`restore.sh`](../infrastructure/scripts/restore.sh)): verifies the checksum, refuses to overlay a populated database unless `--drop`.
  1. Stop the API and workers.
  2. `MONGODB_URI=... ./restore.sh /path/archive.gz --drop`
  3. Start the API (migrations run if the archive is older than the code), run `doctor` and `smoke`.
* **Drill, monthly**: `./restore.sh <latest> --scratch pdftools_drill` restores into a throwaway database without touching production; compare counts, then drop it. The automated test suite performs a full destroy-and-restore drill against a real MongoDB on every run.
* Targets: RPO = time since the last backup (up to 24 h with the daily timer; run it more often if you need less). RTO = restore time plus start-up (minutes for a small database).

| Failure | Impact | Recovery |
|---|---|---|
| API/worker host dies | uploads/processing stop | redeploy from images; state is in MongoDB/Redis; jobs in flight are failed (`worker_lost`) and can be retried |
| Redis lost | queued jobs vanish | their records time out as `queue_timeout`; users retry. Nothing durable is lost |
| MongoDB lost/corrupt | accounts, settings, history gone | restore the latest backup (above); sessions issued after the backup are invalid (users sign in again) |
| Storage volume lost | undelivered results gone | users re-run; nothing else depends on it |
| `JWT_ACCESS_SECRET` leaked | forged access tokens possible | rotate it (below); everyone is signed out |
| `DOWNLOAD_SECRET` leaked | download links forgeable for owned files only if file ids are known | rotate it (below) |

## Upgrades and rollbacks

1. Read the release notes for new variables; run `node apps/api/dist/doctor.js` with the new environment on a staging copy.
2. **Take a backup** (`backup.sh`) just before upgrading.
3. Roll out: `docker compose pull && docker compose up -d` or rebuild images; for systemd, deploy the new tree and `systemctl restart pdftools-api 'pdftools-worker@*'`. Old instances drain gracefully (`SIGTERM`); the API runs pending migrations at start under a lock (use `MIGRATIONS=check` and run `node apps/api/dist/migrate.js up` as an explicit step if you want migrations separated from rollout).
4. Run `node infrastructure/scripts/smoke.mjs https://your.domain`.
5. **Rollback**: redeploy the previous version. Migrations are forward-only, so the old code refuses to start against a newer schema (`database has migrations this version does not know`). If a migration ran, restore the pre-upgrade backup (`restore.sh --drop`) and then start the old version. Code-only releases (no new migration) roll back by redeploying.
6. Zero-downtime: run at least two API instances behind nginx (`upstream` with several servers); restart one at a time. Workers can be restarted any time: they finish running jobs first.

## Secret rotation

| Secret | Procedure | Effect |
|---|---|---|
| `JWT_ACCESS_SECRET` | set a new value on all API instances, restart | access tokens (15 min) become invalid; clients refresh transparently using the refresh cookie |
| `DOWNLOAD_SECRET` | set new value on all API instances, restart | outstanding download links (10 min) stop working; users re-click Download |
| `METRICS_TOKEN` | change in env and in Prometheus's token file | scraping fails until both match |
| MongoDB/Redis passwords | update the server, then the URIs, restart API and workers | brief downtime |
| Stripe keys / webhook secret | roll in the Stripe dashboard, update env, restart | webhooks with the old secret are rejected (Stripe retries) |
| Admin password | admin → change password | other sessions signed out |

## Capacity and tuning

* Throughput scales with workers × `WORKER_CONCURRENCY`; each running job may use up to `ISOLATION_MEMORY_MB` of address space (typically far less) and one CPU for most tools.
* OCR is CPU-heavy: roughly 1–3 s per page at 300 DPI and one core per job (`OMP_THREAD_LIMIT=1` is set for Tesseract). The PDF/A validator starts a JVM per job (a few seconds, capped at 512 MB heap so it fits the kernel memory limit); expect PDF/A jobs to take 3–6 s even for tiny files.
* Per-plan limits (file size, pages, daily operations, retention, priority) are runtime settings in the admin UI; `MAX_STORAGE_MB` protects the disk globally.
* nginx caps request bodies at `1g` for `/api/pdf/` and rate-limits per IP (`pdf_upload` 30/min burst 20, `pdf_auth` 30/min burst 10, `pdf_api` 600/min burst 200); raise them if many users share one IP (offices, universities, mobile carriers).
* Behind any proxy or load balancer set `TRUST_PROXY` to the number of proxies, or every visitor shares one IP for quotas.

## Routine checklist

* Daily: alerts quiet; last backup exists and is off-host.
* Weekly: `npm audit --omit=dev` in CI is green; OS and engine updates applied (Ghostscript, Poppler, LibreOffice, ImageMagick are the highest-risk components: they parse untrusted files); admin Audit log skimmed.
* Monthly: restore drill; certificate expiry check; review plan limits against real usage.
