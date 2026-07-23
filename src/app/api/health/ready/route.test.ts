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
});
