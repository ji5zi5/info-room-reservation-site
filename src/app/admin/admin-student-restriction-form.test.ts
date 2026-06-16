import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UserRestrictionDraft } from "./admin-console-state";
import { AdminStudentRestrictionForm } from "./admin-student-restriction-form";

const restrictionDraft = {
  days: "7",
  reason: "",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

describe("AdminStudentRestrictionForm", () => {
  it("renders a direct reason field without reason presets", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminStudentRestrictionForm, {
        draft: restrictionDraft,
        onApply: () => undefined,
        onSetDraft: () => undefined
      })
    );

    expect(markup).not.toContain("사유 선택");
    expect(markup).not.toContain("미출석");
    expect(markup).not.toContain("예약 취소");
    expect(markup).not.toContain("관리자 확인");
    expect(markup).toContain("제재 사유");
  });
});
