# OtterTranslator — Implementation Status and Remaining Plan

**Updated:** 2026-11-02
**Status:** Core translation pipeline and backend service implemented; browser experience and deployment unfinished.
**Evidence:** Current source, Git history through `76dcf01`, local worktree inventory, and live GitHub repository inspection. This replaces the obsolete “planning complete, no implementation started” status.

## TL;DR

We have a tested DOCX translation engine, quota-routed Microsoft/Google Cloud translation, an optional LLM review pass, and a Fastify/SQLite service with authentication primitives and upload/job/download APIs. The TypeScript build and all 81 tests passed during the 2026-11-02 status check.

We still need a browser UI, actual magic-link email delivery, reliable job lifecycle and file cleanup, HTTP integration coverage, provider setup, and Docker/Coolify deployment. Existing tests do not establish production readiness or live translation quality. No deployment or working provider credentials were verified in this review.

## 1. Scope and constraints

The intended product remains a self-hosted DOCX translator for a small known group (roughly 5–50 people), deployed on a small VPS through Coolify.

- DOCX only; other file formats are outside v1.
- Preserve formatting, document structure, hyperlinks, and inline object positions.
- One translation job at a time; SQLite and an in-process worker, without Redis or Postgres.
- Intended host budget: 1–2 GB RAM and 1 vCPU; no local translation model on that host.
- Intended upload cap: 2 MiB, with decompression and XML size guards.
- Intended retention: 24 hours for uploaded and generated documents.
- Allowlisted email authentication through single-use magic links.
- Target API spend: €0, with provider budgets enforced. Account configuration and current provider terms still need verification before deployment.
- Optional LLM corrections must preserve tags; unsafe or failed review responses retain the machine translation.
- Keep the CLI as a local entry point into the same engine.

## 2. What is implemented

| Area | Current implementation | Limits / unfinished work |
|---|---|---|
| Engine library | `translateDocx(buffer, options)` with typed errors, abort signal support, progress and tag-mismatch callbacks | Progress callbacks currently run during reconstruction, after translation/review |
| DOCX fidelity | Tagged formatting runs, container wrappers for hyperlinks and other nested content, positional inline-object placeholders | Real translated documents still need visual QA across representative layouts |
| Document parts | Main document, headers, footers, footnotes, endnotes; text boxes through recursive paragraph discovery | Comments, SmartArt, and metadata translation are not implemented |
| Validation | Required DOCX ZIP parts, archive decompression guards, XML part size checks before parsing; XXE regression coverage | HTTP upload validation currently checks size and ZIP signature only; full structural checks happen in the worker |
| Machine translation | Microsoft Translator primary, Google Cloud secondary on quota exhaustion or provider blocking; request batching and limiting | Credentials/account configuration and live provider behavior remain unverified |
| Quotas | SQLite usage ledger by provider and calendar month, injected into the engine; charge after successful calls | This protects shared provider budgets; per-user job admission limits are not implemented |
| LLM review | Optional Cerebras primary / Groq fallback, structured responses, batching, rate limiting, tag checks and safe fallback | Enabled by configured provider keys; no configured provider means review is skipped; live quality/privacy/account setup still requires validation |
| HTTP service | Fastify, cookies, multipart upload, job status and download routes, `/healthz` with queue depth and provider quotas | No browser page, no job-list/history endpoint, no persisted progress |
| Authentication | Email allowlist, expiring magic tokens, sessions, expiry cleanup | Request endpoint logs the magic link; SMTP delivery is still a TODO |
| Jobs | SQLite-backed queued/running/done/error states; serialized worker | Interrupted running jobs are not recovered on startup; stop does not await active work |
| Retention | Hourly purge of outputs and rows for successful jobs completed over 24 hours ago | Uploaded inputs and failed-job artifacts are not purged |
| CLI | Calls the shared engine and writes a translated DOCX | Help and engine labels are stale; parsed engine/model/batch options are not passed into the shared engine |

### Backend choice supersedes the original plan

The original plan depended on Google's undocumented free web endpoint. September research recorded blocked requests, and the implemented backend factory now selects the Microsoft/Google Cloud composite for every backend name except `identity`. The identity backend supports offline tests. The old Google web endpoint and Ollama code are not the active CLI/server routing path.

The source currently encodes provider budgets and review defaults. Treat the research in [spike-backend.md](docs/spike-backend.md) and [spike-llm.md](docs/spike-llm.md) as historical findings, not current guarantees of pricing, availability, model support, or privacy terms.

## 3. Git and GitHub status

Checked on 2026-11-02:

- Local and live remote `main` point to `76dcf013b37d910317265a29595dd7955ea85f6f`.
- Only one registered worktree exists: the main project checkout. It was clean before this documentation update.
- Old local branches `worktree-feat+backend` and `worktree-feat-server` retain their original commits. Their relevant files were ported onto `main`, with corrections, rather than merged wholesale; the landing commit messages explicitly document this.
- `fix/fidelity` and the scaffold/research branches point to earlier commits already reachable from `main`.
- GitHub has only the `main` branch and no issues or pull requests, open or closed. There is no GitHub backlog capturing the remaining work.

### Landed implementation milestones

All entries below landed on 2026-09-22.

| Commit | Result |
|---|---|
| `7fc5e59` | Engine scaffold, shared tag guard and backend/batch fixes |
| `4e33209` | DOCX and Ollama hardening |
| `12385c5` | Container/hyperlink and inline-object fidelity fixes |
| `dd302a1` | Microsoft + Google Cloud quota-routed backends; ported backend branch work |
| `ac09d1a` | Fastify/SQLite service and auth; ported server branch work, corrected DB-path and expiry defects |
| `b862107` | Optional stage-2 LLM review pass |
| `76dcf01` | Persistent quota wiring, safe tag-mismatch handling, retention timestamp fixes, health reporting and Google request corrections |

## 4. Remaining work, in delivery order

### A. Finish the service contract and lifecycle

- [ ] Make upload parsing consume the file and language fields reliably in one multipart flow; cover field ordering and enforce an explicit 2 MiB multipart limit.
- [ ] Validate DOCX structure before accepting a job, using the engine's existing guards where appropriate.
- [ ] Persist useful progress and stage information so polling can show translation/review status. Surface retained-source paragraphs to the user rather than only logging them.
- [ ] Recover interrupted `running` jobs on startup with a defined retry policy; await in-flight work during graceful shutdown.
- [ ] Enforce 24-hour retention for inputs, outputs, failed jobs and orphaned files; handle file deletion failures explicitly.
- [ ] Add per-user job admission limits alongside the existing shared provider quotas.
- [ ] Complete auth integration: SMTP delivery, normalized allowlist entries, atomic single-use token consumption, and session-cookie behavior including path and expiry units.
- [ ] Add meaningful HTTP/worker integration tests covering upload language fields and limits, auth and ownership, job completion, restart recovery, and full retention.

### B. Build the browser experience

- [ ] Serve a login page and wire the magic-link email flow.
- [ ] Add a DOCX upload form with source and target languages.
- [ ] Poll job status and present progress, provider/quota failures, and the final download link.
- [ ] Provide access to recent jobs during the retention window, with an authenticated job-list endpoint if needed.
- [ ] Decide whether email-on-completion belongs in v1; magic-link email delivery is required regardless.

### C. Make configuration and local use accurate

- [ ] Update README and CLI help to describe the implemented provider routing and required credentials.
- [ ] Remove or correctly wire CLI options that currently have no effect; correct the hardcoded Google engine label.
- [ ] Add a documented server start command and example environment configuration for database/output paths, origin, allowlist, SMTP, translation keys and optional review keys.
- [ ] Configure provider accounts and verify current free-tier limits, billing controls, review model support, and no-training requirements before sending business documents.

### D. Package, validate and deploy

- [ ] Add a multi-stage Dockerfile, non-root runtime, healthcheck, and explicit Node memory limit suitable for the VPS.
- [ ] Document Coolify deployment, persistent `/data` storage, HTTPS/origin configuration, and operational recovery.
- [ ] Run authenticated end-to-end tests with real provider credentials, including the priority language pairs and representative DOCX files.
- [ ] Visually compare translated documents in Word or an equivalent renderer: tables, hyperlinks, inline images, headers/footers, notes, and text boxes.
- [ ] Measure peak memory and completion time on the target VPS with near-limit documents; verify quota exhaustion, provider failure, restart behavior, and cleanup there.
- [ ] Deploy and confirm health, login email delivery, upload, translation, download, and retention in the hosted environment.

## 5. Verification baseline

On 2026-11-02, `npm run build` passed and `npm test` passed all 81 tests. Coverage includes fixture round trips, parser/reconstructor fidelity, tag mismatch fallback, security guards, backend routing/quotas/rate limits, database/auth primitives, and LLM review/provider behavior.

This baseline uses offline fixtures and mocked providers. It does not prove that the complete HTTP flow, SMTP delivery, real provider accounts, deployed container, visual translation quality, or VPS memory budget work. Repeat the existing checks after code changes and add integration coverage for the unfinished flows above.
