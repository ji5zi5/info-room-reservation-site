import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { PeriodSummary } from "@/lib/period-settings";
import type { SessionUser } from "@/lib/session";

type GetPeriodSummaries = (
  date: string,
  options: { readonly actor: DatabaseActor; readonly currentUserId: string }
) => Promise<readonly PeriodSummary[]>;

type PeriodWeekPayload = {
  readonly dates: readonly {
    readonly date: string;
    readonly periods: readonly {
      readonly availability: number;
      readonly capacity: number;
      readonly closeTime: string;
      readonly enabled: boolean;
      readonly myReservationId: string | null;
      readonly openTime: string;
      readonly reservedCount: number;
      readonly studyPeriod: "EIGHTH" | "FIRST";
    }[];
  }[];
};

type GetPeriodWeekSummaries = (
  weekStart: string,
  options: { readonly actor: DatabaseActor; readonly currentUserId: string }
) => Promise<PeriodWeekPayload>;

const routeMocks = vi.hoisted(() => ({
  getPeriodSummaries: vi.fn<GetPeriodSummaries>(),
  getPeriodWeekSummaries: vi.fn<GetPeriodWeekSummaries>(),
  isAllowedPeriodQueryDate: vi.fn<(date: string, now: Date) => boolean>(),
  isAllowedPeriodQueryWeekStart: vi.fn<(weekStart: string, now: Date) => boolean>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  requireUser: vi.fn<() => Promise<SessionUser>>(),
  systemDatabaseActor: vi.fn<() => DatabaseActor>()
}));

vi.mock("@/lib/db-context", () => ({
  systemDatabaseActor: routeMocks.systemDatabaseActor
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-period-summaries", () => ({
  getMockPeriodSummaries: vi.fn(() => [])
}));

vi.mock("@/lib/period-query-policy", () => ({
  isAllowedPeriodQueryDate: routeMocks.isAllowedPeriodQueryDate,
  isAllowedPeriodQueryWeekStart: routeMocks.isAllowedPeriodQueryWeekStart
}));

vi.mock("@/lib/period-settings", () => ({
  getPeriodSummaries: routeMocks.getPeriodSummaries,
  getPeriodWeekSummaries: routeMocks.getPeriodWeekSummaries
}));

vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  requireUser: routeMocks.requireUser
}));

const student: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-1",
  name: "학생",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
};

const periodWithPeerIdentity: PeriodSummary = {
  applicants: [{ name: "다른 학생", reservationId: "peer-reservation", studentNumber: "31002" }],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 2,
  date: "2026-07-22",
  enabled: true,
  label: "8면학",
  myReservationId: "mine-reservation",
  openTime: "13:00",
  remaining: 8,
  studyPeriod: "EIGHTH",
  windowState: "open"
};

function createWeekPayload(reservedCount = 1): PeriodWeekPayload {
  return {
    dates: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"].map((date) => ({
      date,
      periods: [
        {
          availability: Math.max(10 - reservedCount, 0),
          capacity: 10,
          closeTime: "16:20",
          enabled: true,
          myReservationId: date === "2026-07-22" ? "mine-eighth" : null,
          openTime: "13:00",
          reservedCount,
          studyPeriod: "EIGHTH"
        },
        {
          availability: 10,
          capacity: 10,
          closeTime: "16:20",
          enabled: true,
          myReservationId: null,
          openTime: "13:00",
          reservedCount: 0,
          studyPeriod: "FIRST"
        }
      ]
    }))
  };
}

describe("student periods route privacy", () => {
  beforeEach(() => {
    vi.resetModules();
    routeMocks.getPeriodSummaries.mockReset();
    routeMocks.getPeriodWeekSummaries.mockReset();
    routeMocks.isAllowedPeriodQueryDate.mockReset();
    routeMocks.isAllowedPeriodQueryWeekStart.mockReset();
    routeMocks.isNoDatabaseMockMode.mockReset();
    routeMocks.requireUser.mockReset();
    routeMocks.systemDatabaseActor.mockReset();

    routeMocks.getPeriodSummaries.mockResolvedValue([periodWithPeerIdentity]);
    routeMocks.getPeriodWeekSummaries.mockResolvedValue(createWeekPayload());
    routeMocks.isAllowedPeriodQueryDate.mockReturnValue(true);
    routeMocks.isAllowedPeriodQueryWeekStart.mockReturnValue(true);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireUser.mockResolvedValue(student);
    routeMocks.systemDatabaseActor.mockReturnValue({ id: null, role: "SYSTEM" });
  });

  it("returns only aggregate period data and the current user's reservation identity", async () => {
    const { GET } = await import("./route");

    const response = await GET(new Request("https://example.test/api/periods?date=2026-07-22"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(routeMocks.getPeriodSummaries).toHaveBeenCalledWith("2026-07-22", {
      actor: { id: null, role: "SYSTEM" },
      currentUserId: student.id
    });
    await expect(response.json()).resolves.toEqual({
      periods: [
        {
          capacity: 10,
          closeTime: "16:20",
          confirmedCount: 2,
          date: "2026-07-22",
          enabled: true,
          label: "8면학",
          myReservationId: "mine-reservation",
          openTime: "13:00",
          remaining: 8,
          studyPeriod: "EIGHTH",
          windowState: "open"
        }
      ]
    });
  });

  it("rejects date and weekStart when both query modes are supplied", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://example.test/api/periods?date=2026-07-22&weekStart=2026-07-20")
    );

    expect(response.status).toBe(400);
    expect(routeMocks.getPeriodSummaries).not.toHaveBeenCalled();
    expect(routeMocks.getPeriodWeekSummaries).not.toHaveBeenCalled();
  });

  it("returns the exact canonical weekly DTO without peer identity", async () => {
    const { GET } = await import("./route");
    const expected = createWeekPayload();

    const response = await GET(new Request("https://example.test/api/periods?weekStart=2026-07-20"));

    expect(response.status).toBe(200);
    expect(routeMocks.isAllowedPeriodQueryWeekStart).toHaveBeenCalledWith("2026-07-20", expect.any(Date));
    expect(routeMocks.getPeriodWeekSummaries).toHaveBeenCalledWith("2026-07-20", {
      actor: { id: null, role: "SYSTEM" },
      currentUserId: student.id
    });
    expect(routeMocks.getPeriodSummaries).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload).toEqual(expected);
    expect(JSON.stringify(payload)).not.toContain("applicants");
    expect(JSON.stringify(payload)).not.toContain("studentNumber");
    expect(JSON.stringify(payload)).not.toContain("name");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
  });

  it("revalidates a user-scoped canonical response with ETag", async () => {
    const { GET } = await import("./route");
    routeMocks.getPeriodWeekSummaries.mockResolvedValue(createWeekPayload(1));

    const first = await GET(new Request("https://example.test/api/periods?weekStart=2026-07-20"));
    const firstEtag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(firstEtag).not.toBeNull();
    if (!firstEtag) {
      return;
    }
    expect(firstEtag).toMatch(/^"[a-f0-9]{64}"$/u);

    const unchanged = await GET(
      new Request("https://example.test/api/periods?weekStart=2026-07-20", {
        headers: { "If-None-Match": firstEtag }
      })
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("ETag")).toBe(firstEtag);

    routeMocks.getPeriodWeekSummaries.mockResolvedValue(createWeekPayload(2));
    const changed = await GET(
      new Request("https://example.test/api/periods?weekStart=2026-07-20", {
        headers: { "If-None-Match": firstEtag }
      })
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(firstEtag);
    await expect(changed.json()).resolves.toEqual(createWeekPayload(2));

    routeMocks.getPeriodWeekSummaries.mockResolvedValue(createWeekPayload(1));
    routeMocks.requireUser.mockResolvedValue({ ...student, id: "student-2" });
    const otherUser = await GET(new Request("https://example.test/api/periods?weekStart=2026-07-20"));
    expect(otherUser.status).toBe(200);
    expect(otherUser.headers.get("ETag")).not.toBe(firstEtag);
  });
});
