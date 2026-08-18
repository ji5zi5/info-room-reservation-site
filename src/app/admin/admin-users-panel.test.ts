import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_VISIBLE_ITEM_LIMIT,
  buildAdminAuditExportUrl,
  buildAdminReservationExportUrl,
  fetchAdminUsers,
  mergeAdminReadPages,
  type AdminReadPage
} from "./admin-read-api-client";
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

  it("shows the mutable filtered total and a stable terminal load-more control", () => {
    // Given / When: the current filtered traversal is complete.
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        onLoadMore: () => undefined,
        onRestartTraversal: () => undefined,
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onSetStatus: () => undefined,
        pagination: {
          currentTotalCount: 2,
          hasHiddenPrevious: false,
          loadedCount: 2,
          loadingMore: false,
          nextCursor: null,
          restartRequired: false
        },
        query: "",
        selectedUserId: null,
        status: "ALL",
        users: [adminUser, localStudentUser]
      })
    );

    // Then: the latest total is visible and the keyboard-focusable control remains disabled in place.
    expect(markup).toContain("2개 표시 / 현재 2건");
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*type="button")[^>]*>[\s\S]*?탐색 완료[\s\S]*?<\/button>/u);
  });

  it("offers a fresh page-one traversal while preserving expired-cursor rows", () => {
    // Given / When: a continuation expired after one visible row was loaded.
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        onLoadMore: () => undefined,
        onRestartTraversal: () => undefined,
        onSelectUser: () => undefined,
        onSetQuery: () => undefined,
        onSetStatus: () => undefined,
        pagination: {
          currentTotalCount: 4,
          hasHiddenPrevious: false,
          loadedCount: 1,
          loadingMore: false,
          nextCursor: "expired",
          restartRequired: true
        },
        query: "",
        selectedUserId: null,
        status: "ALL",
        users: [localStudentUser]
      })
    );

    // Then: the row remains and restart replaces the unsafe continuation action.
    expect(markup).toContain("local_student_b");
    expect(markup).toContain("처음부터 다시");
    expect(markup).not.toContain("검색된 학생이 없습니다.");
  });
});

describe("admin paged list state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dedupes appended rows and resets a changed-filter traversal", () => {
    const current = page([user("user-1"), user("user-2")], "cursor-2", 4);
    const next = page([user("user-2"), user("user-3")], null, 3);

    const appended = mergeAdminReadPages(current, next, "append");
    const replaced = mergeAdminReadPages(current, next, "replace");

    expect(appended.items.map((item) => item.id)).toEqual(["user-1", "user-2", "user-3"]);
    expect(appended.nextCursor).toBeNull();
    expect(appended.currentTotalCount).toBe(3);
    expect(replaced).toEqual({ ...next, hasHiddenPrevious: false });
  });

  it("keeps appended rows inside a bounded visible window", () => {
    const current = page(
      Array.from({ length: ADMIN_VISIBLE_ITEM_LIMIT }, (_, index) => user(`user-${index}`)),
      "cursor-next",
      ADMIN_VISIBLE_ITEM_LIMIT + 2
    );
    const next = page(
      [user(`user-${ADMIN_VISIBLE_ITEM_LIMIT}`), user(`user-${ADMIN_VISIBLE_ITEM_LIMIT + 1}`)],
      null,
      ADMIN_VISIBLE_ITEM_LIMIT + 2
    );

    const merged = mergeAdminReadPages(current, next, "append");

    expect(merged.items).toHaveLength(ADMIN_VISIBLE_ITEM_LIMIT);
    expect(merged.items[0]?.id).toBe("user-2");
    expect(merged.items.at(-1)?.id).toBe(`user-${ADMIN_VISIBLE_ITEM_LIMIT + 1}`);
    expect(merged.hasHiddenPrevious).toBe(true);
  });

  it("preserves rows and retry cursor for an unexpectedly empty continuation", () => {
    const current = page([user("user-1")], "cursor-retry", 2);
    const empty = page<AdminUser>([], null, 1);

    const merged = mergeAdminReadPages(current, empty, "append");

    expect(merged.items.map((item) => item.id)).toEqual(["user-1"]);
    expect(merged.nextCursor).toBe("cursor-retry");
    expect(merged.currentTotalCount).toBe(1);
  });

  it("builds server CSV URLs from every active filter", () => {
    expect(buildAdminReservationExportUrl({
      date: "2026-08-13",
      query: "김 학생",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH"
    })).toBe("/api/admin/exports/reservations?date=2026-08-13&query=%EA%B9%80+%ED%95%99%EC%83%9D&status=CONFIRMED&studyPeriod=EIGHTH");
    expect(buildAdminAuditExportUrl({ action: "RESTRICTION", query: "김 학생" }))
      .toBe("/api/admin/exports/actions?action=RESTRICTION&query=%EA%B9%80+%ED%95%99%EC%83%9D");
  });

  it("preserves the expired-cursor code for a visible-row restart", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "CURSOR_EXPIRED", message: "cursor expired" }
    }), { status: 400 })));

    await expect(fetchAdminUsers({ cursor: "expired", query: "", status: "ALL" }))
      .resolves.toEqual({ code: "CURSOR_EXPIRED", kind: "error", message: "cursor expired" });
  });
});

function page<T>(
  items: readonly T[],
  nextCursor: string | null,
  currentTotalCount: number
): AdminReadPage<T> {
  return {
    cutoff: "2026-08-13T01:00:00.000Z",
    currentTotalCount,
    expiresAt: "2026-08-13T01:15:00.000Z",
    items,
    nextCursor
  };
}

function user(id: string): AdminUser {
  return {
    ...localStudentUser,
    id,
    studentNumber: `31-${id}`
  };
}
