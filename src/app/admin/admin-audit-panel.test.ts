import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdminAuditPanel } from "./admin-audit-panel";
import type { AdminAuditAction } from "./admin-types";

describe("AdminAuditPanel", () => {
  it("uses one visible category filter control", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminAuditPanel, {
        actionFilter: "ALL",
        actions: [],
        exportUrl: "/api/admin/exports/actions?action=ALL&query=",
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: ""
      })
    );

    expect(markup).toContain('aria-label="감사 로그 분류"');
    expect(markup).not.toContain("<select");
  });

  it("renders the empty state for empty results", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminAuditPanel, {
        actionFilter: "ALL",
        actions: [],
        exportUrl: "/api/admin/exports/actions?action=ALL&query=%EC%97%86%EC%9D%8C",
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: "없음"
      })
    );

    expect(markup).toContain("표시할 감사 로그가 없습니다.");
  });

  it("renders the complete caller-supplied page beyond the former 80-row client cap", () => {
    const actions = Array.from({ length: 81 }, (_, index) => ({
      action: "USER_RESTRICTION_UPDATED",
      actor: null,
      actorId: null,
      after: null,
      before: null,
      category: "RESTRICTION",
      createdAt: "2026-06-16T00:00:00.000Z",
      id: `audit-${index}`,
      reason: null,
      reservationId: null,
      targetUser: null,
      targetUserId: null
    })) satisfies readonly AdminAuditAction[];
    const markup = renderToStaticMarkup(
      createElement(AdminAuditPanel, {
        actionFilter: "ALL",
        actions,
        exportUrl: "/api/admin/exports/actions?action=ALL&query=",
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: ""
      })
    );

    expect(markup.match(/class="audit-line"/gu)).toHaveLength(81);
  });

  it("uses server CSV export and exposes the mutable loaded total", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminAuditPanel, {
        actionFilter: "RESTRICTION",
        actions: [],
        exportUrl: "/api/admin/exports/actions?action=RESTRICTION&query=%ED%95%99%EC%83%9D",
        onLoadMore: vi.fn(),
        onRestartTraversal: vi.fn(),
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        pagination: {
          currentTotalCount: 227,
          hasHiddenPrevious: false,
          loadedCount: 50,
          loadingMore: false,
          nextCursor: "audit-cursor-2",
          restartRequired: false
        },
        query: "학생"
      })
    );

    expect(markup).toContain("CSV 다운로드");
    expect(markup).toContain("50개 표시 / 현재 227건");
    expect(markup).not.toContain("감사 복사");
  });

  it("marks an exact audit deep link as the focus target", () => {
    const action = {
      action: "USER_RESTRICTION_UPDATED",
      actor: null,
      actorId: null,
      after: null,
      before: null,
      category: "RESTRICTION",
      createdAt: "2026-06-16T00:00:00.000Z",
      id: "audit-exact",
      reason: null,
      reservationId: null,
      targetUser: null,
      targetUserId: null
    } satisfies AdminAuditAction;
    const markup = renderToStaticMarkup(
      createElement(AdminAuditPanel, {
        actionFilter: "ALL",
        actions: [action],
        exportUrl: "/api/admin/exports/actions?action=ALL&query=",
        focusRecordId: action.id,
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: ""
      })
    );

    expect(markup).toMatch(/<article(?=[^>]*class="audit-line")(?=[^>]*data-focus-target="true")(?=[^>]*tabindex="-1")[^>]*>/u);
  });
});
