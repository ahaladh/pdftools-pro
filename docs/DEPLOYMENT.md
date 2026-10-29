# Deployment guide

Two supported paths. Pick one:

* **A. Docker Compose + Caddy** (one VPS, easiest, automatic HTTPS).
* **B. systemd + nginx + certbot** (bare metal / when you already run these).

Day-2 operations (monitoring, backups, upgrades, incident runbooks) are in [OPERATIONS.md](OPERATIONS.md).

## What has and has not been verified

This repository was developed on a machine **without a usable Docker daemon, root, or a public domain**, so be precise about what that means:

| Verified here, by automated tests | Not verified here (check on your first deploy) |
|---|---|
| nginx configs (`infrastructure/nginx`): real nginx 1.27 rendered from the templates, with real TLS: redirects, HSTS, CSP, headers not duplicated, caching, gzip, dotfiles, edge rate limits, body limits, request-id correlation, no tokens in logs | `docker build` / `docker compose up` themselves (CI builds the images) |
| The compose TLS chain **as shipped**: real Caddy 2.8 → nginx (container config) → production API: one HSTS header, real client IP preserved, spoofed `X-Forwarded-For` overwritten, per-client rate limits, large uploads | Let's Encrypt issuance (needs a public domain), HTTP/3 |
| Image contents: the real Dockerfiles' `COPY`/`npm` steps executed in clean directories, then the resulting tree started behind nginx+TLS, smoke-tested, `doctor`-checked (no dev dependencies, relative workspace links, prerendered site with the right origin) | apt packages inside the image, `USER node`, `tini`, `HEALTHCHECK` |
| systemd units pass `systemd-analyze verify` (syntax, keys) | the units actually starting services on a real host; the sandbox options under your distro's systemd |
| Backup/restore: real `mongodump`/`mongorestore` destroy-and-restore drill, checksum tamper detection, retention, locking, scratch restore | restoring a production-sized database; backup timer on a real host |
| Graceful shutdown (SIGTERM mid-job), health/readiness semantics, worker crash recovery, migrations (locking, rollback guard) | behaviour behind your specific load balancer |
| Prometheus alert rules reference only metrics/labels that exist | loading the rules into a real Prometheus (`promtool` unavailable), Alertmanager routing, the blackbox probe |
| Prerendered pages for 29 routes; crawler view with JavaScript off; sitemap/robots | Search engines actually indexing them |
| `doctor` (config review, engine versions, kernel memory limits actually enforced) and the post-deploy `smoke` script | Stripe and Razorpay (test or live), SMTP delivery |

Always finish a deployment with `doctor` and `smoke` (below): they check the real system, not a model of it.

## Common prerequisites

* A Linux host (Ubuntu 22.04/24.04 or Debian 12 tested paths), 2+ vCPU, 4+ GB RAM for light use (each concurrent job may use up to `ISOLATION_MEMORY_MB`), SSD with room for `MAX_STORAGE_MB`.
* A DNS A/AAAA record for your domain pointing at the host. Firewall: allow **22, 80, 443** (and 443/udp for HTTP/3); everything else closed. MongoDB, Redis, the API port (4000) and worker health ports must **not** be reachable from outside.
* Generate secrets:
  ```bash
  openssl rand -hex 32   # DOWNLOAD_SECRET
  openssl rand -hex 32   # JWT_ACCESS_SECRET (and again, separately, for TWO_FACTOR_KEY)
  openssl rand -hex 16   # METRICS_TOKEN
  openssl rand -hex 16   # MONGO_PASSWORD
  ```
* **First administrator:** sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, open *Account* and add an authenticator app or a security key (production requires one before the admin area opens), then remove `ADMIN_PASSWORD` from the environment.
* Decide the public origin (`https://pdf.example.com`). It is baked into the web build (canonical URLs, sitemap, robots, prerendered pages), so changing the domain means rebuilding the web image.

## A. Docker Compose + Caddy

```bash
git clone <your repo> /opt/pdftools && cd /opt/pdftools
cp .env.example .env && chmod 600 .env
$EDITOR .env
```
In `.env` set at least: `SITE_URL`, `SITE_ADDRESS` (domain only), `ACME_EMAIL`, `PUBLIC_URL`, `CORS_ORIGINS` (both `https://pdf.example.com`), `DOWNLOAD_SECRET`, `JWT_ACCESS_SECRET`, `METRICS_TOKEN`, `MONGO_PASSWORD`, `TRUST_PROXY=1`, `APP_VERSION`, and for the first start `ADMIN_EMAIL` + `ADMIN_PASSWORD` (12+ chars). Set `SMTP_URL` if you want password-reset emails and Stripe variables if you want billing.

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml build
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
docker compose ps                                   # all services "healthy"
docker compose exec api node apps/api/dist/doctor.js --deep
node infrastructure/scripts/smoke.mjs https://pdf.example.com
```
Then **delete `ADMIN_PASSWORD` from `.env`** and `docker compose up -d` again. Scale processing with `docker compose up -d --scale worker=3`.

Topology: Caddy (80/443, TLS) → `web` (nginx: static site, edge limits, proxies `/api`) → `api` → `redis` + `mongo`; `worker` containers consume Redis and share the `pdf-data` volume with `api`. Only Caddy is public; `web` is also published on `127.0.0.1:8080` for a host-level proxy if you prefer your own TLS terminator (then omit the TLS override and keep `TRUST_PROXY=1`).

Notes that bite people:
* The web image build **needs** `SITE_URL` and uses Playwright's image (it prerenders pages in Chromium); `docker compose build` will fail with a clear message if `SITE_URL` is unset.
* Back up the `caddy-data` volume (certificates/ACME account) or you may hit Let's Encrypt rate limits when rebuilding.
* The nginx container trusts `X-Forwarded-For` only from private ranges so per-IP limits work behind Caddy. Do not publish the `web` port on a public interface.
* Compose files are written for Compose v2 (`docker compose`). Set `stop_grace_period` ≥ `SHUTDOWN_DRAIN_SECONDS + SHUTDOWN_GRACE_SECONDS` if you change those (the files use 45 s).

## B. systemd + nginx + certbot

1. **Install system packages**
   ```bash
   sudo apt install nginx certbot ghostscript poppler-utils imagemagick util-linux \
        libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation redis-server \
        tesseract-ocr tesseract-ocr-eng default-jre-headless   # optional: OCR, and Java for the PDF/A validator
   # Node 22 (nodesource or nvm; the units expect /usr/bin/node), MongoDB 7 (official repo) or a managed MongoDB
   ```
   **Optional engines.** *OCR* needs `tesseract-ocr` plus one `tesseract-ocr-<lang>` package per language you offer (users are told which languages exist). *PDF/A* conversion works with Ghostscript alone, but then results are labelled **"not independently validated"**. To validate every result (and refuse to deliver files that fail), install [veraPDF](https://verapdf.org/) and set `VERAPDF_BIN=/path/to/verapdf` in the service environment (`infrastructure/scripts/dev-engines.sh` shows an unattended install; the Docker image does this with a pinned, checksummed download). `npm run doctor` reports both as warnings when absent. If the binaries live outside the standard PATH set `PDFTOOLS_BIN_DIR` (plus `TESSDATA_PREFIX` / `LD_LIBRARY_PATH` if needed); only those listed variables are passed to engines.
2. **User and tree**
   ```bash
   sudo useradd --system --home /opt/pdftools --shell /usr/sbin/nologin pdftools
   sudo git clone <repo> /opt/pdftools && cd /opt/pdftools
   sudo -u pdftools REDISMS_DISABLE_POSTINSTALL=1 MONGOMS_DISABLE_POSTINSTALL=1 npm ci
   sudo -u pdftools SITE_URL=https://pdf.example.com npm run build    # also prerenders the site (needs Chrome: PRERENDER_BROWSER=/path or PRERENDER=0)
   sudo -u pdftools npm prune --omit=dev
   ```
3. **Configuration**: `sudo install -d -m 0750 -o root -g pdftools /etc/pdftools` and copy `infrastructure/systemd/pdftools.env.example` to `/etc/pdftools/pdftools.env` (mode 0640, `root:pdftools`). Fill the secrets.
4. **MongoDB and Redis** must listen on loopback only and require credentials (MongoDB) / `maxmemory-policy noeviction` (Redis). Create the database user and put its URI in the env file.
5. **Services**
   ```bash
   sudo cp infrastructure/systemd/pdftools-api.service infrastructure/systemd/pdftools-worker@.service \
           infrastructure/systemd/pdftools-backup.{service,timer} /etc/systemd/system/
   sudo install -d -m 0700 -o pdftools -g pdftools /var/backups/pdftools
   sudo systemctl daemon-reload
   sudo systemctl enable --now pdftools-api pdftools-worker@1 pdftools-worker@2 pdftools-backup.timer
   sudo -u pdftools env $(grep -v '^#' /etc/pdftools/pdftools.env | xargs) node apps/api/dist/doctor.js --deep
   ```
   The API unit runs `migrate.js up` before start. Workers have `IPAddressDeny=any` (+ loopback): add your Redis/MongoDB addresses to `IPAddressAllow` if they are not on localhost.
6. **nginx + TLS**
   ```bash
   sudo mkdir -p /etc/nginx/snippets /var/www/pdftools /var/www/certbot
   sudo cp infrastructure/nginx/snippets/*.conf /etc/nginx/snippets/
   sudo rsync -a --delete apps/web/dist/ /var/www/pdftools/
   # temporary self-signed cert so nginx can start, then replace via certbot:
   sudo certbot certonly --webroot -w /var/www/certbot -d pdf.example.com -m ops@example.com --agree-tos
   DOMAIN=pdf.example.com WEB_ROOT=/var/www/pdftools infrastructure/nginx/render.sh | sudo tee /etc/nginx/conf.d/pdftools.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
   (`certbot certonly --webroot` needs port 80 answered first: start with only the port-80 server block, or use `--standalone` once before nginx is configured.) Add a certbot deploy hook that reloads nginx; for OCSP stapling uncomment the lines marked in the template.
7. **Verify**: `node infrastructure/scripts/smoke.mjs https://pdf.example.com`. Remove `ADMIN_PASSWORD` from `/etc/pdftools/pdftools.env` and `sudo systemctl restart pdftools-api`.

## Optional: virus scanning with ClamAV

Off by default. To turn it on, run `clamd` somewhere the API can reach (the workers do not need it: files are scanned at upload, by the API) and set `AV_MODE=enforce` plus `CLAMD_HOST`/`CLAMD_PORT` (or `CLAMD_SOCKET`). **This example has not been run here**; check it against the image's current documentation:

```yaml
# docker-compose.override.yml: a ClamAV daemon on the compose network, not published to the host
services:
  clamav:
    image: clamav/clamav:stable
    restart: unless-stopped
    volumes: ["clamav-db:/var/lib/clamav"]        # keep the signature database across restarts
    # clamd.conf must allow your biggest upload: StreamMaxLength, MaxFileSize and MaxScanSize >= your largest plan's file size
    healthcheck: { test: ["CMD", "clamdcheck.sh"], interval: 60s, retries: 5, start_period: 120s }
  api:
    environment: { AV_MODE: enforce, CLAMD_HOST: clamav, CLAMD_PORT: "3310" }
    depends_on: { clamav: { condition: service_healthy } }
volumes: { clamav-db: {} }
```

The daemon needs about 1 to 2 GB of memory for the signature database and a minute to start. Run `node apps/api/dist/doctor.js` afterwards (its *antivirus scanner* check pings the daemon), then upload the **EICAR test file** (a harmless string every scanner flags: https://www.eicar.org/) inside a PDF once to see it refused, and watch `pdftools_av_scans_total`. Decide `AV_FAIL` deliberately: `closed` (default) pauses uploads while the scanner is down; `open` keeps the site up and unscanned. The scanner and its alerts are described in OPERATIONS.md (*Virus scanner*).

## Production build (without containers)

```bash
npm ci
SITE_URL=https://pdf.example.com npm run build    # libs -> api -> worker code (same package) -> web (+ sitemap, robots, prerender)
node apps/api/dist/migrate.js status              # database schema state
node apps/api/dist/doctor.js --deep               # preflight; exit code 1 if anything dangerous
node apps/api/dist/server.js                      # API   (SIGTERM = graceful drain)
node apps/api/dist/worker.js                      # worker (SIGTERM = finish running jobs)
```
`PRERENDER=0` skips prerendering (the site still works, but crawlers that do not run JavaScript see an empty page; `app-shell.html` is always written because nginx needs it). Prerendering needs a browser: system Chrome by default, `PRERENDER_BROWSER=/path/to/chromium`, or `PRERENDER_BROWSER=bundled` with Playwright's browsers installed.

## Preflight and post-deploy checks

| Command | What it does | Run it |
|---|---|---|
| `node apps/api/dist/doctor.js [--deep] [--json]` | reviews configuration (https URLs, secret strength, proxy trust, rate limiting, isolation, Stripe pairing), checks every engine, proves the kernel enforces memory limits, storage/disk, MongoDB + migrations, Redis (+ eviction policy); `--deep` also converts a document under the production limits. Exit 1 on any failure | after every config change, as a deploy gate |
| `node apps/api/dist/migrate.js status\|up` | schema state / apply pending migrations | before rollouts if you use `MIGRATIONS=check` |
| `node apps/api/dist/rotate2fa.js status\|run [--dry-run]` | which key each authenticator secret is under / re-seal under a new `TWO_FACTOR_KEY` | only while rotating that key (OPERATIONS.md, *Rotating the two-factor key*) |
| `node infrastructure/scripts/smoke.mjs <url> [--insecure] [--json] [--api-only]` | public liveness, home page, headers, deep link, config, internal endpoints not exposed, **a real guest merge job through the queue and workers**, download, delete | after every deploy, and from a monitor if you like |

## Data initialisation and migrations

There is no manual DB setup. On first start the API creates indexes and applies versioned migrations (`apps/api/src/db/migrations.ts`, recorded in the `migrations` collection, applied under a lock so replicas starting together are safe). The first admin comes from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (only if that email does not exist; remove the password afterwards). New migrations are forward-only: never edit a shipped one. Code older than the database refuses to start (rollback guard); see *Upgrades and rollbacks* in OPERATIONS.md.

## Logging and monitoring

JSON logs from the apps and nginx (`pdftools_json`, `$uri` only, never query strings), request ids end to end, Prometheus metrics with alert rules, health/readiness endpoints, an admin dashboard with queue/storage/system load, and an audit log. Wiring and runbooks: [OPERATIONS.md](OPERATIONS.md); config: `infrastructure/monitoring/`.

## Backups

`infrastructure/scripts/backup.sh` (checksummed archives, retention, locking), `restore.sh` (checksum check, refuses to overlay data without `--drop`, `--scratch` verification restore). systemd timer or cron. **Copy archives off the host.** Details and the recovery table: OPERATIONS.md.
