import { describe, expect, it } from "vitest";

import { summarizeUserSessions } from "./admin-session-control";

describe("admin session control helpers", () => {
  it("summarizes active and expired user sessions", () => {
    const now = new Date("2026-06-12T04:00:00.000Z");

    const summary = summarizeUserSessions(
      [
        { expiresAt: new Date("2026-06-12T03:59:59.000Z") },
        { expiresAt: new Date("2026-06-12T04:00:00.000Z") },
        { expiresAt: new Date("2026-06-12T04:00:01.000Z") },
        { expiresAt: new Date("2026-06-13T04:00:00.000Z") }
      ],
      now
    );

    expect(summary).toEqual({
      activeCount: 2,
      expiredCount: 2,
      totalCount: 4
    });
  });
});
