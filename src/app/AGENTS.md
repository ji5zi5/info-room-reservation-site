# APP ROUTES AND UI

## OVERVIEW

`src/app` owns the Next.js surface: public login/reservation UI, admin routes, API route handlers, and CSS imports.

## STRUCTURE

```
src/app/
├── page.tsx             # Thin root entry
├── reservation-home.tsx # Public reservation shell and admin handoff
├── admin/               # Protected admin console
├── api/                 # Route handlers and cron endpoints
├── styles/              # Global CSS split by role
├── layout.tsx
└── globals.css
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Login and reservation tabs | `reservation-home.tsx` | Already large; extract components for any substantial change. |
| Visual style | `styles/`, root `DESIGN.md` | Minimal chrome, short labels, compact 4px controls; do not import showroom hero patterns into workflow screens. |
| Admin page protection | `admin/layout.tsx` | Must call `requireAdmin()` before rendering admin UI. |
| Admin route UI | `admin/page.tsx`, `admin/admin-console.tsx`, `reservation-home.tsx` | Admins also see `AdminConsole` immediately after normal login. |
| Route handlers | `api/` | Nested `AGENTS.md` covers request parsing, auth, CSRF, and mutation rules. |
| Reservation API | `api/reservations/route.ts`, `api/reservations/[id]/route.ts` | Server must be the authority for capacity, duplicates, windows, restrictions. |
| Period summary API | `api/periods/route.ts` | Must include applicants and current user's `myReservationId`. |
| Cron | `api/cron/closed-period-notifications/route.ts`, `api/cron/maintenance/route.ts` | Bearer secret required. |

## CONVENTIONS

- Route handlers parse request bodies with Zod at the boundary.
- Route handlers return `jsonError` from `src/lib/http.ts` for expected failures.
- Admin APIs must use `requireAdmin()`; regular reservation APIs use `requireUser()` plus domain-level restrictions.
- Root page should render `AdminConsole` for ADMIN sessions instead of student reservation controls.
- Client components should keep Korean labels short and avoid explanatory product copy in the UI.
- Use lucide icons for button/tool affordances when an icon exists.
- Prefer dense, stable operational layouts over marketing sections or decorative cards.

## UI INVARIANTS

- `8면학` cards appear before `1면학` cards.
- `당일예약` and `사전예약` tab areas must not shift size when switching.
- `사전예약` chooses date before showing period cards.
- Applicant lists are collapsed by default and toggle with accessible buttons.
- Mobile layouts must avoid horizontal overflow at 390px.
- Buttons, chips, pills, and compact controls should preserve the design radius instead of drifting into oversized rounded badges.

## ANTI-PATTERNS

- Do not put admin-only controls behind UI-only checks; protect the API too.
- Do not add fake success, fake close, random success, or deceptive delay flows.
- Do not grow `reservation-home.tsx` further for new sections; extract a component.
- Do not put route-handler business rules directly in JSX.
