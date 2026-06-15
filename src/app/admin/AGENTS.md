# ADMIN CONSOLE

## OVERVIEW

`src/app/admin` is the protected operational console for period settings, reservations, Discord close-list delivery, and user restrictions.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Page entry | `page.tsx`, `../reservation-home.tsx` | `/admin` is a protected bookmark route; ADMIN sessions on `/` also render `AdminConsole`. |
| Server gate | `layout.tsx` | Redirects non-admins before rendering children. |
| Client orchestration | `use-admin-console.ts` | Fetches settings, dashboard, reservations, users. |
| Admin API client | `admin-api-client.ts` | Fetch/mutate helpers shared by admin client components. |
| Runtime payloads | `admin-types.ts` | Zod schemas for admin API responses. |
| CSV export | `admin-csv.ts` | Reservation list CSV builder. |
| Period/settings UI | `admin-settings-panel.tsx` | Date, open/close, capacity, enabled. |
| Operations/Discord UI | `admin-dashboard-panel.tsx` | Close-list send/re-send status. |
| Reservation list UI | `admin-reservations-panel.tsx` | Status filters and no-show action. |
| User restrictions UI | `admin-users-panel.tsx` | Search, restrict, ban, unrestrict. |
| Student detail UI | `admin-student-detail.tsx` | Individual reservation history, audit trail, restriction actions. |
| Admin visual polish | `../styles/admin.css`, root `DESIGN.md` | Quiet console styling, compact controls, no explanatory subtitles under every heading. |

## CONVENTIONS

- Keep panel components presentational; side effects belong in `use-admin-console.ts`.
- Keep network details in `admin-api-client.ts`; panels should call hook actions, not raw `fetch`.
- Keep API response parsing in `admin-types.ts` with Zod.
- Preserve status filter order and labels from `src/lib/admin-reservations.ts` and `src/lib/admin-users.ts`.
- Refresh dependent dashboard/list/user state after mutating admin actions.
- Use real buttons for row actions; keep `aria-*` when toggling or opening panels.

## ADMIN-SPECIFIC RULES

- Non-admin users must never see admin UI; `layout.tsx` is the first line of defense.
- Admin workflows should feel like an operating console, not like the student reservation cards.
- ADMIN users must not see student reservation buttons; keep `src/app/reservation-home.tsx` and `src/app/api/reservations/route.ts` aligned.
- Student-specific detail/ban work should live in new focused components instead of expanding `admin-users-panel.tsx`.
- Admin CSV/export behavior should remain a derived view of the current filtered reservations list.
- Student detail belongs in the student section; other sections should not reserve empty detail-panel space.

## RESPONSIVE NOTES

- Current admin CSS is in `src/app/styles/admin.css` plus shared layout/component CSS.
- Wide grids collapse at 1040px/850px, but 390px mobile requires explicit checks.
- Restriction controls should become one-column on mobile; avoid fixed-width button clusters.
