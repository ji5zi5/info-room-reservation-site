import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdminOperationsPanel } from "./admin-operations-panel";
import { AdminOperationsPayloadSchema } from "./admin-types";

describe("AdminOperationsPanel", () => {
  it("renders plain job health and only server-permitted repair actions", () => {
    // Given: healthy, stale, running-timeout, retry, review, lagged, and abandoned operation states.
    const markup = renderToStaticMarkup(createElement(AdminOperationsPanel, {
      operations,
      onNavigate: vi.fn(),
      onRepair: vi.fn()
    }));

    // When: the focused command-center panel renders.
    // Then: Korean health, timing, backlog, error, and eligible actions are truthful.
    expect(markup).toContain("정상");
    expect(markup).toContain("실행 지연");
    expect(markup).toContain("실행 시간 초과");
    expect(markup).toContain("마지막 성공");
    expect(markup).toContain("마지막 시도");
    expect(markup).toContain("<dt>대기</dt><dd>4건</dd>");
    expect(markup).toContain("가장 오래된 항목 2시간");
    expect(markup).toContain("discord_http_500");
    expect(markup).toContain("다시 시도");
    expect(markup).toContain("원격 확인");
    expect(markup).toContain("동기화");
    expect(markup).toContain("컨트롤 제거");
    expect(markup).toContain("처리 종료");
    expect(markup).not.toContain("interaction-abandoned");
  });

  it("renders exact reservation, student, and audit deep-link controls", () => {
    // Given: one actionable operation with every related-record identifier.
    const onNavigate = vi.fn();
    const markup = renderToStaticMarkup(createElement(AdminOperationsPanel, {
      operations,
      onNavigate,
      onRepair: vi.fn()
    }));

    // When / Then: all three exact-target controls remain real buttons with concise tooltips.
    expect(markup).toContain("예약 보기");
    expect(markup).toContain("학생 보기");
    expect(markup).toContain("감사 기록 보기");
    expect(markup).toContain('title="예약 상세 열기"');
    expect(markup).toContain('title="학생 상세 열기"');
    expect(markup).toContain('title="감사 기록 열기"');
  });
});

const common = {
  createdAt: "2026-08-12T22:00:00.000Z",
  expectedControlEpoch: 7,
  latestAuditActionId: "audit-1",
  reservationId: "reservation-1",
  updatedAt: "2026-08-12T23:00:00.000Z",
  userId: "user-1"
} as const;

const operations = AdminOperationsPayloadSchema.parse({
  backlogs: {
    initialSends: {
      count: 2,
      items: [{
        ...common,
        attempts: 2,
        expectedState: "PENDING_REVIEW",
        id: "initial-review",
        kind: "initial_send",
        permittedActions: ["verify_remote", "abandon"],
        remoteVerificationStatus: "ZERO_COMPLETE",
        status: "PENDING_REVIEW"
      }],
      oldestAgeMs: 3_600_000
    },
    interactions: {
      count: 4,
      items: [{
        ...common,
        attempts: 3,
        errorCode: "discord_http_500",
        expectedState: "RETRY",
        id: "interaction-retry",
        kind: "interaction",
        permittedActions: ["retry"],
        status: "RETRY"
      }, {
        ...common,
        attempts: 8,
        errorCode: "attempts_exhausted",
        expectedState: "ABANDONED",
        id: "interaction-abandoned",
        kind: "interaction",
        latestAuditActionId: null,
        permittedActions: [],
        status: "ABANDONED"
      }],
      oldestAgeMs: 7_200_000
    },
    syncs: {
      count: 1,
      items: [{
        ...common,
        expectedState: "RETRY:2:1:7",
        id: "sync-lag",
        kind: "sync",
        messageRevision: 2,
        permittedActions: ["sync", "remove_controls"],
        status: "RETRY",
        syncedRevision: 1
      }],
      oldestAgeMs: 1_800_000
    }
  },
  control: { enabled: true, epoch: 7, pendingRemoteCleanup: false },
  generatedAt: "2026-08-13T00:00:00.000Z",
  jobs: [{
    backlogCount: 0,
    failureCode: null,
    health: { code: "healthy", status: "ok" },
    job: "CLOSED_PERIOD_NOTIFICATIONS",
    lastAttemptAt: "2026-08-12T23:59:30.000Z",
    lastSuccessAt: "2026-08-12T23:59:30.000Z",
    status: "SUCCEEDED"
  }, {
    backlogCount: 4,
    failureCode: "discord_http_500",
    health: { code: "stale", status: "degraded" },
    job: "DISCORD_INTERACTIONS",
    lastAttemptAt: "2026-08-12T22:00:00.000Z",
    lastSuccessAt: "2026-08-12T21:59:00.000Z",
    status: "FAILED"
  }, {
    backlogCount: 1,
    failureCode: "job_timeout",
    health: { code: "running_timeout", status: "degraded" },
    job: "DISCORD_RESERVATION_OUTBOX",
    lastAttemptAt: "2026-08-12T23:50:00.000Z",
    lastSuccessAt: "2026-08-12T23:40:00.000Z",
    status: "RUNNING"
  }]
});
