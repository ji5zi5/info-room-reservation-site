# ADMIN API ROUTES

## OVERVIEW

`src/app/api/admin` is the protected HTTP surface for operational reads, settings writes, reservation transitions, student restrictions, audit logs, statistics, and manual Discord close-list sends.

## STRUCTURE

```
src/app/api/admin/
├── dashboard/                 # Daily period summaries for the console
├── notification-settings/     # Global Discord notification toggles
├── period-settings/           # Date + period open/close/capacity writes
├── reservations/              # Admin reservation list and transitions
├── users/                     # Student search, detail, restrictions, sessions
├── notifications/closed-periods/send/ # Manual Discord close-list send
├── actions/                   # Audit action search
└── statistics/                # Admin statistics ranges
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Settings writes | `period-settings/route.ts`, `notification-settings/route.ts` | Patch period settings by date + studyPeriod and Discord notification settings globally; write `AdminAction` rows. |
| Reservation cancel/no-show | `reservations/[id]/cancel/route.ts`, `reservations/[id]/no-show/route.ts` | Only transition `CONFIRMED` rows. |
| User restriction | `users/[id]/restriction/route.ts`, `users/[id]/restriction/restriction-route-support.ts` | `BANNED` uses `days: null`; `RESTRICTED` requires days. |
| Student detail | `users/[id]/route.ts` | Includes reservation history, active sanction, and action history. |
| Manual Discord send | `notifications/closed-periods/send/route.ts` | Closed-list only; audit success and failure. |
| Statistics | `statistics/route.ts` | Date range reads; keep the max range guard. |

## CONVENTIONS

- Read routes use `requireAdmin()`; mutating routes use `requireAdminSession()` so the actor ID is available.
- Mutations run request safety, CSRF validation, and route rate-limit checks before touching Prisma.
- JSON bodies go through `readJsonRequest`; query strings use Zod `safeParse`.
- Expected failures return `jsonError` with stable `code` strings for the admin client.
- Mutations that change settings, reservations, restrictions, sessions, or notification delivery must leave an `AdminAction` trail when the domain supports it.
- Store request source as a hash only; never persist or log raw IPs, cookies, CSRF tokens, credentials, or webhook URLs.
- Admin reservation transitions return conflicts for already handled rows instead of overwriting status.
- Admin user actions must not target admins or let an admin restrict themselves.

## ANTI-PATTERNS

- Do not bypass the shared admin route support helpers just to save a few lines.
- Do not return empty success data for failed admin reads; expose a failure state to the UI.
- Do not send reservation-created Discord messages from this subtree.
- Do not add direct local-login or mock-mode shortcuts to admin APIs.
