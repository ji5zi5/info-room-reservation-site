<div align="center">

# 인천과학고등학교 정보실 예약 사이트

**정보실 면학 예약을 신청하고, 운영자가 예약·노쇼·알림을 관리하는 내부 운영 시스템**

<p>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-171A20?style=flat-square">
  <img alt="React" src="https://img.shields.io/badge/React-19-393C41?style=flat-square">
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-PostgreSQL-5C5E62?style=flat-square">
  <img alt="Deploy" src="https://img.shields.io/badge/Deploy-Vercel-3E6AE1?style=flat-square">
</p>

<p>
  <strong>리로스쿨 인증</strong> · <strong>선착순 예약</strong> · <strong>관리자 콘솔</strong> · <strong>Discord 운영 알림</strong>
</p>

</div>

---

## 서비스 개요

인천과학고등학교 정보실 예약 사이트는 학생의 정보실 면학 신청과 관리자의 예약 운영을 한 곳에서 처리합니다. 예약 가능 여부, 정원, 중복 신청, 제재 상태는 서버에서 판정하고, 운영자는 관리자 콘솔에서 예약 상태와 감사 기록을 확인합니다.

## 서비스 구성

| 영역 | 역할 |
| --- | --- |
| 학생 예약 | 리로스쿨 계정 기반 인증, 날짜·면학 시간대별 신청, 현재 예약 확인 |
| 관리자 콘솔 | 예약자 목록, 학생 상세, 관리자 취소, 노쇼, 제재 처리 |
| 운영 알림 | Discord 마감 명단과 주요 운영 알림 전송 |
| 감사 기록 | 관리자 액션, 예약 상태 전환, 제재 이력 보존 |
| 배포 환경 | Vercel, PostgreSQL, cron 기반 운영 작업 |

## 운영 흐름

```text
리로스쿨 인증
      |
      v
예약 신청  ----->  서버 검증  ----->  예약 확정
                    |                    |
                    v                    v
              제재/정원/중복 판단     관리자 콘솔
                                         |
                                         v
                              취소 · 노쇼 · 감사 기록 · 알림
```

## 운영 원칙

- 시간대 순서는 항상 `8면학` 다음 `1면학`입니다.
- 예약 가능 여부, 정원, 중복 신청, 제재 상태는 서버가 최종 판단합니다.
- 노쇼는 `Reservation.status = NO_SHOW`로 기록하고 수동 제재와 분리합니다.
- 관리자 취소는 제재 없이 취소 사유, 학생 알림, 감사 기록에 반영합니다.
- Discord 알림은 마감 명단과 운영상 필요한 범위로 제한합니다.
- 예약 확정은 Discord 전송 결과와 독립적이며, 생성 시 `DiscordReservationMessage`에 전송 작업을 기록하고 outbox가 재시도·복구합니다.

## 기술 구성

| 레이어 | 기술 |
| --- | --- |
| Frontend | Next.js App Router, React |
| Backend | Next.js route handlers |
| Data | Prisma, PostgreSQL |
| Validation | Zod |
| Tests | Vitest, Playwright |
| Deploy | Vercel |
| Integrations | Riro School, Discord webhook + optional Discord Application bot |

## 코드 구조

```text
prisma/         schema, migrations, seed data
scripts/        deployment and smoke-check helpers
src/app/        pages, route handlers, admin console, styles
src/components/ shared reservation UI
src/lib/        auth, reservation, admin, notification domain logic
tests/          Playwright E2E flows
```

## 운영 경계

- 운영 DB 변경은 Prisma migration으로 관리합니다.
- 실사용 비밀값, 리로스쿨 계정, Discord webhook은 저장소에 남기지 않습니다.
- 리로스쿨과 Discord 연동은 운영 환경 변수로만 연결합니다.
- UI는 빠른 예약 판단과 관리자 처리 속도를 우선합니다.
