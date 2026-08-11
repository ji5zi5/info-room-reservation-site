import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AdminMutationResult, ApplyRestrictionData } from "./admin-api-client";
import type { UserRestrictionDraft } from "./admin-console-state";
import { AdminStudentRestrictionForm } from "./admin-student-restriction-form";

const restrictionDraft = {
  days: "7",
  reason: "",
  shadowBanProfile: "NORMAL",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

async function applyRestrictionSuccess(): Promise<AdminMutationResult<ApplyRestrictionData>> {
  return {
    data: {
      cancelledFutureReservationCount: 3,
      user: {
        bookingStatus: "BANNED",
        generation: 25,
        id: "student-1",
        name: "테스트학생",
        restrictedUntil: null,
        restrictionReason: "반복 노쇼",
        role: "STUDENT",
        shadowBanProfile: "NORMAL",
        studentNumber: "25001"
      }
    },
    kind: "ok"
  };
}

describe("AdminStudentRestrictionForm", () => {
  it("renders a direct reason field without reason presets", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: restrictionDraft,
        onApply: applyRestrictionSuccess,
        onSetDraft: () => undefined
      })
    );

    expect(markup).not.toContain("사유 선택");
    expect(markup).not.toContain("미출석");
    expect(markup).not.toContain("예약 취소");
    expect(markup).not.toContain("관리자 확인");
    expect(markup).toContain("제재 사유");
  });

  it("renders profile controls only for shadow bans", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: { ...restrictionDraft, reason: "블랙리스트", shadowBanProfile: "HIGH", status: "SHADOW_BANNED" },
        onApply: applyRestrictionSuccess,
        onSetDraft: () => undefined
      })
    );

    expect(markup).toContain("블랙리스트 강도");
    expect(markup).toContain("낮음");
    expect(markup).toContain("보통");
    expect(markup).toContain("높음");
  });

  it("routes only permanent bans through an accessible confirmation entry point", () => {
    const bannedMarkup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: { ...restrictionDraft, days: "", reason: "반복 노쇼", status: "BANNED" },
        onApply: applyRestrictionSuccess,
        onSetDraft: () => undefined
      })
    );
    const restrictedMarkup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: { ...restrictionDraft, reason: "기간 제한" },
        onApply: applyRestrictionSuccess,
        onSetDraft: () => undefined
      })
    );
    const shadowBannedMarkup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: { ...restrictionDraft, days: "", reason: "숨김 제한", status: "SHADOW_BANNED" },
        onApply: applyRestrictionSuccess,
        onSetDraft: () => undefined
      })
    );

    expect(bannedMarkup).toMatch(/<button(?=[^>]*aria-haspopup="dialog")[^>]*>[\s\S]*?학생 제재 적용[\s\S]*?<\/button>/u);
    expect(restrictedMarkup).not.toContain('aria-haspopup="dialog"');
    expect(shadowBannedMarkup).not.toContain('aria-haspopup="dialog"');
  });
});
