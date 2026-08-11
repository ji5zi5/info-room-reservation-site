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
| Discord notifications | `discord-notifications.ts`, `closed-period-notifications.ts`, `closed-period-notification-service.ts`, `reservation-created-notification-service.ts`, `discord-reservation-outbox.ts`, `prisma-discord-reservation-message-repository.ts` | Closed-list delivery plus durable outbox delivery/recovery for reservation-created alerts, with optional Discord Application bot transport. |

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
- With confirmed consent, Discord reservation payloads may include student identity and the reservation reason only in the configured private operations channel. The configured role guard, explicit one-to-one administrator map, `allowed_mentions: { parse: [] }`, and 30-day bot-message/ledger retention are mandatory; public and student-facing surfaces remain prohibited.
- `NotificationDelivery` uniqueness is `date + studyPeriod + kind`; use it to avoid duplicate cron sends.
- Reservation-created Discord alerts are durably enqueued in `DiscordReservationMessage` during reservation creation and recovered by the outbox worker; delivery failures do not change reservation success.

## ANTI-PATTERNS

- Do not duplicate Korean labels or period ordering outside `study-periods.ts`.
- Do not expose peer applicant identity or internal shadow-ban profile fields through student-facing DTOs.
- Do not use random success, fake close, or deceptive delay logic in reservation services.
- Do not let reservation-created Discord failures change reservation success responses.
- Do not make local admin/student fallback depend on `RIRO_MOCK_LOGIN`; use explicit env gates.
- Do not add broad `catch` blocks in services unless they convert a known external failure into a typed result.
- Do not let admins restrict themselves or target other admins in user-management helpers.
