# OtterTranslator

A small, self-hosted DOCX translator for an allowlisted group. Server-rendered HTML and vanilla JavaScript provide email sign-in, upload, language selection, progress, recent jobs and downloads. Fastify, SQLite and one in-process worker keep the deployment small.

Microsoft Translator is primary; Google Cloud Translation Basic is the fallback on quota exhaustion or provider blocking. The undocumented Google web endpoint and local Ollama are not supported by the v1 CLI/server. Translation credentials are required. No paid service is provisioned by this repository.

## Local setup

Use Node **22.12 or newer** and npm. SQLite installation may need Python, make and a C++ compiler when a prebuilt binary is unavailable.

```sh
npm ci
cp .env.example .env
# Edit .env: EMAIL_ALLOWLIST, SMTP settings, MS_TRANSLATOR_KEY and region.
npm run build
npm run server
```

Open http://localhost:3000. `ORIGIN` must exactly match the public browser origin. Production requires HTTPS. `npm run server:dev` runs the TypeScript source. The server commands load `.env`; direct CLI invocation requires exported environment variables or Node's `--env-file=.env` option.

For a complete **offline demonstration** without email/provider accounts:

```sh
# Terminal 1: local SMTP sink; prints messages to this terminal, never sends them externally
npm run mailbox
# In .env set EMAIL_ALLOWLIST=you@example.com, SMTP_HOST=127.0.0.1,
# SMTP_PORT=2525, SMTP_REQUIRE_TLS=false, SMTP_FROM=you@example.com,
# TRANSLATION_BACKEND=identity. Leave SMTP_USER/PASS empty.
# Terminal 2
npm run server
```

Request a sign-in link, copy the URL printed by the local mailbox, open it, then upload a DOCX. **Identity mode checks formatting and the product flow; its output is not translated.** Restore `TRANSLATION_BACKEND=composite` and real SMTP settings for actual use.

## Configuration and limits

See [.env.example](.env.example) for every setting. Mail uses Nodemailer SMTP submission: port 587 with required STARTTLS by default; port 465 requires `SMTP_SECURE=true`. Existing mail infrastructure can be used. Production magic links are delivered by SMTP and are never logged. Configure sender authorization/SPF/DKIM with your mail administrator.

- DOCX only, one file, **2 MiB** compressed upload; 100 MiB total decompressed archive, 2,048 ZIP entries, 2 MiB per translated XML part and 8 MiB combined translated XML. Malformed XML and DTDs are rejected before admission.
- One worker / one server replica. Each user may have 2 queued/running jobs and submit 10 jobs in a rolling 24 hours; global active queue cap is 50. Failed jobs count toward admission. Do not run a CLI translation concurrently with the server against the same provider accounts.
- Inputs, results and job history expire **24 hours after upload**. API access stops at expiry; startup and minute-by-minute maintenance remove files and rows, including failed/queued jobs and old orphan artifacts. Physical deletion can lag by up to one minute. Filesystem deletion errors are logged and retried per artifact without blocking startup or cleanup of other jobs; monitor them. Backups and provider retention are separate.
- Magic links expire after 15 minutes and are consumed atomically once. Sign-in is restricted to trimmed, case-normalized `EMAIL_ALLOWLIST` entries; removing an entry revokes access through existing sessions. Three requests per email per 15 minutes, admitted atomically even under concurrent requests; sessions last 30 days with HttpOnly, SameSite=Lax, root-path cookies and Secure on HTTPS.
- Progress reports validation, translation batches, optional review and reconstruction. It is a stage estimate, not an ETA. Source-retained paragraphs are counted and shown with the result.
- Queued jobs survive a restart. Running jobs are marked interrupted, never automatically retried. Shutdown stops admission, aborts active provider work and awaits the worker before closing SQLite. Jobs have a 30-minute timeout. A retry is a new upload.

## Formatting and review

The engine handles main document text, tables, headers/footers, footnotes/endnotes, hyperlinks, text boxes and inline-object positions. Formatting tags are validated: unsafe paragraphs retain their original source text; a result with all paragraphs rejected fails. Optional LLM review keeps machine translation when review fails or changes tags. Comments, SmartArt and metadata are not translated. Pagination can change as translated text grows; review output before distribution.

Server review is **off by default**, even with keys set. Enable `ENABLE_LLM_REVIEW=true` only after checking account billing, model access and privacy controls. Review uses configured Cerebras then Groq; absent keys skip that provider. Current account entitlements cannot be inferred from an API key. See [provider verification](docs/providers.md).

## CLI

```sh
node --env-file=.env dist/cli.js input.docx output.docx --from ro --to hu
node dist/cli.js input.docx output.docx --backend identity
node dist/cli.js --help
```

Options: `--from` (en), `--to` (ro), `--backend composite|identity`, and `--review` (explicit optional review). Removed `--engine`, `--ollama`, `--model`, and `--batch-size` options fail with a useful error. Network attempts reserve character budget before sending and keep that reservation on failures/timeouts. This favors the spending cap over maximizing free usage. Usage persists in `DB_PATH` (CLI default `./data/app.db`). Keep the same persistent ledger when using the same accounts.

## Deployment

[Deployment guide](docs/deployment.md) covers Docker and Coolify, persistent storage, HTTPS, resource limits and operational recovery. Run one replica with 1 vCPU and a 1 GiB container limit (2 GiB host preferred). Node's heap is capped at 512 MiB; native ZIP/XML/SQLite memory also uses the container budget. Peak memory on a real target VPS still needs measurement.

## Validation

```sh
npm run build
npm run check:tools
npm test
npm run test:browser
```

Unit and HTTP integration tests use fixtures, identity translation or mocked providers; they do not spend API credits. Browser tests use Playwright, installed Google Chrome by default (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can override it). See PLAN.md for current execution evidence and remaining external checks. No deployment or paid subscription is implied.

MIT licensed.
