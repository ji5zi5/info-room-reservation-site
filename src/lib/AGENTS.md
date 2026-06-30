# DOMAIN LIBRARY

## OVERVIEW

`src/lib` owns business logic, persistence adapters, Riro auth parsing, session helpers, admin filtering, and Discord notification assembly.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Study period ordering | `study-periods.ts` | `STUDY_PERIODS = ["EIGHTH", "FIRST"]`; import this instead of re-sorting ad hoc. |
| Reservation rules | `reservation-service.ts` | Transactional capacity/duplicate/window/restriction checks. |
| Period defaults/settings | `period-settings.ts` | Default open/close/capacity and per-date settings. |
| Persistence adapters | `prisma-reservation-store.ts`, `memory-reservation-store.ts` | Keep store contract aligned with `reservation-service.ts`. |
| Riro auth | `riro-auth.ts`, `auth-service.ts` | Real login path plus mock mode. |
| Env and local fallback gates | `env.ts`, `local-login.ts`, `mock-dev-mode.ts` | Mock, local admin, and local student modes are separate switches. |
| Sessions | `session.ts` | `requireUser()` and `requireAdmin()` live here. |
| Admin helpers | `admin-reservations.ts`, `admin-users.ts`, `admin-user-detail.ts`, `admin-dashboard.ts` | Pure filtering/sorting/summary helpers. |
| Discord notifications | `discord-notifications.ts`, `closed-period-notifications.ts`, `closed-period-notification-service.ts`, `reservation-created-notification-service.ts`, `prisma-notification-repository.ts` | Closed-list delivery and optional best-effort reservation-created alerts. |

## CONVENTIONS

- External input is parsed at route/API boundaries; domain functions receive typed values.
- Expected domain outcomes use discriminated unions with `kind`.
- Time-window logic is KST-based. Keep date strings in `YYYY-MM-DD` form.
- Tests for pure helpers live beside the helper as `*.test.ts`.
- Prisma-specific details stay in Prisma adapters/repositories, not in pure services.

## INVARIANTS

- A reservation can be confirmed only when the period exists, is enabled, is open, is not full, is not duplicate, and the user is not restricted.
- `BANNED` always blocks reservation creation.
- `RESTRICTED` blocks until `restrictedUntil` is null or in the future.
- Discord payloads must include `allowed_mentions: { parse: [] }`.
- Discord webhook execution should use `wait=true` so message IDs can be recorded.
- `NotificationDelivery` uniqueness is `date + studyPeriod + kind`; use it to avoid duplicate cron sends.
- Reservation-created Discord alerts are immediate best-effort sends and do not use `NotificationDelivery`.

## ANTI-PATTERNS

- Do not duplicate Korean labels or period ordering outside `study-periods.ts`.
- Do not use random success, fake close, or deceptive delay logic in reservation services.
- Do not let reservation-created Discord failures change reservation success responses.
- Do not make local admin/student fallback depend on `RIRO_MOCK_LOGIN`; use explicit env gates.
- Do not add broad `catch` blocks in services unless they convert a known external failure into a typed result.
- Do not let admins restrict themselves or target other admins in user-management helpers.
