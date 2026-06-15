import { describe, expect, it } from "vitest";

import { runMaintenanceCleanup, type MaintenanceCleanupStore } from "./maintenance-service";

describe("maintenance cleanup service", () => {
  it("cleans expired runtime data and releases expired restrictions", async () => {
    const calls: string[] = [];
    const store: MaintenanceCleanupStore = {
      async deleteExpiredCsrfTokens(now) {
        calls.push(`csrf:${now.toISOString()}`);
        return 2;
      },
      async deleteExpiredRateLimitBuckets(now) {
        calls.push(`rate:${now.toISOString()}`);
        return 3;
      },
      async deleteExpiredSessions(now) {
        calls.push(`sessions:${now.toISOString()}`);
        return 1;
      },
      async releaseExpiredRestrictions(now) {
        calls.push(`restrictions:${now.toISOString()}`);
        return 4;
      },
      async revokeExpiredSanctions(now) {
        calls.push(`sanctions:${now.toISOString()}`);
        return 5;
      }
    };

    const now = new Date("2026-06-14T12:00:00.000Z");

    await expect(runMaintenanceCleanup({ now, store })).resolves.toEqual({
      csrfTokensDeleted: 2,
      expiredSanctionsRevoked: 5,
      rateLimitBucketsDeleted: 3,
      restrictionsReleased: 4,
      sessionsDeleted: 1
    });
    expect(calls).toEqual([
      "sessions:2026-06-14T12:00:00.000Z",
      "csrf:2026-06-14T12:00:00.000Z",
      "rate:2026-06-14T12:00:00.000Z",
      "restrictions:2026-06-14T12:00:00.000Z",
      "sanctions:2026-06-14T12:00:00.000Z"
    ]);
  });
});
