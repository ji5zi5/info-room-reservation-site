import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminStudentDetail } from "./admin-student-detail";
import type { UserRestrictionDraft } from "./admin-console-state";
import type { AdminUserDetail } from "./admin-types";

const restrictionDraft = {
  days: "7",
  reason: "",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

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
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
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
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
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
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
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
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
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
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("<h3>일반 계정</h3>");
    expect(markup).toContain("local_student_b");
    expect(markup).not.toContain("local_student_b · 0기");
  });
});
