# OtterTranslator — v1 delivery status

**Updated:** 2026-11-03. **Status:** local product implemented and tested; deployment artifacts prepared. External provider accounts, hosted deployment and real translated-document quality remain unverified.

## Scope retained

DOCX only; small email-allowlisted group; one active translation worker; Fastify/SQLite; 2 MiB uploads; 24-hour retention; 1 vCPU / 1–2 GB host; target API spend €0. Formatting-tag validation retains unsafe paragraphs in their source language. Optional LLM review fails back to machine translation and is explicitly disabled by default on the server.

## Source and Git baseline

Inspected PLAN.md, source, local history, status, branches and worktrees before editing. The initial checkout was clean, on main at `fd36b67` (one documentation commit ahead of origin/main at `76dcf01`), with one registered worktree. Old fidelity/scaffold/backend/server branches remain; no merges, branch switches, resets or commits were made. The previous PLAN's core implementation claims were supported by source, but it described historical remote state; this delivery did not re-fetch or re-verify GitHub state.

Initial `npm run build` passed; initial `npm test` passed **81/81** tests. Those were offline/mocked tests, not production validation. No pre-existing uncommitted work was present to preserve.

## Completed

- [x] Single multipart iterator accepts file and language fields in either order; explicit one-file/two-field/2 MiB limits; invalid/duplicate fields and same-language submissions rejected.
- [x] Full DOCX archive and XML validation before queueing; Word content type required; macros/DTD rejected; ZIP decompression/entry limits, per-part and combined XML parsing budgets enforced.
- [x] Persisted stages and translation-batch progress, recent jobs endpoint, source-retained paragraph count, authenticated downloads and ownership checks.
- [x] Interrupted running jobs become failed on startup without automatic provider retries. Queued jobs remain queued. Graceful SIGINT/SIGTERM shutdown aborts active translation and awaits its state update before closing SQLite; 30-minute job deadline.
- [x] 24-hour access cutoff from upload time. Startup/minute maintenance removes inputs, outputs, failed/queued job records and old orphan artifacts; deletion failures preserve retryable state and are logged.
- [x] Atomic admission: 2 active jobs/user, 10 accepted uploads/user per rolling day, global 50 active-job cap.
- [x] SMTP magic-link delivery through Nodemailer with bounded connection/socket timeouts and failure invalidation; normalized allowlists; atomic single-use redemption; session expiry in seconds, root cookie path, HttpOnly/SameSite and HTTPS Secure; logout and allowlist revocation.
- [x] Responsive server-rendered login/upload/history UI and vanilla JavaScript polling; clear upload/provider errors, progress and download links. Email on completion is intentionally omitted from v1; recent-job polling provides completion access.
- [x] CLI options reflect supported composite/identity backends and explicit review; obsolete options fail clearly. CLI shares persistent SQLite usage accounting. README, environment example, provider/account notes and exact local/deployment steps rewritten.
- [x] Dockerfile and Compose: multi-stage build, non-root runtime, persistent `/data`, healthcheck, init, 1 CPU / 1 GiB container limit, 512 MiB Node heap, 45-second shutdown grace; Coolify/HTTPS/volume/recovery guidance.
- [x] Dependency advisory review and upgrades: patched Fastify 5, matching plugins, SQLite, XML/ZIP and mail packages; npm install reported **0 vulnerabilities**. Added reproducible package-lock.json (it was previously ignored).
- [x] Corrected pre-existing Microsoft endpoint: documented global API host plus resource-region header. Fixed a misleading old test whose response shape caused an untranslated source fallback while being labeled a successful translation.
- [x] Provider requests reserve budget before network I/O, atomically with SQLite. Uncertain failures retain reservations to avoid undercounting after timeouts/crashes. Local counters still cannot guarantee account-level spend; dedicated F0 accounts and account controls are required.

## Validation evidence

| Check | Result / limits |
|---|---|
| TypeScript build | Passed after implementation and dependency migration |
| Unit and HTTP integration suite | **90/90 passed**; fixtures, mocked providers or identity backend |
| HTTP integration | Multipart field ordering/limits/invalid DOCX, normalized login, concurrent token replay, ownership, completion/download, startup recovery, full retention/orphans, deletion failure/retry, HTTPS cookie attributes, concurrent/daily admissions, graceful active-worker stop, concurrent budget reservations |
| Playwright + installed Chrome | **1 complete product test passed**: production SMTP transport against local SMTP receiver, emailed link sign-in, upload, Romanian→Hungarian field selection, identity processing, downloaded DOCX XML, invalid/oversized file errors, logout, used-link replay, no page JavaScript errors |
| Browser screenshots | `test-results/product-desktop.png` and `product-mobile.png` generated and visually inspected; mobile 390px viewport has no horizontal overflow |
| CLI | Help and rejection of `--ollama` checked; near-limit fixture successfully written via identity backend |
| Local size/memory smoke | 1,999,297-byte DOCX with incompressible media; identity engine run 18 ms, 79,696 KiB max RSS on this Mac; excludes real provider latency and does not establish VPS sizing |
| Compose | `docker compose --env-file .env.example config --no-env-resolution --quiet` passed |
| Docker image/runtime | **Not tested:** Docker CLI exists but daemon is unavailable. No external deployment attempted |
| Real services | **No translation/review calls or remote SMTP delivery tested:** no configured credentials available |
| Document visual fidelity | Existing six DOCX fixture structural round trips pass. Real translated outputs in Word/LibreOffice remain visually unverified |

Browser testing uses Playwright at the user's explicit direction. The computer-use connector was unavailable and native permissions were absent; these were bypassed by using the requested headless test tooling, not by changing system permissions.

The completed app and local SMTP sink were started; live local health and SMTP sign-in submission returned success. A gitignored `.env` now supplies an **offline local demo**: demo@example.com, identity backend, local SMTP sink on port 2525. Run `npm run mailbox` and `npm run server` in separate terminals. Open http://localhost:3000, request the demo email's link and use the URL printed by the mailbox. This demo preserves source language; it is not evidence of real translation.

## Provider terms and external work remaining

Current official pricing, quotas, endpoints and privacy documentation were browsed; links and findings are in [docs/providers.md](docs/providers.md). Microsoft F0 remains the intended primary. Google's allowance is a shared monthly credit and its default daily quota is unlimited. Cerebras trial/pay-as-you-go availability must not be presented as a guaranteed permanent free tier. Groq retention/ZDR and account limits require administrator checks. No account-specific entitlement, billing or privacy control was inspected.

- [ ] Supply existing SMTP credentials and verify actual delivery, sender authorization and mailbox behavior.
- [ ] Verify dedicated Microsoft F0 account/tier, resource region and remaining quota; optionally verify Google shared credit, API restrictions and hard quota controls before supplying a fallback key.
- [ ] Keep LLM review off until real account billing/model/privacy controls are confirmed; enable Groq ZDR for confidential review where applicable.
- [ ] Run real translations for priority language pairs and visually inspect representative tables, hyperlinks, inline images, headers/footers, notes and text boxes in Word or an equivalent renderer.
- [ ] Build/run Docker with an available daemon; check non-root volume ownership, persistence, healthcheck, SIGTERM and memory cap in the actual container.
- [ ] With separate authorization, deploy through Coolify, configure HTTPS/origin, validate end-to-end mail/upload/download and retention, measure peak memory/time on the target VPS, and reconcile provider dashboard counters.

Exact setup, deployment and recovery steps: [README.md](README.md), [.env.example](.env.example), [docs/deployment.md](docs/deployment.md). These remaining checks require credentials, infrastructure or authorization unavailable locally; the product implementation does not depend on adding paid services.

## UI refinement — 2026-11-03

Removed the promotional eyebrow and slogan, decorative punctuation, shadows, oversized rounding and dashed upload panel. Replaced conversational copy with direct labels and short status messages; retained upload limits, expiry, demo-mode and provider-processing notices. The interface now uses neutral surfaces and conventional blue actions. Build, all 86 tests and the Playwright product flow passed; mobile screenshot inspected.

## Review fixes — 2026-11-03

All four functional findings and four standards findings from the two-axis review are addressed:

- Progress persistence handles rejection immediately, remembers the storage error and aborts active translation. The job drains its writes and records failure without an unhandled rejection or publishing an output after an abort.
- Retention cleanup handles filesystem errors per artifact/job, logs the error and keeps affected rows for retry. An undeletable expired input no longer blocks startup or deletion of unrelated jobs. Database errors still propagate.
- Queue selection excludes expired documents; the conditional claim rechecks the 24-hour cutoff atomically before reading input or invoking translation. Minute maintenance removes expired queued artifacts.
- Sign-in token admission uses one conditional INSERT with RETURNING, limiting each normalized email to three tokens in a rolling fifteen minutes even under concurrent requests.
- Restored explicit function return/parameter annotations on the reviewed server/worker/UI APIs and added public API lifecycle/retention documentation. Expanded the compressed server code to follow the existing multiline style.
- Converted the development mailbox to TypeScript and extracted one loopback-only SMTP sink shared with the Playwright harness. Use `npm run mailbox`; `npm run check:tools` typechecks scripts and browser-test code.

Validation: the four new regression scenarios were run against the previous implementation and failed, then passed after the fixes. `npm run build`, `npm run check:tools`, all **90** unit/integration tests, and the Playwright product flow passed. Coverage includes progress-write failure during in-flight translation, startup cleanup failure with unrelated cleanup/retry, expired-versus-fresh queued work, and eight concurrent sign-in requests admitting exactly three emails (plus window reset). Browser SMTP delivery now uses the shared TypeScript sink. External credential/container/VPS checks above remain unverified.

The application remains stopped at the user's request. Playwright's temporary test server was closed; no listener remains on application port 3000 or test port 3011.
