# Deployment

Target platform: Vercel with managed Postgres.

## Required Environment Variables

- `DATABASE_URL`: runtime Postgres connection string. On Supabase, use the transaction pooler.
- `DIRECT_URL`: migration Postgres connection string. On Supabase, use the session pooler.
- `SESSION_SECRET`: long random secret for session signing.
- `ADMIN_STUDENT_NUMBERS`: comma-separated student numbers with admin access.
- `CRON_SECRET`: bearer token used by cron endpoints.
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for closed-period notifications.
- `TRUST_FORWARDED_IP_HEADERS`: must be `true` on Vercel production so login rate limits use the real client IP from trusted proxy headers.
- `RIRO_MOCK_LOGIN`: must be `false` in production.

Optional:

- `ENABLE_LOCAL_ADMIN`: local fallback admin login. Keep `false` in production unless explicitly needed.
- `ADMIN_LOGIN_ID`, `ADMIN_LOGIN_PASSWORD`: local admin credentials when fallback login is enabled.

## Vercel Build

Set the Vercel build command to:

```bash
npm run vercel-build
```

That command runs the predeploy environment check, Prisma Client generation, `prisma migrate deploy`, and `next build`. Keep `npm run db:push` for local development only; production uses committed migrations.

## Supabase Postgres

Use two Supabase connection strings:

- `DATABASE_URL`: Supabase transaction pooler connection, usually port `6543`. This is the runtime URL used by Vercel serverless functions.
- `DIRECT_URL`: Supabase session pooler connection, usually port `5432`. This is used by Prisma Migrate through `directUrl` in `prisma/schema.prisma`.

Supabase direct database hosts can require IPv6. If your network or deploy environment is IPv4-only, use the Supavisor session pooler for `DIRECT_URL` instead of `db.<project-ref>.supabase.co`. On Vercel, set both env vars for Production, Preview, and Development if those environments deploy against Supabase. If you use separate Supabase projects per environment, keep the matching transaction/session pair together.

The pooler host can be `aws-0`, `aws-1`, or another Supabase-assigned shard. Copy the exact host from the Supabase connection string or `supabase/.temp/pooler-url`.

## First Deploy Checklist

1. Create the managed Postgres database and set `DATABASE_URL` plus `DIRECT_URL`.
2. Set all required environment variables in Vercel.
3. Run `npm run predeploy:check` locally with the production env loaded.
4. Deploy with `npm run vercel-build`.
5. Open the site, log in with a real Riro account, and confirm `/api/me` returns the current user.
6. Open `/admin`, confirm the dashboard loads, and test one reservation close-list resend.
7. Confirm Vercel cron has both jobs:
   - `/api/cron/closed-period-notifications`
   - `/api/cron/maintenance`

## Cron Endpoints

Both cron endpoints require:

```http
Authorization: Bearer ${CRON_SECRET}
```

`/api/cron/maintenance` removes expired sessions, expired CSRF tokens, expired rate-limit buckets, releases expired temporary reservation restrictions, and revokes expired temporary sanction rows.

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
