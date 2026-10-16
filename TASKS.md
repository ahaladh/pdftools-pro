# Tasks

## Done (Phases 1–4)
- [x] Monorepo, shared registry/schemas, pdf-core engine, API, web app, tests, Docker/nginx drafts, docs

## Next
- [x] Phase 5 (done, see docs/FEATURES.md): workspace (view/edit/sign/redact), Office→PDF, protect/unlock, text/HTML/image extraction, crop/resize/blank pages, flatten forms, compare, repair
- [ ] Phase 5 leftovers: form filling UI, OCR languages beyond English / non-Latin text layer (needs an embedded Unicode font), PDF/A validation in CI (veraPDF), editing text inside embedded forms / Type 3 / CJK fonts, reflowing paragraphs, keyboard-accessible drawing, Playwright e2e for the workspace, standalone viewer route
- [x] Phase 6 (done, see docs/FEATURES.md): MongoDB accounts, JWT + rotating refresh, dashboard, usage/quotas, plans/entitlements, Stripe, admin panel + audit log
- [ ] Phase 6 leftovers: WebAuthn/hardware keys, forcing 2FA for admins, 2FA-key rotation tool, pooled team quotas / per-seat Stripe billing, admin view of teams, batch entitlement, Razorpay, verify Stripe against test mode, Playwright e2e for auth/admin flows
- [x] Phase 7 (done, see docs/SECURITY.md): isolation + limits, BullMQ worker, heartbeat recovery, security/abuse/resource tests, Playwright e2e + axe, CI workflow
- [ ] Phase 7 leftovers: run CI for real, load testing, S3-compatible storage, seccomp/namespace sandbox, antivirus hook, Playwright on Firefox/WebKit, visual-regression tests
- [x] Phase 8 (done, see docs/DEPLOYMENT.md, docs/OPERATIONS.md): HTTPS reverse proxy (nginx + Caddy) verified with real binaries, health/readiness/metrics/alerts, graceful shutdown, migrations, backup/restore drill, doctor + smoke, prerendered SEO, systemd units, image-contents verification
- [ ] Phase 8 leftovers (need real infrastructure): run CI on GitHub, first real `docker build`/compose deploy, Let's Encrypt, systemd on a real host, Prometheus/Alertmanager with real rules, load testing, S3-compatible storage, WAF/antivirus decision
