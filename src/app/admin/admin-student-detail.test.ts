import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AdminMutationResult,
  ApplyRestrictionData,
  NoShowReservationData
} from "./admin-api-client";
import { AdminStudentDetail } from "./admin-student-detail";
import type { UserRestrictionDraft } from "./admin-console-state";
import type { AdminUserDetail } from "./admin-types";

const restrictionDraft = {
  days: "7",
  reason: "",
  shadowBanProfile: "NORMAL",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

const mutationUser = {
  bookingStatus: "BANNED",
  generation: 25,
  id: "user-1",
  name: "테스트학생",
  restrictedUntil: null,
  restrictionReason: "정보실 예약 노쇼",
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "25001"
} satisfies ApplyRestrictionData["user"];

const mutationReservation = {
  createdAt: "2026-06-16T00:00:00.000Z",
  date: "2026-06-16",
  id: "reservation-confirmed",
  reason: "학습",
  status: "NO_SHOW",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-16T00:05:00.000Z",
  userId: mutationUser.id
} satisfies NoShowReservationData["reservation"];

async function applyRestrictionSuccess(): Promise<AdminMutationResult<ApplyRestrictionData>> {
  return { data: { cancelledFutureReservationCount: 1, user: mutationUser }, kind: "ok" };
}

async function markNoShowSuccess(): Promise<AdminMutationResult<NoShowReservationData>> {
  return {
    data: { cancelledFutureReservationCount: 1, reservation: mutationReservation, user: mutationUser },
    kind: "ok"
  };
}

const detail = {
  adminActions: [],
  auditLogs: [],
  currentReservations: [],
  reservationHistory: [],
  sanctions: [],
  sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
  sessionSummary: { activeCount: 4, expiredCount: 1, totalCount: 5 },
  summary: { cancelledCount: 3, confirmedCount: 12, noShowCount: 2 },
  user: {
    bookingStatus: "ACTIVE",
    createdAt: "2026-06-16T00:00:00.000Z",
    generation: 32,
    id: "user-1",
    name: "테스트학생",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    shadowBanProfile: "NORMAL",
    studentNumber: "25001",
    updatedAt: "2026-06-16T00:00:00.000Z"
  }
} satisfies AdminUserDetail;

const detailWithCurrentReservation = {
  ...detail,
  currentReservations: [
    {
      createdAt: "2026-06-16T00:00:00.000Z",
      date: "2026-06-16",
      id: "reservation-confirmed",
      reason: "학습",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      updatedAt: "2026-06-16T00:00:00.000Z",
      userId: "user-1"
    },
    {
      createdAt: "2026-06-16T00:00:00.000Z",
      date: "2026-06-16",
      id: "reservation-cancelled",
      reason: "학습",
      status: "CANCELLED",
      studyPeriod: "FIRST",
      updatedAt: "2026-06-16T00:00:00.000Z",
      userId: "user-1"
    }
  ]
} satisfies AdminUserDetail;

const detailWithAuditLog = {
  ...detail,
  auditLogs: [
    {
      action: "USER_RESTRICTION_APPLY",
      actorId: "admin-1",
      createdAt: "2026-06-16T00:00:00.000Z",
      detail: "학생 제재 적용",
      id: "audit-1"
    }
  ]
} satisfies AdminUserDetail;

const adminDetail = {
  ...detail,
  user: {
    ...detail.user,
    generation: 0,
    name: "일반 계정",
    role: "ADMIN",
    studentNumber: "local_student_a"
  }
} satisfies AdminUserDetail;

const localStudentDetail = {
  ...detail,
  user: {
    ...detail.user,
    generation: 0,
    name: "일반 계정",
    role: "STUDENT",
    studentNumber: "local_student_b"
  }
} satisfies AdminUserDetail;

describe("AdminStudentDetail", () => {
  it("renders reservation metrics without a session count", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("확정 12");
    expect(markup).toContain("노쇼 2");
    expect(markup).toContain("취소 3");
    expect(markup).not.toContain("세션 4");
  });

  it("renders a no-show action only for confirmed current reservations", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: detailWithCurrentReservation,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("data-reservation-action=\"reservation-confirmed\"");
    expect(markup).not.toContain("data-reservation-action=\"reservation-cancelled\"");
  });

  it("renders audit log actions with Korean labels instead of internal codes", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: detailWithAuditLog,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("<span>학생 제재 적용</span>");
    expect(markup).not.toContain("USER_RESTRICTION_APPLY");
  });

  it("renders admin accounts with an admin label instead of a student generation", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: adminDetail,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("<h3>관리자 계정</h3>");
    expect(markup).toContain("local_student_a");
    expect(markup).not.toContain("일반 계정");
    expect(markup).not.toContain("local_student_a · 0기");
  });

  it("hides the generation for zero-generation local student accounts", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: localStudentDetail,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("<h3>일반 계정</h3>");
    expect(markup).toContain("local_student_b");
    expect(markup).not.toContain("local_student_b · 0기");
  });

  it("discloses every bounded student-detail history source even when it is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("최근 최대 100건 기준");
    expect(markup).toContain("최근 12건 표시");
    expect(markup).toContain("최근 12건 표시 · 최대 30건 조회");
    expect(markup).toContain("최근 최대 20건");
  });

  it("keeps the existing 12-item reservation-history display crop", () => {
    const detailWithLongHistory = {
      ...detail,
      reservationHistory: Array.from({ length: 13 }, (_, index) => ({
        createdAt: "2026-06-16T00:00:00.000Z",
        date: "2026-06-16",
        id: `reservation-history-${index}`,
        reason: `기록-${index}`,
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        updatedAt: "2026-06-16T00:00:00.000Z",
        userId: detail.user.id
      }))
    } satisfies AdminUserDetail;
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: detailWithLongHistory,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("기록-11");
    expect(markup).not.toContain("기록-12");
  });
});
