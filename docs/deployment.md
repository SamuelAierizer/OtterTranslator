# Deploying OtterTranslator

## Prepare accounts

1. Obtain an existing SMTP submission account and authorized sender. Check delivery to each approved user's mailbox.
2. Create or select a **dedicated Azure Translator F0** resource; confirm F0 in the portal, region, keys and remaining monthly allowance. Do not select S1/pay-as-you-go for the zero-spend target.
3. Google fallback is optional: leave the key empty until a dedicated project, API restrictions, remaining shared monthly credit and provider quota controls are verified. Budget alerts alone do not stop charges. Review [provider notes](providers.md). Leave review disabled until its accounts are checked.
4. Set `EMAIL_ALLOWLIST`, `ORIGIN=https://your-host.example`, SMTP and provider values as environment secrets. Never commit `.env`.

## Docker

```sh
cp .env.example .env
# Set the values above. For local HTTP container testing set NODE_ENV=development in .env.
docker compose up --build -d
docker compose ps
docker compose logs --tail=100
curl --fail http://127.0.0.1:3000/healthz
```

The Docker image runs as uid/gid 1000, with a healthcheck and 512 MiB Node heap. Compose mounts a named volume at `/data`, limits memory to 1 GiB and CPU to 1 core, enables init, drops capabilities and allows 45 seconds for shutdown. Container production mode requires an HTTPS ORIGIN; expose it through a TLS reverse proxy. The host binding is localhost by default. Do not scale above one replica.

## Coolify

1. Add this Git repository as a Docker Compose application using `compose.yaml`, or use its Dockerfile with equivalent runtime settings.
2. Set the application domain with HTTPS and route the proxy to container port 3000. Set ORIGIN to that exact HTTPS origin. Keep healthcheck path `/healthz`; readiness requires SQLite to respond.
3. Enter `.env.example` values as Coolify environment secrets. Set `NODE_ENV=production`, DB_PATH=/data/app.db, OUTPUT_DIR=/data/outputs, NODE_OPTIONS=--max-old-space-size=512.
4. Persist `/data` across deploys. Named volumes created by Compose start with the image directory's node ownership. For a bind mount, create the directory and grant uid/gid 1000 read/write access before deploying; do not run the container as root to work around permissions.
5. Enforce **one replica**, 1 vCPU, 1 GiB memory, 45-second stop grace, and init. A 2 GiB host leaves more room for the proxy/OS. With Dockerfile mode configure these in Coolify's resource/runtime settings.
6. Deploy only after authorization. Check health, real sign-in delivery, upload, progress, download and a restart. Confirm browser cookies include Secure; verify another user cannot fetch the job. Inspect a representative translated output in Word.

## Operations

- `/healthz` is a minimal unauthenticated DB liveness check. Job contents and quota/account details are not exposed there. Logs contain lifecycle/error information, never magic links or document contents.
- Stop the app before a full `/data` backup/restore, preserving app.db and WAL/SHM together. Prefer SQLite's online backup API if downtime is impossible. Backups contain email/session data and documents; encrypt them and apply a separate retention policy. The app's deletion window does not erase external backups.
- Never delete or reset quota counters when updating the app. If the ledger is lost or restored from an older backup, disable provider keys until you reconcile the provider dashboards; otherwise the local ledger understates usage.
- Startup migrations add job progress fields to existing databases. Back up before upgrading; rollback requires a compatible binary or restoring the backup and reconciling provider usage.
- Queued jobs resume after restart; interrupted running jobs become failed and require an explicit new upload. Watch maintenance errors for disk permission/full-volume problems. Old files remain until deletion succeeds, and are inaccessible through the API after expiry.
- Test a near-limit document and record maximum resident memory, runtime, provider failure, quota exhaustion and cleanup on the actual host before calling the deployment validated. Build-only or identity checks do not establish real translation quality or resource headroom.

## External checks still required

No credentials, target VPS or authorized external deployment were available during local implementation. Confirm account-specific limits, SMTP delivery, real translation quality, image build/start, volume ownership, HTTPS/proxy configuration and VPS peak memory before production use. Docker CLI availability alone does not validate a container build.
