import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminBlacklistPanel } from "./admin-blacklist-panel";
import type { AdminUser } from "./admin-types";

describe("AdminBlacklistPanel", () => {
  it("shows only 20 matching candidates", () => {
    const users = Array.from({ length: 21 }, (_, index) => ({
      bookingStatus: "ACTIVE",
      generation: 32,
      id: `student-${index}`,
      name: `검색 학생 ${index}`,
      restrictedUntil: null,
      restrictionReason: null,
      role: "STUDENT",
      shadowBanProfile: "NORMAL",
      studentNumber: `320${index}`
    })) satisfies readonly AdminUser[];
    const markup = renderToStaticMarkup(
      createElement(AdminBlacklistPanel, {
        onRelease: () => undefined,
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onShadowBan: () => undefined,
        query: "검색 학생",
        selectedUserId: null,
        users
      })
    );

    expect(markup).toContain("검색 학생 19");
    expect(markup).not.toContain("검색 학생 20");
  });
});
