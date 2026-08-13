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
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: "없음"
      })
    );

    expect(markup).toContain("표시할 감사 로그가 없습니다.");
  });

  it("renders only 80 visible rows from an overflowing 201-record fixture", () => {
    const actions = Array.from({ length: 201 }, (_, index) => ({
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
        onSetActionFilter: vi.fn(),
        onSetQuery: vi.fn(),
        onViewUser: vi.fn(),
        query: ""
      })
    );

    expect(markup.match(/class="audit-line"/gu)).toHaveLength(80);
  });
});
