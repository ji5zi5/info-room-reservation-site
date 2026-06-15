# 정보실 예약 사이트

리로스쿨 계정으로 로그인해 정보실 면학 시간대를 예약하고, 관리자가 예약 현황과 제재, 마감 명단 Discord 전송을 운영하는 Next.js App Router 애플리케이션입니다.

## 주요 기능

- 리로스쿨 학생 인증 기반 로그인
- `8면학` -> `1면학` 순서의 시간대별 선착순 예약
- 당일예약과 사전예약 날짜 선택
- 예약 취소, 미출석, 관리자 취소에 따른 예약 제한
- 관리자 콘솔의 기간 설정, 예약자 관리, 학생 제재, 감사 로그
- 마감된 시간대 신청자 명단 Discord 전송
- Vercel cron 기반 마감 알림과 유지보수 cleanup

## 기술 스택

- Next.js 16 App Router
- React 19
- Prisma 6 + PostgreSQL
- Zod
- Vitest
- Playwright
- Vercel

## 빠른 시작

```bash
npm install
npm run db:generate
npm run dev
```

로컬에서 DB 없이 UI 흐름을 빠르게 확인하려면 mock 로그인 모드를 사용할 수 있습니다.

```bash
RIRO_MOCK_LOGIN=true npm run dev
```

운영과 비슷한 환경에서는 PostgreSQL `DATABASE_URL`을 설정한 뒤 마이그레이션과 seed를 실행합니다.

```bash
npm run db:migrate
npm run db:seed
```

## 환경 변수

프로덕션 필수:

```env
DATABASE_URL="postgresql://postgres.PROJECT_REF:PASSWORD@aws-N-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
DIRECT_URL="postgresql://postgres.PROJECT_REF:PASSWORD@aws-N-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
SESSION_SECRET="long-random-secret"
ADMIN_STUDENT_NUMBERS=""
CRON_SECRET="long-random-secret"
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
TRUST_FORWARDED_IP_HEADERS="true"
RIRO_MOCK_LOGIN="false"
ENABLE_LOCAL_ADMIN="false"
ENABLE_LOCAL_STUDENT="false"
```

선택 로컬 설정:

```env
ADMIN_LOGIN_ID=""
ADMIN_LOGIN_PASSWORD=""
LOCAL_STUDENT_LOGIN_ID=""
LOCAL_STUDENT_LOGIN_PASSWORD=""
LOCAL_STUDENT_NUMBER=""
```

전체 예시는 `.env.example`을 참고하세요. 실제 리로스쿨 계정, Discord webhook, 세션 비밀값은 커밋하지 않습니다.

## 명령어

| Command | Description |
| --- | --- |
| `npm run dev` | Next.js 개발 서버 |
| `npm run typecheck` | TypeScript 검사 |
| `npm test` | Vitest unit test |
| `npm run build` | Prisma generate + Next production build |
| `npm run vercel-build` | predeploy check + Prisma migrate deploy + build |
| `npm run predeploy:check` | 프로덕션 env 안전성 검사 |
| `npm run smoke:external` | 실제 배포 URL의 Riro/API/선택 Discord smoke |
| `npm run db:migrate` | 로컬 개발 migration |
| `npm run db:deploy` | 운영 migration deploy |
| `npm run db:seed` | seed 데이터 생성 |

## 배포

배포 대상은 Vercel + managed PostgreSQL입니다.

1. Supabase에서 Postgres 프로젝트를 만들고 connection string 두 개를 준비합니다.
2. `DATABASE_URL`에는 transaction pooler URL을, `DIRECT_URL`에는 session pooler URL을 넣습니다.
3. Vercel 프로젝트에 필수 env를 설정합니다.
4. Build command는 `vercel.json`의 `npm run vercel-build`를 사용합니다.
5. 프로덕션에는 `RIRO_MOCK_LOGIN=false`, `ENABLE_LOCAL_ADMIN=false`, `TRUST_FORWARDED_IP_HEADERS=true`를 사용합니다.
6. Vercel cron이 아래 두 endpoint를 호출하도록 설정되어 있는지 확인합니다.

```text
/api/cron/closed-period-notifications
/api/cron/maintenance
```

두 cron endpoint는 `Authorization: Bearer ${CRON_SECRET}`가 필요합니다.

자세한 배포 절차와 rollback은 `DEPLOYMENT.md`를 참고하세요.

## 외부 연동 Smoke

실제 배포 URL에서 리로스쿨 로그인과 `/api/me` 응답을 확인하려면 private shell에서만 smoke env를 설정합니다.

```bash
SMOKE_BASE_URL=https://your-production-domain.example
RIRO_SMOKE_ID=25-00000
RIRO_SMOKE_PASSWORD=...
npm run smoke:external
```

Discord close-list 전송까지 확인하려면 `SMOKE_CONFIRM_DISCORD_SEND=true`와 관리자 계정, 날짜, 시간대를 명시해야 합니다. 한 번 실패한 리로스쿨 비밀번호 응답 후에는 계정 잠금을 피하기 위해 반복 시도를 멈춥니다.

## 테스트

```bash
npm run typecheck
npm test
npm run build
```

Playwright smoke는 실행 중인 dev server를 대상으로 돌립니다.

```bash
E2E_BASE_URL=http://localhost:3000 npx playwright test tests/home-auth-refresh.spec.ts tests/admin-reservation-flow.spec.ts tests/admin-ui-polish.spec.ts
```

## 프로젝트 구조

```text
prisma/       PostgreSQL schema, migrations, seed
scripts/      predeploy and external smoke scripts
src/app/      Next.js pages, route handlers, admin UI, styles
src/components/ shared reservation UI components
src/lib/      auth, reservation, admin, notification domain logic
tests/        Playwright E2E flows and helpers
```

## 운영 규칙

- 시간대 표기는 항상 `8면학` 다음 `1면학`입니다.
- 예약 가능 여부, 정원, 중복, 제재 상태는 서버가 최종 판단합니다.
- Discord는 마감된 시간대 신청자 명단만 전송합니다.
- 운영 DB에는 `prisma db push`를 사용하지 않고 migration deploy만 사용합니다.
- `.next`, `.omo`, `test-results`, `prisma/dev.db`, `tsconfig.tsbuildinfo`는 GitHub에 올리지 않습니다.
