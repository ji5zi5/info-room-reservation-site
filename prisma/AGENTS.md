# PRISMA DATA MODEL

## OVERVIEW

`prisma` is the canonical PostgreSQL schema, committed migration history, and local seed entry for the reservation system.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Data model | `schema.prisma` | PostgreSQL datasource with `DATABASE_URL` and `DIRECT_URL`. |
| Migration history | `migrations/` | Production deploys run `prisma migrate deploy`. |
| Local seed | `seed.ts` | Bootstrap/dev data only; no real credentials. |

## CONVENTIONS

- Schema changes need a committed migration; do not rely on `prisma db push` for production.
- Supabase/Vercel uses pooled `DATABASE_URL` for runtime and `DIRECT_URL` for migrations.
- Keep reservation uniqueness aligned with the service invariant: one user per `date + studyPeriod`.
- Keep `PeriodSetting` unique on `date + studyPeriod`; UI/API ordering still comes from `src/lib/study-periods.ts`.
- Keep `NotificationDelivery` unique on `date + studyPeriod + kind` to prevent duplicate close-list sends.
- Status fields are strings in Prisma; validate allowed values in route/domain code before writes.
- Seed data must stay local and disposable.

## ANTI-PATTERNS

- Do not commit `prisma/dev.db` or any SQLite artifact.
- Do not edit an applied migration to change production history; add a forward migration.
- Do not put real Riro accounts, admin passwords, session secrets, or Discord webhook URLs in seed data.
- Do not run destructive migration/reset commands unless the user explicitly asks for that operation.
