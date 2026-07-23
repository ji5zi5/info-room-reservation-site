import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminStudentDetail } from "./admin-student-detail";
import type { UserRestrictionDraft } from "./admin-console-state";
import type { AdminUserDetail } from "./admin-types";

const restrictionDraft = {
  days: "7",
  reason: "",
  shadowBanProfile: "NORMAL",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

const detailWithSanctions = {
  adminActions: [],
  auditLogs: [],
  currentReservations: [],
  reservationHistory: [],
  sanctions: [
    {
      actorId: "admin-1",
      createdAt: "2026-06-16T05:40:00.000Z",
      endsAt: null,
      id: "sanction-active",
      reason: "블랙리스트",
      revokedAt: null,
      revokedById: null,
      revokedReason: null,
      sourceActionId: null,
      startsAt: "2026-06-16T05:40:00.000Z",
      status: "ACTIVE",
      type: "ADMIN_BAN"
    },
    {
      actorId: "admin-1",
      createdAt: "2026-06-16T05:40:00.000Z",
      endsAt: null,
      id: "sanction-revoked",
      reason: "내맘",
      revokedAt: "2026-06-16T05:43:00.000Z",
      revokedById: "admin-1",
      revokedReason: "해제",
      sourceActionId: null,
      startsAt: "2026-06-16T05:40:00.000Z",
      status: "REVOKED",
      type: "ADMIN_BAN"
    }
  ],
  sanctionSummary: { activeCount: 1, permanentCount: 1, revokedCount: 1, totalCount: 2 },
  sessionSummary: { activeCount: 0, expiredCount: 0, totalCount: 0 },
  summary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 },
  user: {
    bookingStatus: "BANNED",
    createdAt: "2026-06-16T00:00:00.000Z",
    generation: 32,
    id: "user-1",
    name: "테스트학생",
    restrictedUntil: null,
    restrictionReason: "블랙리스트",
    role: "STUDENT",
    shadowBanProfile: "HIGH",
    studentNumber: "25001",
    updatedAt: "2026-06-16T00:00:00.000Z"
  }
} satisfies AdminUserDetail;

describe("AdminStudentDetail sanction history", () => {
  it("renders sanction statuses with Korean operational labels", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: detailWithSanctions,
        onApplyRestriction: () => undefined,
        onMarkNoShow: () => undefined,
        onRelease: () => undefined,
        onSetRestrictionDraft: () => undefined,
        restrictionDraft
      })
    );

    expect(markup).toContain("관리자 영구 차단 · 블랙리스트");
    expect(markup).toContain("관리자 영구 차단 · 내맘");
    expect(markup).toContain("적용 중");
    expect(markup).toContain("해제");
    expect(markup).not.toContain("REVOKED");
  });
});
