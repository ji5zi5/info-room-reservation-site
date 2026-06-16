import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type MeRouteModule = {
  readonly GET: () => Promise<Response>;
};

type GetCurrentUser = () => Promise<SessionUser | null>;

const routeMocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn<GetCurrentUser>()
}));

vi.mock("@/lib/session", () => ({
  getCurrentUser: routeMocks.getCurrentUser
}));

const shadowBannedStudent: SessionUser = {
  bookingStatus: "SHADOW_BANNED",
  generation: 31,
  id: "student-shadow",
  name: "Student Shadow",
  restrictionReason: "블랙리스트",
  restrictedUntil: "2026-07-01T00:00:00.000Z",
  role: "STUDENT",
  studentNumber: "31001"
};

describe("me route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("masks shadow-banned student session fields in the public response", async () => {
    // Given
    routeMocks.getCurrentUser.mockResolvedValue(shadowBannedStudent);
    const { GET } = await loadMeRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(payload).toMatchObject({
      user: {
        bookingStatus: "ACTIVE",
        restrictionReason: null,
        restrictedUntil: null
      }
    });
    expect(JSON.stringify(payload)).not.toContain("SHADOW_BANNED");
    expect(JSON.stringify(payload)).not.toContain("블랙리스트");
  });
});

async function loadMeRoute(): Promise<MeRouteModule> {
  const routeModule: unknown = await import("./route");
  if (!isMeRouteModule(routeModule)) {
    throw new Error("Me route module must export GET.");
  }
  return routeModule;
}

function isMeRouteModule(value: unknown): value is MeRouteModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "GET") === "function";
}
