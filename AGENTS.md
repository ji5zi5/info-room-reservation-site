# PROJECT KNOWLEDGE BASE

Generated: 2026-06-12
Commit: 21d82ea
Branch: main

## OVERVIEW

정보실 예약 사이트. Next.js App Router + React client UI, Prisma/Postgres persistence, 리로스쿨 인증, 시간대별 선착순 예약, 관리자 운영 콘솔, Discord 마감 명단 전송으로 구성된다.

## STRUCTURE

```
./
├── prisma/              # Postgres schema, seed data
├── src/app/             # Next pages, route handlers, CSS, admin UI
├── src/components/      # Shared UI components, currently reservation card
├── src/lib/             # Reservation/auth/admin/notification domain logic
└── tests/               # Playwright E2E flows
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Public reservation flow | `src/app/reservation-home.tsx`, `src/components/reservation-period-card.tsx` | `src/app/page.tsx` stays a thin entry; split `reservation-home.tsx` before growing it. |
| Admin console UI | `src/app/admin/` | Server guard is in `src/app/admin/layout.tsx`; shared client fetch helpers are in `admin-api-client.ts`. |
| Reservation business rules | `src/lib/reservation-service.ts`, `src/lib/period-settings.ts`, `src/lib/study-periods.ts` | Keep `8면학` before `1면학`. |
| Riro login/session | `src/lib/riro-auth.ts`, `src/lib/auth-service.ts`, `src/lib/session.ts` | Mock admin is only for `RIRO_MOCK_LOGIN=true`. |
| Admin filters/search/detail | `src/lib/admin-reservations.ts`, `src/lib/admin-users.ts`, `src/lib/admin-user-detail.ts` | Unit-tested pure helpers. |
| Discord close-list notifications | `src/lib/closed-period-*`, `src/lib/discord-notifications.ts`, `src/app/api/cron/closed-period-notifications/route.ts` | Send only after close, not on reservation create. |
| E2E behavior | `tests/home-date-first.spec.ts`, `tests/admin-reservation-flow.spec.ts` | `home-date-first.spec.ts` is oversized; split by scenario before adding more. |

## PROJECT INVARIANTS

- Study periods are time slots, not rooms: `EIGHTH` is `8면학`, then `FIRST` is `1면학`.
- UI/API ordering must always be `8면학` then `1면학`; use `STUDY_PERIODS` from `src/lib/study-periods.ts`.
- Default capacity is 10 unless an admin setting overrides it.
- Reservation identity is `date + studyPeriod + userId`; confirmed duplicates are blocked.
- Reservation windows use KST dates/times.
- Advance reservation is date-first, opens from tomorrow, limited to the current week, and unavailable on Friday.
- Restricted or banned users can log in but cannot create reservations.
- Discord sends closed-period applicant lists only; reservation-created notifications are intentionally out of scope.

## DATA AND ENV

- Prisma datasource is PostgreSQL. Local SQLite assumptions are stale.
- Required envs for realistic local/dev deploy work: `DATABASE_URL`, `SESSION_SECRET`, `RIRO_MOCK_LOGIN`, `ADMIN_STUDENT_NUMBERS`, `CRON_SECRET`, `DISCORD_WEBHOOK_URL`.
- Vercel cron hits `GET /api/cron/closed-period-notifications`; auth is `Authorization: Bearer ${CRON_SECRET}`.
- Production sessions should set Secure cookies via `src/lib/session.ts`.

## COMMANDS

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run db:generate
npm run db:push
npm run db:seed
```

## TESTING NOTES

- Unit tests live beside domain files under `src/lib/*.test.ts`.
- Playwright tests are under `tests/`; they assume mock login flows and a running app.
- For UI changes, check desktop and mobile. The known target mobile width is 390px.
- Before claiming production readiness, run `npm run typecheck`, `npm test`, and `npm run build`.

## GOTCHAS

- `src/app/reservation-home.tsx` mixes login/sidebar/date-tab/reservation concerns; new behavior should be extracted instead of appended.
- `tests/home-date-first.spec.ts` is already large; add a new spec file for new scenarios.
- `next-env.d.ts` can flip between `.next/dev/types` and `.next/types` after dev/build. Do not commit that churn unless it is intentional.
- `.omo/` is ignored; planning artifacts there are local and will not appear in normal git status.
