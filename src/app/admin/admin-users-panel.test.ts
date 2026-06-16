import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminUsersPanel } from "./admin-users-panel";
import type { AdminUser } from "./admin-types";

const adminUser = {
  bookingStatus: "ACTIVE",
  generation: 0,
  id: "admin-local_student_a",
  name: "일반 계정",
  restrictedUntil: null,
  restrictionReason: null,
  role: "ADMIN",
  studentNumber: "local_student_a"
} satisfies AdminUser;

describe("AdminUsersPanel", () => {
  it("renders admin accounts with an admin label instead of a student generation", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onSetStatus: () => undefined,
        query: "",
        selectedUserId: null,
        status: "ALL",
        users: [adminUser]
      })
    );

    expect(markup).toContain("관리자 계정");
    expect(markup).toContain("local_student_a");
    expect(markup).not.toContain("일반 계정");
    expect(markup).not.toContain("local_student_a · 0기");
  });
});
