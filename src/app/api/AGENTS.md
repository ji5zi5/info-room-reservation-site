# API ROUTES

## OVERVIEW

`src/app/api` is the HTTP boundary for auth, reservations, admin operations, cron, CSRF, and period summaries.

## STRUCTURE

```
src/app/api/
├── admin/        # Admin dashboard, settings, users, reservation transitions
├── auth/         # Riro login and logout
├── cron/         # Vercel cron endpoints
├── reservations/ # Student create/cancel reservation endpoints
├── csrf/         # CSRF token endpoint
├── me/           # Current session payload
└── periods/      # Student-facing period summaries
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Student reservation create | `reservations/route.ts` | Uses request safety, CSRF, user session, rate limit, and `createReservation`. |
| Student reservation cancel | `reservations/[id]/route.ts` | Must apply cancellation restriction through the service/store path. |
| Riro login | `auth/riro/login/route.ts` | Keep mock and local admin gates aligned with `src/lib/env.ts`. |
| Current user | `me/route.ts` | Include restriction expiry so expired temporary restrictions do not block UI forever. |
| Period summaries | `periods/route.ts` | Do not create period settings for out-of-policy dates. |
| Admin settings | `admin/period-settings/route.ts` | Admin-only; settings writes must stay date + period scoped. |
| Admin API subtree | `admin/` | Nested `AGENTS.md` covers audit, mutation, and transition rules. |
| Admin transitions | `admin/reservations/[id]/cancel/route.ts`, `admin/reservations/[id]/no-show/route.ts` | Only transition `CONFIRMED` reservations. |
| User sanctions | `admin/users/[id]/restriction/route.ts` | `BANNED` uses `days: null`; `RESTRICTED` requires days. |
| Discord send | `admin/notifications/closed-periods/send/route.ts` | Manual close-list send only; never reservation-created notifications. |
| Cron | `cron/closed-period-notifications/route.ts`, `cron/maintenance/route.ts` | `Authorization: Bearer ${CRON_SECRET}` required. |

## CONVENTIONS

- Use `readJsonRequest` for JSON bodies; do not call `request.json()` directly.
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
