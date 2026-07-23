import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReservationCalendar } from "./reservation-calendar";

const availablePolicy = {
  kind: "available",
  maxDate: "2026-07-03",
  minDate: "2026-07-02",
  today: "2026-07-01"
} as const;

describe("ReservationCalendar", () => {
  it("renders selected dates with a quiet visual marker instead of extra status text", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationCalendar, {
        advancePolicy: availablePolicy,
        onSelectDate: noop,
        selectedDate: "2026-07-02"
      })
    );

    expect(markup).toContain("calendar-day-marker");
    expect(markup).not.toContain("calendar-selection-label");
  });
});

function noop(): void {}
