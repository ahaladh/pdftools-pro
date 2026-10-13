# PDFTools Pro

Original, self-hostable online PDF toolkit (brand configurable via `BRAND_NAME` / `VITE_BRAND_NAME`).
Status: **early but working** — 20+ tools run end to end (organize, convert, compress, edit/sign/redact workspace, protect/unlock, Office conversion, extraction, compare, repair). See [docs/FEATURES.md](docs/FEATURES.md) for exactly what is
implemented, partial and pending, and [TASKS.md](TASKS.md) for the roadmap.

## Layout
```
packages/shared    Tool registry, Zod option schemas, page-range parsing, API types (single source of truth)
packages/pdf-core  Processing engine: pdf-lib + Ghostscript + Poppler, timeouts, isolated work dirs
apps/api           Express API: uploads, validation, jobs, private storage, signed downloads, cleanup
apps/web           React + Vite + Tailwind SPA
infrastructure/    Dockerfiles, nginx config
```

## Requirements
- Node 20+ (developed on 24)
- On PATH: `gs` (Ghostscript), Poppler (`pdftoppm`, `pdftotext`, `pdftohtml`, `pdfimages`), `convert` (ImageMagick, used by redaction), `soffice` (LibreOffice, used by Office→PDF)
  e.g. `sudo apt install ghostscript poppler-utils imagemagick libreoffice-writer libreoffice-calc libreoffice-impress`

## Run locally
```bash
npm install
npm run build:libs
npm run dev:api     # http://localhost:4000  (API docs: /api/docs)
```
In a second terminal:
```bash
npm run dev:web     # http://localhost:5173 (proxies /api to :4000)
```
**Accounts, plans and admin** need MongoDB. Without `MONGODB_URI` the app runs guest-only (no sign-in). For local development a real `mongod` is available through:
```bash
npm run dev:db      # starts MongoDB on :27018 (data in ./data/mongo)
MONGODB_URI=mongodb://127.0.0.1:27018/pdftools ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-12+char-password' npm run dev:api
```

Configuration is via environment variables; see `.env.example` (all have working dev defaults).

## Processing topology
Default (`QUEUE_DRIVER=inline`): the API runs jobs itself, each in an isolated, resource-limited child process.
Scaled (`QUEUE_DRIVER=bullmq`): the API enqueues to Redis and any number of workers process (`npm run start:worker -w @pdftools/api`); they share MongoDB, Redis and the storage directory. See `docker-compose.yml` and docs/DEPLOYMENT.md.

## Tests
```bash
npm test            # pdf-core, api (guest, accounts on a real mongod, BullMQ on a real Redis, security, ops, migrations, backup drill), web
npm run typecheck
npm run test:e2e    # builds, then Playwright in Chrome against API + separate worker + MongoDB + Redis + the built web app,
                    # plus real nginx (TLS) and Caddy for the production-edge and proxy-chain suites
```

Some suites need extra binaries (they skip with a warning locally, and fail in CI if missing): `nginx` (`NGINX_BIN`), `caddy` (`CADDY_BIN`), MongoDB database tools (`MONGO_TOOLS_DIR`). Integration tests need a real Redis: set `REDIS_URL` (e.g. a service container), or `REDIS_SERVER_BIN=/path/to/redis-server`, or let `redis-memory-server` build one on first use (that build fails if the project path contains spaces). MongoDB is downloaded automatically by `mongodb-memory-server`. Chrome must be installed for e2e (`channel: 'chrome'`).

## Build
```bash
SITE_URL=https://your.domain npm run build   # also generates sitemap.xml / robots.txt
npm start -w @pdftools/api
```
Docs: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (compose + Caddy, or systemd + nginx; what is and is not verified), [docs/OPERATIONS.md](docs/OPERATIONS.md) (monitoring, runbooks, backups, upgrades), [docs/SECURITY.md](docs/SECURITY.md), [docs/FEATURES.md](docs/FEATURES.md).

## Production checks
```bash
npm run doctor                         # preflight: config review, engines, kernel limits, storage, MongoDB/Redis, migrations (exit 1 = do not deploy)
npm run smoke -- https://your.domain   # after deploy: health, headers, a real merge job through the workers, download, delete
npm run verify:images                  # executes the real Dockerfiles' steps in clean dirs and tests the result (no Docker needed)
infrastructure/scripts/backup.sh       # checksummed MongoDB backup; restore.sh has --scratch to verify one without touching production
```
