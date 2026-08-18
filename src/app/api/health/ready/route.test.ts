import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  getPrismaReadinessReport: vi.fn()
}));

vi.mock("@/lib/prisma-readiness", () => ({
  getPrismaReadinessReport: routeMocks.getPrismaReadinessReport
}));

import { GET } from "./route";

describe("readiness route", () => {
  beforeEach(() => {
    routeMocks.getPrismaReadinessReport.mockReset();
  });

  it("returns 503 for an unready report and prevents caching", async () => {
    routeMocks.getPrismaReadinessReport.mockResolvedValue({ checks: {}, status: "unready" });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 200 for healthy or degraded reports", async () => {
    for (const status of ["ok", "degraded"] as const) {
      routeMocks.getPrismaReadinessReport.mockResolvedValueOnce({ checks: {}, status });
      expect((await GET()).status).toBe(200);
    }
  });

  it("returns only the read-only readiness report without applicant data", async () => {
    routeMocks.getPrismaReadinessReport.mockResolvedValue({
      checks: {
        jobs: {
          DISCORD_INTERACTIONS: { backlog: { count: 2 }, retention: { blocked: true } },
          DISCORD_RESERVATION_OUTBOX: { backlog: { count: 0 }, retention: { blocked: false } }
        }
      },
      status: "degraded"
    });

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("DISCORD_INTERACTIONS");
    expect(body).not.toMatch(/applicant|reason|studentNumber|token|webhook/i);
    expect(routeMocks.getPrismaReadinessReport).toHaveBeenCalledOnce();
  });
});
