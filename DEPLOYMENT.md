# Deployment

Target platform: Vercel with managed Postgres.

## Required Environment Variables

- `DATABASE_URL`: `info_room_runtime` runtime connection string. On Supabase, use the transaction pooler.
- `DIRECT_URL`: owner-only migration connection string. On Supabase, use the `postgres` session pooler.
- `SESSION_SECRET`: long random secret for session signing.
- `APP_ORIGIN`: canonical HTTPS production origin only, for example `https://info-room.example`; do not include a path, query, fragment, or credentials.
- `ADMIN_STUDENT_NUMBERS`: comma-separated student numbers with admin access.
- `CLOSED_PERIOD_CRON_SECRET`: bearer token used only by the closed-period notification cron.
- `MAINTENANCE_CRON_SECRET`: a different bearer token used only by the maintenance cron.
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for closed-period notifications and optional reservation-created alerts.
- `TRUST_FORWARDED_IP_HEADERS`: must be `true` on Vercel production so login rate limits use the real client IP from trusted proxy headers.
- `RIRO_MOCK_LOGIN`: must be `false` in production.
- `OBSERVABILITY_PROVIDER`: monitoring provider name; this is an identifier, not a DSN or token.
- `OBSERVABILITY_PROJECT_ID`: the production monitoring project identifier.
- `OPERATIONS_ALERT_DESTINATION`: the channel or incident route that receives alerts.
- `OPERATIONS_OWNER`: the accountable operator or team identifier.
- `OPERATIONS_ESCALATION_PATH`: the ordered escalation route when the owner does not acknowledge an alert.

Production predeploy also requires a full 40-character deployment SHA. Vercel provides
`VERCEL_GIT_COMMIT_SHA` and GitHub Actions provides `GITHUB_SHA`; set `DEPLOYMENT_SHA`
only for a local production-fixture check. Never set a permanent, stale SHA in Vercel.

Optional:

- `ENABLE_LOCAL_ADMIN`: local fallback admin login. Must stay `false` in production.
- `ADMIN_LOGIN_ID`, `ADMIN_LOGIN_PASSWORD`: local admin credentials when fallback login is enabled.
- `ENABLE_LOCAL_STUDENT`: local fallback student login for development and preview. Must stay `false` in production.
- `ENABLE_PRODUCTION_LOCAL_STUDENT`: explicit production-only student fallback. Use only when Riro login is unavailable and pair it with local student credentials.
- `LOCAL_STUDENT_LOGIN_ID`, `LOCAL_STUDENT_LOGIN_PASSWORD`, `LOCAL_STUDENT_NUMBER`: local student credentials when fallback login is enabled. IDs and numbers may be comma-separated; password may be one shared value or a comma-separated list matching the IDs.

## Vercel Build

Set the Vercel build command to:

```bash
npm run vercel-build
```

That command runs the predeploy environment check, Prisma Client generation, `prisma migrate deploy`, and `next build`. Keep `npm run db:push` for local development only; production uses committed migrations.

The predeploy output records the full deployment SHA and a SHA-256 digest over every
ordered Prisma migration. Preserve both values with the deployment receipt.

## Promotion and Provenance

1. Start from a reviewed, clean commit. Record the full Git SHA; a dirty worktree is not a deployment candidate.
2. Require the `quality`, `postgres-integration`, and `browser-smoke` jobs for that exact SHA.
3. Deploy that SHA to staging and record the predeploy migration digest.
4. Run staging health, Riro, reservation, admin, Discord, cron, and alert-delivery checks.
5. Promote the already-tested Vercel deployment to production. Do not rebuild a different SHA for production.
6. Record the production deployment ID, full SHA, migration digest, UTC promotion time, operator, and rollback deployment ID.

Any SHA or migration-digest mismatch blocks promotion. A rollback selects the recorded
previous deployment; an applied database migration is corrected with a forward migration.

## Supabase Postgres

Use two Supabase connection strings with separate database roles:

- `DATABASE_URL`: `info_room_runtime` through the Supabase transaction pooler, usually port `6543`. This role can read and mutate application rows but cannot run DDL, manage roles, or read Prisma migration history.
- `DIRECT_URL`: the `postgres` owner through the Supabase session pooler, usually port `5432`. Only Prisma Migrate uses this URL.

Supabase direct database hosts can require IPv6. If your network or deploy environment is IPv4-only, use the Supavisor session pooler for `DIRECT_URL` instead of `db.<project-ref>.supabase.co`. On Vercel, set both env vars for Production, Preview, and Development if those environments deploy against Supabase. If you use separate Supabase projects per environment, keep the matching transaction/session pair together.

The pooler host can be `aws-0`, `aws-1`, or another Supabase-assigned shard. Copy the exact host from the Supabase connection string or `supabase/.temp/pooler-url`.

### Row Level Security Readiness

This app does not use Supabase Auth sessions. It authenticates with Riro, stores its own `Session` rows, and accesses Postgres through Prisma. Supabase RLS policies that depend on `auth.uid()` will not protect this app unless the database connection also receives a trustworthy per-request user context.

The committed migration `prisma/migrations/20260630150000_add_rls_policies/migration.sql` adds staged Postgres policies that read `app.current_user_id` and `app.current_user_role`. Runtime code sets those variables with transaction-local `set_config(..., true)` in the core auth/session/CSRF/rate-limit/maintenance/student-reservation paths.

The migration `20260729060000_add_limited_runtime_role` creates the non-owner `info_room_runtime` login without a password. Set its password through the Supabase SQL editor, then put that role only in `DATABASE_URL`. Never use the runtime role in `DIRECT_URL`.

Guarded rollout:

1. Deploy migrations with the existing owner role in `DIRECT_URL`.
2. Assign a generated password to `info_room_runtime`.
3. Set Vercel `DATABASE_URL` to the runtime role and keep `DIRECT_URL` as the migration owner.
4. Run production-like smoke for login, `/api/me`, reservation create/cancel, admin dashboard, student profile, closed-list cron, and maintenance cron.

See `supabase/rls-readiness.sql` for the operator checklist. A direct database credential leak still bypasses app-level checks if the leaked role can set arbitrary `app.current_*` variables or owns the tables, so database credentials must stay server-only.

## First Deploy Checklist

1. Create the managed Postgres database and set `DATABASE_URL` plus `DIRECT_URL`.
2. Set all required environment variables in Vercel.
3. Run `npm run predeploy:check` locally with the production env loaded.
4. Deploy with `npm run vercel-build`.
5. Open the site, log in with a real Riro account, and confirm `/api/me` returns the current user.
6. Open `/admin`, confirm the dashboard loads, and test one closed-list send or reconciliation action.
7. Configure both external cron jobs with `npm run cron:setup:external`.
8. Confirm `/api/health/live` returns `200` and `/api/health/ready` is not `503`.

## Cron Endpoints

The cron endpoints use separate bearer credentials:

```http
GET /api/cron/closed-period-notifications
Authorization: Bearer ${CLOSED_PERIOD_CRON_SECRET}

GET /api/cron/maintenance
Authorization: Bearer ${MAINTENANCE_CRON_SECRET}
```

`/api/cron/maintenance` removes expired sessions, expired CSRF tokens, expired rate-limit buckets, releases expired temporary reservation restrictions, and revokes expired temporary sanction rows.

Use an external HTTP scheduler for both jobs. The closed-period job runs every minute, and maintenance runs daily at 04:00 KST. Vercel's built-in cron automatically sends one project-wide `CRON_SECRET` and its `vercel.json` cron schema does not support per-job headers, so it cannot preserve the required credential separation. The checked-in GitHub workflow remains a manual-only fallback for closed-period notifications.

Use cron-job.org with the project setup script:

```bash
EXTERNAL_CRON_BASE_URL=https://your-production-domain.example \
CRON_JOB_ORG_API_KEY=... \
CLOSED_PERIOD_CRON_SECRET=... \
MAINTENANCE_CRON_SECRET=... \
npm run cron:setup:external
```

The script creates or updates these cron-job.org jobs:

- `Info Room closed-period notifications`: every minute in `Asia/Seoul`, using `CLOSED_PERIOD_CRON_SECRET`.
- `Info Room maintenance`: daily at 04:00 in `Asia/Seoul`, using `MAINTENANCE_CRON_SECRET`.

Set `CLOSED_PERIOD_CRON_JOB_ORG_JOB_ID` and `MAINTENANCE_CRON_JOB_ORG_JOB_ID` only when updating known job IDs; otherwise the setup script matches by title and production origin.

## Health and Alerting

- `GET /api/health/live` is dependency-free liveness and should return `200`.
- `GET /api/health/ready` performs read-only configuration, database, and cron-heartbeat checks. It returns `200` for `ok` or `degraded`, and `503` for `unready`.
- The admin dashboard lists unresolved closed-period deliveries from the bounded seven-day backlog. `UNKNOWN` may be confirmed sent, retried, or ended; `FAILED` and `PENDING_REVIEW` may be retried or ended.

Configure the monitoring provider with these pilot thresholds:

| Signal | Window and threshold | Required action |
| --- | --- | --- |
| Readiness | Probe every minute; alert after two consecutive `503` responses | Page the owner, then follow `OPERATIONS_ESCALATION_PATH` if unacknowledged for 10 minutes |
| HTTP 5xx | At least 20 requests and error rate at least 5% over 5 minutes | Inspect the active deployment and database; rollback on a deployment-correlated increase |
| API latency | p95 above 2 seconds for 10 minutes | Check database pool saturation and external Riro/Discord latency |
| Login failure | At least 20 attempts and failure rate above 50% over 10 minutes | Verify Riro availability and parser behavior; stop repeated credential smoke attempts |
| Job failure | Two consecutive failures | Inspect the job record and scheduler history before retrying |
| Job heartbeat | Older than three configured intervals | Verify cron-job.org ownership, bearer scope, and endpoint readiness |
| Reconciliation | Any unresolved item beyond one operator review cycle | Resolve in the admin dashboard; do not blindly resend `UNKNOWN` deliveries |

Every rule must name the provider project, destination, owner, escalation path, and
last successful delivery-test timestamp. Test alert delivery before the pilot, quarterly,
and whenever the provider, destination, owner, or threshold changes.

## Backup, Restore, and Retention

Pilot entry targets are RPO at most 15 minutes and RTO at most 60 minutes. These are
requirements, not claims about the current managed database. Keep the gate `BLOCKED`
until the provider configuration and a measured drill prove them.

1. Enable managed Postgres PITR with at least a seven-day recovery window and document the provider project and region.
2. Record backup frequency, retention, encryption, access roles, and the accountable owner.
3. Quarterly and after database/provider changes, restore a chosen UTC point into a new non-production database.
4. Never restore over production. Point an isolated verification client at the restored database.
5. Compare migration history, table row counts, and checksums for critical reservation, user, sanction, audit, notification, and operational-job data.
6. Record requested and actual restore points, measured RPO/RTO, operator, provider job ID, and artifact digest.
7. Delete the drill database after evidence capture and verify its credentials are revoked.

Before setting `RETENTION_PURGE_ENABLED=true`, approve and record each data horizon,
purpose or legal basis, access, graduation/transfer/departure handling, exceptions,
approver, review date, and managed-backup expiry. Backup retention must eventually
expire data already anonymized by the application. Revoking the policy or setting the
flag back to `false` stops future destructive batches but cannot restore scrubbed data.

Discord governance must separately record purpose and consent, channel membership,
message retention/deletion, webhook ownership/rotation, access-review cadence, and one
completed review. Code-side payload minimization does not satisfy these policy gates.

## Readiness Receipts

External checks are accepted only through immutable JSON receipts. Each receipt includes
`provider`, `environment`, `projectId`, full `deploymentSha`, `migrationDigest`,
`capturedAt`, `expiresAt`, `operator`, HTTPS `evidenceUrl`, relative `artifactPath`,
`artifactSha256`, and `invalidationCondition`. Receipt and artifact paths and SHA-256
digests are listed in the run `manifest.json`.

Do not place passwords, tokens, webhook URLs, cookies, bearer values, authorization
headers, or API keys in receipts. The validator rejects sensitive field names and never
echoes their values.

```bash
npm run verify:receipts -- \
  --manifest .private/readiness/<run-id>/manifest.json \
  --deployment-sha <full-40-character-sha> \
  --environment staging \
  --migration-digest <predeploy-migration-digest>
```

The validator rejects missing or changed files, duplicate IDs/paths/digests, expired
receipts, `BLOCKED` status, and environment, SHA, or migration mismatches. Store actual
provider artifacts in an access-controlled location; do not commit production evidence
or personal data.

## External Integration Smoke Gate

Run these only with real production secrets and a valid Riro account:

1. Set smoke variables in a private shell. Do not commit them.
2. Run `npm run smoke:external`; this logs in with Riro and confirms `/api/me`.
3. To also send one Discord close-list message, set `SMOKE_CONFIRM_DISCORD_SEND=true` with `SMOKE_ADMIN_ID`, `SMOKE_ADMIN_PASSWORD`, `SMOKE_CLOSED_LIST_DATE`, and `SMOKE_CLOSED_LIST_PERIOD`, then run `npm run smoke:external`.
4. Stop after one failed Riro password response to avoid account lockout.

Required smoke variables:

```bash
SMOKE_BASE_URL=https://your-production-domain.example
RIRO_SMOKE_ID=25-00000
RIRO_SMOKE_PASSWORD=...
```

Optional Discord send variables:

```bash
SMOKE_CONFIRM_DISCORD_SEND=true
SMOKE_ADMIN_ID=...
SMOKE_ADMIN_PASSWORD=...
SMOKE_CLOSED_LIST_DATE=2026-06-15
SMOKE_CLOSED_LIST_PERIOD=EIGHTH
SMOKE_FORCE_DISCORD_SEND=true
```

## Rollback

1. Roll back the Vercel deployment to the previous successful build.
2. Do not run `db push` against production.
3. If a migration has already been applied, create a forward migration that restores the expected schema.
4. Re-run the smoke checks after rollback.

## Local Smoke Test

For UI smoke tests without a database, run the dev server with mock login and no `DATABASE_URL`:

```bash
RIRO_MOCK_LOGIN=true npm run dev
```

Then run:

```bash
E2E_BASE_URL=http://localhost:3000 npx playwright test tests/home-auth-refresh.spec.ts tests/admin-reservation-flow.spec.ts tests/admin-ui-polish.spec.ts
```
