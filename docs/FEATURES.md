# Feature checklist (honest status)

Legend: ✅ works end to end and tested · 🟡 partial · ⬜ not started

## Tools
| Tool | Status | Notes |
|---|---|---|
| Merge PDF | ✅ | Drag/keyboard reorder. Bookmarks/forms from sources not preserved (warned in UI). |
| Split PDF | ✅ | Every page / every N / custom ranges (each comma part = one file); ZIP for many. |
| Extract pages | ✅ | |
| Rotate | ✅ | All or selected pages. |
| Organize (delete/reorder/duplicate/rotate) | ✅ | Visual PDF.js thumbnails. UI verified manually in browser; no automated e2e yet. |
| Compress | ✅ | Ghostscript presets; real sizes reported; returns original if not smaller. Optional metadata strip. Does not rasterize text. |
| Page numbers | ✅ | Helvetica only. |
| Text watermark | ✅ | Latin (WinAnsi) text only; image watermarks not done. Not tamper-proof. |
| JPG/PNG → PDF | ✅ | Non-interlaced PNG, baseline/standard JPEG per pdf-lib. |
| PDF → JPG/PNG | ✅ | Poppler; DPI and page-size guard. |
| Add text / rectangle / ellipse / line / highlight / freehand / images (Edit PDF workspace) | ✅ | PDF.js viewer with zoom, fit modes, thumbnails, undo/redo, move/resize, per-page. Placement verified by rendered-pixel tests on all four page rotations, and in a real browser. **Adds new content only — editing existing PDF text is not supported.** Highlight is a translucent box, not text-aware. Standard fonts, Latin only. Creating items is pointer-only (no keyboard-only drawing yet). |
| Sign PDF (draw/upload signature) | 🟡 | **Visual signature only**; not a certificate-based digital signature (UI and output say so). Signature *fields* and certificate signing: ⬜. |
| Edit existing text and images | 🟡 | Content-stream editing (`content-edit.ts`): glyphs under the clicked box are removed from the page content (removed characters become kerning gaps so neighbours stay put) and replacement text is drawn with a matched standard font; images can be deleted or replaced and their objects are dropped from the file (reachability-checked, so images shared with other pages survive). Tested on pdf-lib, LibreOffice (subset TrueType, Identity-H + ToUnicode) and Ghostscript output, on rotated pages and with kerned `TJ` arrays, verified against `pdftotext -bbox`, `pdfimages` and file bytes. **Not supported (reported, never guessed):** Type 3 fonts, CMaps other than Identity-H, fonts without ToUnicode, text/images inside embedded forms, inline images, scans. No reflow: new text is one line in a standard font (a warning is shown if it overlaps the next word). Not tested on CJK or right-to-left text. |
| Redact PDF | ✅ | True removal: marked pages are rasterized with boxes burned into pixels, original page content discarded; tested at byte level and via text extraction. Costs: those pages lose their text layer; output is a new document (metadata/bookmarks dropped). Marking is manual (no search-and-redact). Find-and-redact: plain-text terms are matched against the text layer (`pdftotext -bbox`), partial matches cover the whole word, rotated pages are mapped correctly, and a search with no match fails the job rather than returning an unredacted copy. Scanned images are not searched (no OCR). |
| PDF to Word | 🟡 | LibreOffice PDF import → DOCX. Tested: text present, re-opens and renders. Text sits in positioned frames; layout/fonts will not match exactly; no OCR for scans (a warning is shown). |
| PDF to Excel | 🟡 | One sheet per page; columns split on gaps in `pdftotext -layout` output; plain numbers typed, everything else text. Verified by opening the XLSX in LibreOffice. Heuristic: merged/ruled/multi-line cells can split wrongly. Refuses PDFs without a text layer. |
| PDF to PowerPoint | 🟡 | LibreOffice PDF import → PPTX, one slide per page. Tested slide count and text per slide; complex layouts approximated. |
| Protect PDF | ✅ | AES-256 (via maintained pdf-lib fork); password removed from job record after processing. Permissions flags not exposed. |
| Unlock PDF | ✅ | Requires the correct password + authorization confirmation; no bypass. Pages are copied to a new file (bookmarks/forms/metadata may be lost). |
| Office → PDF (doc/docx/xls/xlsx/ppt/pptx) | ✅ | LibreOffice 7.3 headless, per-job profile, content-validated. Fidelity differs from MS Office. Reverse (PDF → Word/Excel/PowerPoint): ⬜. |
| PDF → text, PDF → HTML, extract images | ✅ | Poppler. Scanned PDFs get a "no text layer" warning. |
| Crop, resize pages, add blank pages | ✅ | Crop only hides (stated in UI). Resize drops links/forms/annotations (stated). |
| Flatten form fields | 🟡 | Form fields only; other annotation types are not flattened. |
| Compare PDFs | 🟡 | Text diff report (HTML, escaped). No visual diff. |
| Repair PDF | 🟡 | Ghostscript rewrite; best-effort, with a structure sanity check so junk is reported as unrecoverable. |
| Fill PDF forms | ⬜ | |
| OCR | 🟡 | Tesseract: pages are rendered, recognised (TSV word boxes) and the text is added as an **invisible layer** under the untouched scan (output pixels are identical to the input; verified on all four page rotations against the printed words' extent). Skips pages that already have text; reports mean confidence and warns when low; installed languages only (clear error otherwise). **Limits:** the layer uses a standard Latin font, so non-Latin scripts cannot be stored (replaced by `?`, with a warning); recognition accuracy depends on the scan; tested only with English on generated scans, not on real-world degraded scans, skewed pages or handwriting. No deskew/cleanup. |
| PDF → PDF/A (1b/2b/3b) | 🟡 | Ghostscript `-dPDFA` with an sRGB output intent. **Verified with veraPDF**: outputs from LibreOffice, pdf-lib (non-embedded fonts) and a JavaScript-bearing source validate as PDF/A-1b, 2b and 3b in an independent veraPDF run. When `VERAPDF_BIN` is set the server runs veraPDF on every result and refuses to deliver a file that fails (reporting the failing clause); **without it the file is clearly marked "not independently validated"**, never as compliant. Converts only; it does not validate third-party PDF/A files. Removes encryption/JavaScript; metadata may not carry over. Not tested on very large, damaged or exotic-font documents. |
| Standalone "View PDF" page | ⬜ | The workspace is a viewer, but there is no view-only route. |

## Platform
| Area | Status | Notes |
|---|---|---|
| Upload validation (magic bytes, size, count, empty, options Zod) | ✅ | Tested incl. spoofed extension/MIME. |
| Structural PDF validation, encrypted PDF detection, page limit | ✅ | Runs in processing step. |
| Job lifecycle + progress + cancel | 🟡 | queued/processing/completed/failed/cancelled/expired work. `uploading` state is client-side only. |
| Background processing | 🟡 | **In-process queue** with bounded concurrency; Ghostscript/Poppler run as child processes with timeouts. BullMQ/Redis worker app **not built**. |
| Private storage, signed 10-min download links, owner checks | ✅ | Guest cookie identity. |
| Retention sweeper + immediate delete + input deletion after processing | ✅ | Tested. |
| Rate limiting, Helmet, CORS allowlist, safe filenames, error envelope | ✅ | Rate limiter not covered by tests (disabled in test env). |
| OpenAPI | 🟡 | Generated from registry for tool/job/file routes; `/api/docs` in non-prod. |
| Homepage, mega menu, tool directory, tool template, pricing, legal, 404, SEO meta/JSON-LD, sitemap/robots | ✅ | SPA: meta tags are set client-side; **no prerendering/SSR** yet, so crawlers that skip JS see only the shell. Legal text is a placeholder. |
| Dockerfiles / compose / nginx / Caddy | 🟡 | Image **contents** verified without Docker (real Dockerfile steps executed in clean dirs, tree started + smoke-tested); nginx and Caddy configs verified with the real binaries incl. TLS and the full proxy chain. `docker build`/`up` themselves and Let's Encrypt are **not** exercised here (CI builds the images). |
| PDF viewer/editor workspace | ⬜ | PDF.js used only for organize thumbnails. |
| PDF library | ✅ | Swapped to `@cantoo/pdf-lib` (MIT, maintained; the original pdf-lib is unmaintained). Regression-checked by the existing suite. |
| Accounts: register/login/logout/refresh/forgot/reset (MongoDB) | ✅ | scrypt password hashes; 15-min JWT access token held in memory; rotating httpOnly SameSite=Strict refresh cookie with reuse detection; lockout after 5 failures; no account enumeration on reset. **Email verification is not implemented.** Enabled only when `MONGODB_URI` is set. |
| Email confirmation | ✅ | Single-use hashed token, 24 h, resend limited to 1/min, superseded by newer links, also set by completing a password reset; optional gate on paid checkout (`REQUIRE_VERIFIED_EMAIL`). Delivery was verified through the log/capture mailer; **real SMTP delivery is unverified**. |
| Two-step sign-in (TOTP) + recovery codes | ✅ | RFC 6238 verified against the RFC vectors; QR/manual key setup; replay-proof and lockout-protected (verified incl. parallel use); encrypted secrets; admin reset (audited). Tested with a real MongoDB and in the browser with an independent authenticator implementation. **Not tested with real authenticator apps** (Google Authenticator, Authy…), though the URI/format follow their documented standard. |
| Signed-in devices | ✅ | List and remote sign-out (single or all others); no IP stored. |
| Teams and shared billing | ✅ | One team per person; owner/admin/member; email-bound single-use invitations; seats from the team's plan; the team (not a person) holds the Stripe subscription; effective plan = better of own and team's, resolved per request; ownership transfer; deletion rules; audited. Verified on a real MongoDB with a fake Stripe client (incl. seat races, cross-team access, parallel accepts, 9 mutation checks) and in the browser. **Not verified: a real Stripe team checkout/webhook** (the e2e stack sets the team plan in the database). Limits are per person, not pooled. |
| User dashboard | ✅ | Profile, plan & usage (today + 30 days), job history with authenticated downloads, change password, delete account (removes data, files, cancels subscription). |
| Usage tracking and plan enforcement | ✅ | Daily operation quota (guests also by IP), per-plan file size/pages/files/concurrency/retention, premium-tool gating, queue priority, admin-switchable tools and maintenance. All numbers come from settings, none hardcoded. Failed jobs do not consume quota. |
| Stripe billing | 🟡 | Checkout, portal, signed + idempotent webhooks (verified with real signatures in tests). **Not exercised against Stripe's live/test API** (no keys here); calls are tested through an injected client. Razorpay: ⬜. Nothing is simulated when unconfigured. |
| Admin dashboard | ✅ | Users, active users, jobs by state, queue, running (CPU-heavy) jobs, storage, system load; user management (role/plan/status); job list; usage chart; settings editor (limits, guest limits, prices, tools, retention, maintenance); audit log. Server-side role check on every endpoint. |
| Teams / shared admin / centralized billing (Business) | ⬜ | The Business plan has higher limits only. |
| Batch processing entitlement | ⬜ | Not implemented; not listed as a plan feature. |
| Subscription for "OCR / advanced editing" entitlements | ⬜ | OCR and editing tools exist but are not plan-gated by default (configurable per plan). |
| Mongo job store | ✅ | Job metadata persists across restarts (completed results stay downloadable; in-flight jobs are marked failed). |
| Redis / BullMQ worker | ✅ | `QUEUE_DRIVER=bullmq`: API enqueues, `node apps/api/dist/worker.js` processes; priority, atomic claim, cross-process cancellation, heartbeat crash recovery. Tested against a real Redis. Needs shared storage volume. Object-storage (S3) backend: ⬜. |
| Process isolation + kernel resource limits | ✅ | Per-job process group under `prlimit` (memory/CPU/file size), whole-job deadline, orphan cleanup. See docs/SECURITY.md. No seccomp/namespaces. |
| Playwright e2e (Chrome; API + separate worker + MongoDB + Redis + built web with CSP) | ✅ | 40+ browser tests: guest flows, accounts, admin, security-in-the-browser, worker-crash recovery, axe accessibility (WCAG 2.1 A/AA) and keyboard/mobile checks. |
| Load testing (throughput/latency at scale) | ⬜ | Resource-exhaustion and abuse tests exist; no sustained load test. |
| Production runbooks, monitoring, backups | ✅ | OPERATIONS.md (runbooks per alert), Prometheus config + 14 alert rules (a test checks they only reference real metrics/labels), real backup/restore drill, graceful shutdown, readiness vs liveness, migrations with locking and rollback guard, `doctor` preflight, post-deploy `smoke` test. Prometheus/Alertmanager themselves not run here. |
| systemd units (api, worker@N, backup timer) | 🟡 | Hardened; pass `systemd-analyze verify`; **not started** on a real host from here. |
| SEO prerender | ✅ | 29 public routes prerendered in real Chrome at build; crawler view tested with JS off; private pages stay an empty shell. Dynamic pages (pricing) are not prerendered. |
| CI | 🟡 | GitHub Actions workflow (audit, typecheck, tests with Redis service and Mongo tools, e2e with nginx/Caddy/Chrome, image-contents check, Docker build + compose smoke) written but **never run** from here. |
| shadcn/ui CLI components | 🟡 | Hand-written shadcn-style primitives (cva + tailwind-merge). React Hook Form not used; forms use the shared Zod schemas directly. |
