# Tasks

## Done (Phases 1–4)
- [x] Monorepo, shared registry/schemas, pdf-core engine, API, web app, tests, Docker/nginx drafts, docs

## Next
- [x] Phase 5 (done, see docs/FEATURES.md): workspace (view/edit/sign/redact), Office→PDF, protect/unlock, text/HTML/image extraction, crop/resize/blank pages, flatten forms, compare, repair
- [x] Batch processing as a plan entitlement (Razorpay: decided against, see docs/FEATURES.md)
- [x] Per-seat team billing (opt-in, `TEAM_BILLING=per_seat`; not yet run against real Stripe)
- [x] Per-person limit inside a team pool
- [x] Admin console: teams view, ownership override for unreachable owners, team deletion
- [x] Pooled team quotas (daily operations); fixed admin settings silently reverting to defaults
- [x] Two-factor key rotation tool (`rotate-2fa`, `TWO_FACTOR_KEY_PREVIOUS`)
- [x] Two-step sign-in required for administrators (`REQUIRE_ADMIN_2FA`)
- [x] WebAuthn security keys as a second factor (passwordless passkey sign-in not built)
- [x] Form filling (`fill-form`; see docs/FEATURES.md for what it refuses)
- [ ] Phase 5 leftovers: OCR languages beyond English / non-Latin text layer (needs an embedded Unicode font), editing text inside embedded forms / Type 3 / CJK fonts, reflowing paragraphs, keyboard-accessible drawing, Playwright e2e for the workspace, standalone viewer route
- [x] Phase 6 (done, see docs/FEATURES.md): MongoDB accounts, JWT + rotating refresh, dashboard, usage/quotas, plans/entitlements, Stripe, admin panel + audit log
- [ ] Phase 6 leftovers: verify Stripe (checkout, team checkout, per-seat changes, webhooks) against test mode
- [x] Phase 7 (done, see docs/SECURITY.md): isolation + limits, BullMQ worker, heartbeat recovery, security/abuse/resource tests, Playwright e2e + axe, CI workflow
- [ ] Phase 7 leftovers: load testing, S3-compatible storage, seccomp/namespace sandbox, antivirus hook, Playwright on Firefox/WebKit, visual-regression tests
- [x] Phase 8 (done, see docs/DEPLOYMENT.md, docs/OPERATIONS.md): HTTPS reverse proxy (nginx + Caddy) verified with real binaries, health/readiness/metrics/alerts, graceful shutdown, migrations, backup/restore drill, doctor + smoke, prerendered SEO, systemd units, image-contents verification
- [ ] Phase 8 leftovers (need real infrastructure; CI runs on GitHub on every push and builds the real images): first real `docker build`/compose deploy, Let's Encrypt, systemd on a real host, Prometheus/Alertmanager with real rules, load testing, S3-compatible storage, WAF/antivirus decision
