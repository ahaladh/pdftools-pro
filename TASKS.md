# Tasks

## Done (Phases 1–4)
- [x] Monorepo, shared registry/schemas, pdf-core engine, API, web app, tests, Docker/nginx drafts, docs

## Next
- [x] Phase 5 (done, see docs/FEATURES.md): workspace (view/edit/sign/redact), Office→PDF, protect/unlock, text/HTML/image extraction, crop/resize/blank pages, flatten forms, compare, repair
- [x] Standalone PDF viewer with whole-document search (`/view`, client-side only)
- [x] Keyboard and screen-reader operation of the editor (freehand and signature drawing remain pointer-only)
- [x] Antivirus hook: optional ClamAV scanning of uploads (not yet run against real ClamAV)
- [x] Batch processing as a plan entitlement
- [x] Per-seat team billing (opt-in, `TEAM_BILLING=per_seat`; not yet run against real Stripe)
- [x] Per-person limit inside a team pool
- [x] Admin console: teams view, ownership override for unreachable owners, team deletion
- [x] Pooled team quotas (daily operations); fixed admin settings silently reverting to defaults
- [x] Two-factor key rotation tool (`rotate-2fa`, `TWO_FACTOR_KEY_PREVIOUS`)
- [x] Two-step sign-in required for administrators (`REQUIRE_ADMIN_2FA`)
- [x] WebAuthn security keys as a second factor (passwordless passkey sign-in not built)
- [x] Form filling (`fill-form`; see docs/FEATURES.md for what it refuses)
- [ ] Phase 5 leftovers: OCR languages beyond English / non-Latin text layer (needs an embedded Unicode font), editing text inside embedded forms / Type 3 / CJK fonts, reflowing paragraphs, Playwright e2e for the workspace
- [x] Phase 6 (done, see docs/FEATURES.md): MongoDB accounts, JWT + rotating refresh, dashboard, usage/quotas, plans/entitlements, Stripe, admin panel + audit log
- [ ] Phase 6 leftovers: verify Stripe (checkout, team checkout, per-seat changes, webhooks) against test mode
- [x] Phase 7 (done, see docs/SECURITY.md): isolation + limits, BullMQ worker, heartbeat recovery, security/abuse/resource tests, Playwright e2e + axe, CI workflow
- [x] Playwright on Firefox and WebKit: full suite passes on both (103 passed, 14 skipped: 8 already skipped + the 6 Chromium-only tests, i.e. CPU throttling in spec 16 and the virtual authenticator in spec 18). Run with `E2E_BROWSER=firefox|webkit` after `npx playwright install firefox webkit`; Chrome stays the CI default (not added to CI: it would roughly triple e2e time). Linux builds only; real Safari on macOS/iOS is untested.
- [x] Load test script (`infrastructure/scripts/loadtest.mjs`) and a first local measurement (see docs/OPERATIONS.md); heavy tools, real network and sustained load still untested
- [x] Razorpay as a second payment gateway beside Stripe (for sellers in India and worldwide buyers); not run against the real Razorpay
- [ ] Phase 7 leftovers: S3-compatible storage, seccomp/namespace sandbox, visual-regression tests
- [x] Phase 8 (done, see docs/DEPLOYMENT.md, docs/OPERATIONS.md): HTTPS reverse proxy (nginx + Caddy) verified with real binaries, health/readiness/metrics/alerts, graceful shutdown, migrations, backup/restore drill, doctor + smoke, prerendered SEO, systemd units, image-contents verification
- [ ] Phase 8 leftovers (need real infrastructure; CI runs on GitHub on every push and builds the real images): first real `docker build`/compose deploy, Let's Encrypt, systemd on a real host, Prometheus/Alertmanager with real rules, load testing on real hardware, S3-compatible storage, WAF/antivirus decision
