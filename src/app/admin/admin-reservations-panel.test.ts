import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AdminMutationResult, CancelReservationData, NoShowReservationData } from "./admin-api-client";
import { AdminReservationsPanel } from "./admin-reservations-panel";
import type { AdminReservation } from "./admin-types";

const confirmedReservation = {
  createdAt: "2026-06-16T00:00:00.000Z",
  date: "2026-06-16",
  id: "reservation-confirmed",
  reason: "학습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  user: {
    bookingStatus: "ACTIVE",
    id: "student-1",
    name: "테스트학생",
    role: "STUDENT",
    studentNumber: "25001"
  }
} satisfies AdminReservation;

const cancelledReservation = {
  ...confirmedReservation,
  id: "reservation-cancelled",
  status: "CANCELLED"
} satisfies AdminReservation;

const mutationReservation = {
  createdAt: "2026-06-16T00:00:00.000Z",
  date: "2026-06-16",
  id: confirmedReservation.id,
  reason: confirmedReservation.reason,
  status: "CONFIRMED",
  studyPeriod: confirmedReservation.studyPeriod,
  updatedAt: "2026-06-16T00:05:00.000Z",
  userId: confirmedReservation.user.id
};

async function cancelReservationSuccess(): Promise<AdminMutationResult<CancelReservationData>> {
  return { data: { reservation: { ...mutationReservation, status: "CANCELLED" } }, kind: "ok" };
}

async function markNoShowSuccess(): Promise<AdminMutationResult<NoShowReservationData>> {
  return {
    data: {
      cancelledFutureReservationCount: 2,
      reservation: { ...mutationReservation, status: "NO_SHOW" },
      user: {
        bookingStatus: "BANNED",
        generation: 25,
        id: confirmedReservation.user.id,
        name: confirmedReservation.user.name,
        restrictedUntil: null,
        restrictionReason: "정보실 예약 노쇼",
        role: confirmedReservation.user.role,
        shadowBanProfile: "NORMAL",
        studentNumber: confirmedReservation.user.studentNumber
      }
    },
    kind: "ok"
  };
}

describe("AdminReservationsPanel", () => {
  it("renders a compact manual student reservation form", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=&status=CONFIRMED&studyPeriod=ALL",
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toContain("학생 추가");
    expect(markup).toContain("학번");
    expect(markup).toContain("시간대");
    expect(markup).toContain("사유");
    expect(markup).toContain("추가");
    expect(markup).toContain("2026-06-16");
  });

  it("exposes cancellation and no-show as accessible confirmation entry points before either mutation can run", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=&status=CONFIRMED&studyPeriod=ALL",
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [confirmedReservation],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toMatch(/<button(?=[^>]*aria-haspopup="dialog")[^>]*>[\s\S]*?취소[\s\S]*?<\/button>/u);
    expect(markup).toMatch(/<button(?=[^>]*aria-haspopup="dialog")[^>]*>[\s\S]*?노쇼[\s\S]*?<\/button>/u);
    expect(markup).toContain("0건 선택");
    expect(markup).toMatch(/<input(?=[^>]*aria-label="테스트학생 예약 선택")(?=[^>]*type="checkbox")[^>]*>/u);
  });

  it("never renders a bulk checkbox for a non-confirmed row", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=&status=ALL&studyPeriod=ALL",
        onBulkCancelReservations: async () => ({
          data: { results: [], summary: { cancelled: 0, conflict: 0, invalidStatus: 0, notFound: 0, total: 0 } },
          kind: "ok" as const
        }),
        onCancelReservation: cancelReservationSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [cancelledReservation],
        statusFilter: "ALL"
      })
    );

    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toMatch(/<button[^>]*>[\s\S]*?<svg[^>]*lucide-user-x[\s\S]*?노쇼[\s\S]*?<\/button>/u);
  });

  it("renders the existing cancellation dialog for a dedicated deep-link handoff outside the visible list", () => {
    // Given / When
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: cancelReservationSuccess,
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=cannot-find-target&status=CONFIRMED&studyPeriod=ALL",
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "cannot-find-target",
        requestedCancellation: confirmedReservation,
        reservations: [],
        statusFilter: "CONFIRMED"
      })
    );

    // Then
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("예약을 관리자 취소할까요?");
    expect(markup).toContain(confirmedReservation.user.name);
    expect(markup).toContain(confirmedReservation.date);
  });

  it("renders a server CSV download and current paged count without client CSV copy", () => {
    // Given / When
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=%ED%95%99%EC%83%9D&status=ALL&studyPeriod=EIGHTH",
        onCancelReservation: cancelReservationSuccess,
        onLoadMore: () => undefined,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onRestartTraversal: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        pagination: {
          currentTotalCount: 73,
          hasHiddenPrevious: false,
          loadedCount: 50,
          loadingMore: false,
          nextCursor: "cursor-2",
          restartRequired: false
        },
        periodFilter: "EIGHTH",
        query: "학생",
        reservations: [confirmedReservation],
        statusFilter: "ALL"
      })
    );

    // Then
    expect(markup).toContain('href="/api/admin/exports/reservations?date=2026-06-16&amp;query=%ED%95%99%EC%83%9D&amp;status=ALL&amp;studyPeriod=EIGHTH"');
    expect(markup).toContain("CSV 다운로드");
    expect(markup).toContain("50개 표시 / 현재 73건");
    expect(markup).toContain("더 보기");
    expect(markup).not.toContain("명단 복사");
  });

  it("marks an exact URL record as the focus target independently of list filters", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        exportUrl: "/api/admin/exports/reservations?date=2026-06-16&query=&status=CONFIRMED&studyPeriod=ALL",
        focusRecordId: confirmedReservation.id,
        onCancelReservation: cancelReservationSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "hidden-by-filter",
        reservations: [confirmedReservation],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toMatch(/<div(?=[^>]*class="[^"]*table-line[^"]*")(?=[^>]*data-focus-target="true")(?=[^>]*tabindex="-1")[^>]*>/u);
  });
});
