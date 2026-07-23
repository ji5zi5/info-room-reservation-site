# PLAYWRIGHT E2E

## OVERVIEW

`tests` is the Playwright E2E suite for public reservation, admin console, auth resilience, profile, and responsive layout behavior.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Fixed KST dates | `e2e-time.ts`, `kst-date.ts` | Use these for Friday/Thursday policy tests. |
| CSRF mutations | `playwright-csrf.ts` | Fetches a token and sends the expected header. |
| Layout probes | `playwright-layout.ts` | Use for visible box and overflow assertions. |
| Public flow | `home-date-first.spec.ts`, `home-calendar.spec.ts`, `home-realtime-refresh.spec.ts` | Keep new scenarios out of the already-large date-first spec. |
| Admin flow | `admin-reservation-flow.spec.ts`, `admin-ui-polish.spec.ts` | Uses API login plus admin mutations. |
| Empty/invalid responses | `home-auth-refresh.spec.ts`, `home-reservation-network.spec.ts` | Must fail in UI, not with a Next runtime overlay. |
| Profile flow | `student-profile.spec.ts` | Student status, stats, and sanction visibility. |

## CONVENTIONS

- Tests require an explicit `E2E_BASE_URL`; Playwright never starts or reuses a dev server.
- The config intentionally runs one Chromium project with `workers: 1`; avoid assumptions that require parallel isolation.
- Use `mockClientDate` before navigation when date policy matters.
- Use unique login IDs with `Date.now()` for stateful flows.
- Prefer `csrfRequest` for mutating API calls instead of hand-built CSRF headers.
- Route-mock API failures when verifying client error handling; use the real local app for reservation/admin smoke.
- Local fallback credentials may be read only for loopback targets unless `E2E_ALLOW_LOCAL_LOGIN_ENV=true`.
- For UI changes, cover desktop plus the 390px mobile viewport and assert no horizontal overflow.

## ANTI-PATTERNS

- Do not commit real Riro credentials, admin passwords, Discord webhooks, screenshots, traces, or `test-results`.
- Do not add broad sleeps; wait on specific locators, responses, or layout metrics.
- Do not expand `home-date-first.spec.ts` for unrelated new UI behavior.
- Do not make E2E specs depend on Vercel, Supabase, or real Discord unless the test is an explicit external smoke path.
