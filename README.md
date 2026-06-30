<div align="center">

# 인천과학고등학교 정보실 예약 사이트

**인천과학고등학교 정보실 면학 예약과 관리자 운영을 위한 웹 애플리케이션**

<p>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-171A20?style=flat-square">
  <img alt="React" src="https://img.shields.io/badge/React-19-393C41?style=flat-square">
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-PostgreSQL-5C5E62?style=flat-square">
  <img alt="Deploy" src="https://img.shields.io/badge/Deploy-Vercel-3E6AE1?style=flat-square">
</p>

학생 예약, 관리자 운영, 노쇼 처리, Discord 알림까지 한 흐름으로 묶은 인천과학고등학교 정보실 예약 시스템입니다.

</div>

---

## Overview

인천과학고등학교 정보실 예약 사이트는 리로스쿨 계정 기반 학생 인증과 시간대별 선착순 예약을 중심으로 동작합니다. 관리자는 예약 현황, 학생 상세, 관리자 취소, 노쇼, 제재, 감사 로그를 같은 콘솔에서 처리합니다.

이 문서는 외부 사용자에게 사용법을 설명하기 위한 매뉴얼이 아닙니다. 저장소를 열었을 때 이 프로젝트가 어떤 서비스인지, 어떤 운영 경계를 갖는지 빠르게 알 수 있도록 정리한 소개 문서입니다.

## Service Map

| Surface | Role |
| --- | --- |
| 학생 예약 화면 | `8면학`, `1면학` 시간대별 신청과 예약 상태 확인 |
| 관리자 콘솔 | 예약자 목록, 학생 상세, 노쇼, 관리자 취소, 제재 처리 |
| 알림 시스템 | Discord 마감 명단과 운영 알림 전송 |
| 감사 기록 | 관리자 액션, 예약 전환, 제재 이력 보존 |
| 배포 환경 | Vercel, PostgreSQL, cron 기반 운영 작업 |

## Core Flow

```text
리로스쿨 로그인
      |
      v
학생 예약 신청  ----->  서버 검증  ----->  예약 확정
      |                    |                    |
      |                    v                    v
      |              제재/정원/중복 판단     관리자 콘솔
      |                                         |
      v                                         v
예약 취소                              노쇼 · 관리자 취소 · 감사 로그
```

## Product Rules

- 시간대 순서는 항상 `8면학` 다음 `1면학`입니다.
- 예약 가능 여부, 정원, 중복, 제재 상태는 서버가 최종 판단합니다.
- 노쇼는 예약 상태로 기록하고 수동 제재와 분리합니다.
- 관리자 취소는 사유를 남기고 학생 알림과 감사 기록에 반영합니다.
- Discord 알림은 운영 목적에 맞게 제한적으로 전송합니다.

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | Next.js App Router, React |
| Backend | Next.js route handlers |
| Data | Prisma, PostgreSQL |
| Validation | Zod |
| Tests | Vitest, Playwright |
| Deploy | Vercel |
| Integrations | Riro School, Discord webhook |

## Repository Shape

```text
prisma/         schema, migrations, seed data
scripts/        deployment and smoke-check helpers
src/app/        pages, route handlers, admin console, styles
src/components/ shared reservation UI
src/lib/        auth, reservation, admin, notification domain logic
tests/          Playwright E2E flows
```

## Boundaries

- 운영 DB 변경은 Prisma migration으로 관리합니다.
- 실사용 비밀값, 리로스쿨 계정, Discord webhook은 저장소에 남기지 않습니다.
- UI는 예약과 운영 업무를 빠르게 처리하는 방향으로 유지합니다.
- README는 프로젝트 소개에 집중하고, 상세 운영 절차는 별도 문서와 코드 주석에 둡니다.
