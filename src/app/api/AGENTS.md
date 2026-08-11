# API ROUTES

## OVERVIEW

`src/app/api` is the HTTP boundary for auth, reservations, admin operations, cron, CSRF, and period summaries.

## STRUCTURE

```
src/app/api/
├── admin/        # Admin dashboard, settings, users, reservation transitions
├── auth/         # Riro login and logout
├── cron/         # Vercel cron endpoints
├── discord/      # Signed Discord interaction endpoint
├── reservations/ # Student create/cancel reservation endpoints
├── csrf/         # CSRF token endpoint
├── me/           # Current session payload
└── periods/      # Student-facing period summaries
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Student reservation create | `reservations/route.ts` | Uses request safety, CSRF, user session, rate limit, `createReservation`, and optional best-effort reservation-created Discord alerts after confirmation. |
| Student reservation cancel | `reservations/[id]/route.ts` | Must apply cancellation restriction through the service/store path. |
| Riro login | `auth/riro/login/route.ts` | Keep mock and local admin gates aligned with `src/lib/env.ts`. |
| Current user | `me/route.ts` | Include restriction expiry so expired temporary restrictions do not block UI forever. |
| Period summaries | `periods/route.ts` | Do not create period settings for out-of-policy dates. |
| Admin settings | `admin/period-settings/route.ts`, `admin/notification-settings/route.ts` | Period writes stay date + period scoped; notification settings are global toggles. |
| Admin API subtree | `admin/` | Nested `AGENTS.md` covers audit, mutation, and transition rules. |
| Admin transitions | `admin/reservations/[id]/cancel/route.ts`, `admin/reservations/[id]/no-show/route.ts` | Only transition `CONFIRMED` reservations. |
| User sanctions | `admin/users/[id]/restriction/route.ts` | `BANNED` uses `days: null`; `RESTRICTED` requires days. |
| Discord send | `admin/notifications/closed-periods/send/route.ts`, `reservations/route.ts` | Manual close-list sends stay in admin; reservation-created alerts are student-route best-effort only. |
| Discord interactions | `discord/interactions/route.ts` | Preserve bounded raw bytes for Ed25519 verification before JSON parsing; this is the sole exception to the shared JSON reader. |
| Cron | `cron/closed-period-notifications/route.ts`, `cron/maintenance/route.ts` | Separate `CLOSED_PERIOD_CRON_SECRET` and `MAINTENANCE_CRON_SECRET` bearer tokens are required. |

## CONVENTIONS

- Use `readJsonRequest` for JSON bodies; do not call `request.json()` directly. The signed Discord interaction endpoint instead reads one bounded raw byte body, verifies Ed25519, then decodes and parses those exact bytes.
- Validate route input with Zod at the boundary and return `jsonError` for expected failures.
- Use `requireUser()` for student routes and `requireAdmin()` for admin routes.
- Apply `assertRequestSafe`/CSRF/rate-limit checks before mutations.
- Keep route handlers thin; business rules belong in `src/lib`.
- Never log Riro credentials, session cookies, CSRF tokens, or Discord webhook URLs.

## ANTI-PATTERNS

- Do not hide server errors by returning empty arrays from admin read APIs.
- Do not mutate reservations already `NO_SHOW` or `CANCELLED` from admin transition routes.
- Do not let production enable mock login or local admin through loose env defaults.
- Do not add broad catch-all success responses around external integrations.
