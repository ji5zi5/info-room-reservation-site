# PROJECT KNOWLEDGE BASE

Generated: 2026-06-16
Commit: 16ed78d
Branch: main

## OVERVIEW

정보실 예약 사이트. Next.js App Router + React client UI, Prisma/Postgres persistence, 리로스쿨 인증, 시간대별 선착순 예약, 관리자 운영 콘솔, Discord 마감 명단 전송으로 구성된다.

## STRUCTURE

```
./
├── DESIGN.md            # Minimal UI design reference
├── prisma/              # Postgres schema, migrations, seed data
├── scripts/             # Predeploy and external smoke checks
├── src/app/             # Next pages, route handlers, CSS, admin UI
├── src/components/      # Shared reservation UI components
├── src/lib/             # Reservation/auth/admin/notification domain logic
└── tests/               # Playwright E2E flows and helpers
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Public reservation flow | `src/app/reservation-home.tsx`, `src/components/reservation-period-card.tsx` | `src/app/page.tsx` stays a thin entry; split `reservation-home.tsx` before growing it. |
| UI design reference | `DESIGN.md`, `src/app/styles/` | Use the Tesla-inspired restraint as a reference: compact chrome, 4px controls, minimal text; adapt it to a workflow app. |
| Admin console UI | `src/app/admin/` | Server guard is in `src/app/admin/layout.tsx`; shared client fetch helpers are in `admin-api-client.ts`. |
| API route handlers | `src/app/api/` | Request parsing, auth, CSRF, and rate limits happen at this boundary; see nested `AGENTS.md`. |
| Reservation business rules | `src/lib/reservation-service.ts`, `src/lib/period-settings.ts`, `src/lib/study-periods.ts` | Keep `8면학` before `1면학`. |
| Riro login/session | `src/lib/riro-auth.ts`, `src/lib/auth-service.ts`, `src/lib/session.ts`, `src/lib/env.ts` | Real Riro is the normal path; mock/local fallback modes require explicit env gates. |
| Admin filters/search/detail | `src/lib/admin-reservations.ts`, `src/lib/admin-users.ts`, `src/lib/admin-user-detail.ts` | Unit-tested pure helpers. |
| Discord notifications | `src/lib/closed-period-*`, `src/lib/reservation-created-notification-service.ts`, `src/lib/discord-notifications.ts`, `src/app/api/cron/closed-period-notifications/route.ts` | Closed-list auto sends after close; reservation-created alerts are optional and best-effort after confirmed reservations. |
| Deployment readiness | `DEPLOYMENT.md`, `scripts/predeploy-check.ts`, `scripts/external-smoke.ts`, `.github/workflows/ci.yml` | Vercel + Postgres path uses Prisma migrate deploy and explicit smoke gates. |
| E2E behavior | `tests/home-date-first.spec.ts`, `tests/home-auth-refresh.spec.ts`, `tests/admin-reservation-flow.spec.ts`, `tests/admin-ui-polish.spec.ts` | Keep new scenarios focused rather than expanding one large spec. |

## PROJECT INVARIANTS

- Study periods are time slots, not rooms: `EIGHTH` is `8면학`, then `FIRST` is `1면학`.
- UI/API ordering must always be `8면학` then `1면학`; use `STUDY_PERIODS` from `src/lib/study-periods.ts`.
- Default capacity is 10 unless an admin setting overrides it.
- Reservation identity is `date + studyPeriod + userId`; confirmed duplicates are blocked.
- Reservation windows use KST dates/times.
- Advance reservation is date-first, opens from tomorrow, limited to the current week, and unavailable on Friday.
- Restricted or banned users can log in but cannot create reservations.
- Discord closed-list auto sends and reservation-created alerts are controlled by admin notification settings; manual closed-list send remains available.

## DATA AND ENV

- Prisma datasource is PostgreSQL. Local SQLite assumptions are stale.
- Required production envs: `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, `ADMIN_STUDENT_NUMBERS`, `CRON_SECRET`, `DISCORD_WEBHOOK_URL`, `TRUST_FORWARDED_IP_HEADERS=true`.
- Development toggles: `RIRO_MOCK_LOGIN`, `ENABLE_LOCAL_ADMIN`, `ENABLE_LOCAL_STUDENT`, `ADMIN_LOGIN_ID`, `ADMIN_LOGIN_PASSWORD`, `LOCAL_STUDENT_*`. Production must not rely on these.
- Current scheduling: external cron triggers `GET /api/cron/closed-period-notifications`; Vercel cron triggers `GET /api/cron/maintenance`; both use `Authorization: Bearer ${CRON_SECRET}`. GitHub Actions is fallback/manual only.
- Production sessions should set Secure cookies via `src/lib/session.ts`.
- External live checks use `npm run smoke:external`; never commit real smoke credentials or webhook URLs.

## COMMANDS

```bash
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run vercel-build
npm run predeploy:check
npm run smoke:external
npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:seed
```

## TESTING NOTES

- Unit tests live beside domain files under `src/lib/*.test.ts`.
- Playwright tests are under `tests/`; they assume a running app and one Chromium worker.
- For UI changes, check desktop and mobile. The known target mobile width is 390px.
- Before claiming production readiness, run `npm run typecheck`, `npm test`, and `npm run build`.

## GOTCHAS

- `src/app/reservation-home.tsx` mixes login/sidebar/date-tab/reservation concerns; new behavior should be extracted instead of appended.
- `tests/home-date-first.spec.ts` is already large; add a new spec file for new scenarios.
- `npm run lint` is currently a TypeScript check alias, not an ESLint/autofix command.
- `npm run build` is not deploy-safe by itself; production deploys use `npm run vercel-build`.
- Production env validation gets strict under `NODE_ENV=production`; run `npm run predeploy:check` with production env loaded before trusting a deploy.
- `next-env.d.ts` can flip between `.next/dev/types` and `.next/types` after dev/build. Do not commit that churn unless CI/build behavior needs the new value.
- `.omo/` is ignored; planning artifacts there are local and will not appear in normal git status.
- `prisma/dev.db`, `.next/`, `test-results/`, and `tsconfig.tsbuildinfo` are local artifacts. They do not belong in GitHub.
