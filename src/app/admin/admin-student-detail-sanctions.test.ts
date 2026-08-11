import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  generation: 32,
  id: "user-1",
  name: "테스트학생",
  restrictedUntil: null,
  restrictionReason: "블랙리스트",
  role: "STUDENT",
  shadowBanProfile: "HIGH",
  studentNumber: "25001"
} satisfies ApplyRestrictionData["user"];

async function applyRestrictionSuccess(): Promise<AdminMutationResult<ApplyRestrictionData>> {
  return { data: { cancelledFutureReservationCount: 0, user: mutationUser }, kind: "ok" };
}

async function markNoShowSuccess(): Promise<AdminMutationResult<NoShowReservationData>> {
  return {
    data: {
      cancelledFutureReservationCount: 0,
      reservation: {
        createdAt: "2026-06-16T00:00:00.000Z",
        date: "2026-06-16",
        id: "reservation-no-show",
        reason: "학습",
        status: "NO_SHOW",
        studyPeriod: "EIGHTH",
        updatedAt: "2026-06-16T00:05:00.000Z",
        userId: mutationUser.id
      },
      user: mutationUser
    },
    kind: "ok"
  };
}

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

const adversarialDetailWithSanctions = {
  ...detailWithSanctions,
  sanctions: Array.from({ length: 31 }, (_, index) => ({
    actorId: "admin-1",
    createdAt: "2026-06-16T05:40:00.000Z",
    endsAt: null,
    id: `sanction-fixture-${index + 1}`,
    reason: `fixture-sanction-${index + 1}`,
    revokedAt: null,
    revokedById: null,
    revokedReason: null,
    sourceActionId: null,
    startsAt: "2026-06-16T05:40:00.000Z",
    status: "ACTIVE",
    type: "ADMIN_BAN"
  } satisfies AdminUserDetail["sanctions"][number])),
  sanctionSummary: { activeCount: 31, permanentCount: 31, revokedCount: 0, totalCount: 31 }
} satisfies AdminUserDetail;

describe("AdminStudentDetail sanction history", () => {
  it("renders sanction statuses with Korean operational labels", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentDetail, {
        detail: detailWithSanctions,
        onApplyRestriction: applyRestrictionSuccess,
        onMarkNoShow: markNoShowSuccess,
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
    expect(markup).toContain("최근 조회 제재 2회 · 활성 1회 · 해제 1회");
    expect(markup).not.toContain("누적 제재");
    expect(markup).toContain("최근 최대 30건");
  });

  it("caps an adversarial 31-sanction payload at 30 visible rows", () => {
    const renderedSanctionIds = adversarialDetailWithSanctions.sanctions.map((sanction) => sanction.id);
    expect(new Set(renderedSanctionIds).size).toBe(renderedSanctionIds.length);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const markup = (() => {
      try {
        const renderedMarkup = renderToStaticMarkup(
          createElement(AdminStudentDetail, {
            detail: adversarialDetailWithSanctions,
            onApplyRestriction: applyRestrictionSuccess,
            onMarkNoShow: markNoShowSuccess,
            onRelease: () => undefined,
            onSetRestrictionDraft: () => undefined,
            restrictionDraft
          })
        );
        expect(consoleError.mock.calls).not.toEqual(
          expect.arrayContaining([
            expect.arrayContaining([expect.stringContaining("unique \"key\"")])
          ])
        );
        return renderedMarkup;
      } finally {
        consoleError.mockRestore();
      }
    })();

    const sanctionSection = markup.slice(
      markup.indexOf("<h4>제재 이력 · 최근 최대 30건</h4>"),
      markup.indexOf("<h4>관리자 액션")
    );
    const renderedSanctionReasons = sanctionSection.match(/fixture-sanction-\d+/g) ?? [];

    expect(renderedSanctionReasons).toHaveLength(30);
    expect(renderedSanctionReasons).toEqual(
      Array.from({ length: 30 }, (_, index) => `fixture-sanction-${index + 1}`)
    );
    expect(sanctionSection).not.toContain("fixture-sanction-31");
    expect(sanctionSection).toContain("<h4>제재 이력 · 최근 최대 30건</h4>");
    expect(markup).toContain("최근 조회 제재 31회 · 활성 31회 · 해제 0회");
    expect(markup).not.toContain("누적 제재");
    expect(markup).not.toContain("31건");
  });
});
