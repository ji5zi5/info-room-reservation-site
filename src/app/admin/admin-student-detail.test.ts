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

describe("AdminStudentDetail", () => {
  it("renders reservation metrics without a session count", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail,
        onApplyRestriction: () => undefined,
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
});
