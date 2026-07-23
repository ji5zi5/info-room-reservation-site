import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminReservationsPanel } from "./admin-reservations-panel";

describe("AdminReservationsPanel", () => {
  it("renders a compact manual student reservation form", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminReservationsPanel, {
        date: "2026-06-16",
        onCancelReservation: () => undefined,
        onCopyCsv: () => undefined,
        onMarkNoShow: () => undefined,
        onRefresh: () => undefined,
        onSelectStatus: () => undefined,
        onSetPeriod: () => undefined,
        onSetQuery: () => undefined,
        onViewUser: () => undefined,
        periodFilter: "ALL",
        query: "",
        reservations: [],
        statusFilter: "CONFIRMED"
      })
    );

    expect(markup).toContain("학생 추가");
    expect(markup).toContain("학번");
    expect(markup).toContain("시간대");
    expect(markup).toContain("사유");
    expect(markup).toContain("추가");
    expect(markup).toContain("2026-06-16");
  });
});
