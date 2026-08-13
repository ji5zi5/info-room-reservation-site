import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminUsersPanel } from "./admin-users-panel";
import type { AdminUser } from "./admin-types";

const adminUser = {
  bookingStatus: "ACTIVE",
  generation: 0,
  id: "admin-local-student-a",
  name: "일반 계정",
  restrictedUntil: null,
  restrictionReason: null,
  role: "ADMIN",
  shadowBanProfile: "NORMAL",
  studentNumber: "local_student_a"
} satisfies AdminUser;

const localStudentUser = {
  bookingStatus: "ACTIVE",
  generation: 0,
  id: "local-student-b",
  name: "일반 계정",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "local_student_b"
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

  it("hides the generation for zero-generation local student accounts", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onSetStatus: () => undefined,
        query: "",
        selectedUserId: null,
        status: "ALL",
        users: [localStudentUser]
      })
    );

    expect(markup).toContain("일반 계정");
    expect(markup).toContain("local_student_b");
    expect(markup).not.toContain("local_student_b · 0기");
  });

  it("renders the empty state when no students match", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onSetStatus: () => undefined,
        query: "없음",
        selectedUserId: null,
        status: "ALL",
        users: []
      })
    );

    expect(markup).toContain("검색된 학생이 없습니다.");
  });
});
