# Development plan & decisions

**Architecture**: npm-workspaces monorepo. `shared` is the contract (tool registry + Zod schemas) used by API validation, engine parsing and web forms, so adding a tool = registry entry + processor + (optional) option panel.
**Engine**: `pdf-core` is framework-free and takes `{workDir, inputs, options}`; it can run in the API process today and in a BullMQ worker later without change.
**Queue/store**: `JobStore` interface (memory impl) and `JobService.submit`/`pump` seam isolate the move to Redis/BullMQ + Mongo.
**Why in-process first**: this environment has no Redis/Mongo/Docker daemon; shipping unverifiable drivers would violate "don't claim what isn't tested".
**Decisions**: guest identity via httpOnly cookie; signed short-lived download links; originals deleted right after processing; planned tools return 501 and are labelled "Soon".

## Phase 6 decisions
- **Accounts are optional**: no `MONGODB_URI` ⇒ guest-only with in-memory stores (all guest tests still run without a database). With it, Mongo backs users, sessions, settings, usage, audit and job metadata.
- **Real Mongo in tests**: `mongodb-memory-server` runs an actual `mongod`, so the Mongo layer (TTL indexes, unique indexes, atomic updates) is genuinely exercised. Redis/BullMQ remain untested/unbuilt (no Redis available) and are Phase 7.
- **Limits are data**: plan limits, prices, premium-tool lists, disabled tools and maintenance mode live in a validated settings document edited in the admin UI; env vars only seed defaults.
- **Quota counts completed jobs** (plus in-flight) so failures are free; guests are keyed by cookie *and* IP.
- **Refresh in the cookie, access in memory**: chosen over localStorage tokens to remove XSS token theft; downloads go through authenticated `fetch` + blob rather than navigation links so ownership stays enforced for signed-in users.
- **Stripe via an injectable client** so webhook logic is tested with real signature verification without network access.
- **Swapped to `@cantoo/pdf-lib`** earlier for AES-256; React Router upgraded to v7 and nodemailer to v10 for security advisories (`npm audit --omit=dev`: 0).

## Phase 7 decisions
- **Worker lives in apps/api (`src/worker.ts`)**, not a separate app: it shares the runner, stores and config with the API, and ships in the same image with a different command. Same code path inline and distributed.
- **Isolation by process, not thread**: worker threads proved unable to bound Buffer/typed-array memory (the thing PDF/image decoders allocate), so jobs run in a child process under `prlimit`. Measured: Node needs ~1.5 GB of address space to start; engine caps are clamped to the job cap because a child cannot raise a limit.
- **State only in the store**: runners/queue hold no authoritative state, so crashes, restarts and duplicate delivery are recoverable (atomic `transition`, heartbeats, reaper). This replaced the Phase 6 single-instance rule.
- **Tests use real services**: mongod, Redis and Chrome. Each security test was validated by breaking the fix and watching it fail (mutation spot-checks).
- **e2e runs the production topology** (built web under the real CSP, separate API and worker processes) so config-only bugs surface.

## Phase 8 decisions
- **Verify with real binaries, not by reading config**: nginx and Caddy were built/downloaded and driven with TLS, which found a duplicate-HSTS bug, the Caddy `header` replace-vs-add semantics, the per-IP rate-limit bucket problem behind a proxy, and unquoted include paths. Docker could not be used, so a small Dockerfile *executor* runs the real COPY/npm steps in clean directories and the resulting tree is started and smoke-tested: it found test-tooling install scripts (Redis compile) running in the image build.
- **Liveness is dependency-free, readiness is not**: a database blip must not restart healthy processes, but must stop routing traffic to them.
- **Shutdown is a protocol**: drain (report not-ready), stop accepting, finish work, exit; orchestrator timeouts are set above the sum.
- **Migrations are forward-only with a rollback guard** instead of down-migrations: restoring a pre-upgrade backup is the safe rollback for data changes.
- **Edge owns what it serves, the API owns what it serves**: browser headers (CSP, HSTS...) are added by nginx only on static locations; proxied API responses carry the API's own, so nothing is duplicated.
- **Prerender at build time with a real browser** rather than SSR: public pages are static content; private pages stay a shell so no user data can be baked into HTML. `app-shell.html` is always produced because nginx's fallback needs it.
- **`SITE_URL` is the single source of the public origin** (canonical URLs, sitemap, robots, prerender), and the web build refuses to prerender without it.
