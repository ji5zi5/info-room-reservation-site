import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAdminSettings, markReservationNoShow, saveAdminSettings } from "./admin-api-client";

const csrfFetchMock = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);

vi.mock("../csrf-fetch", () => ({
  csrfFetch: csrfFetchMock
}));

describe("admin api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    csrfFetchMock.mockReset();
  });

  it("returns a failure result instead of hiding empty error responses", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(fetchAdminSettings("2026-06-14")).resolves.toEqual({
      kind: "error",
      message: "관리자 데이터를 불러오지 못했습니다."
    });
  });

  it("normalizes admin time fields before saving period settings", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      saveAdminSettings({
        date: "2026-06-16",
        periods: [
          {
            capacity: 10,
            closeTime: "4:05",
            confirmedCount: 0,
            date: "2026-06-16",
            enabled: true,
            label: "8면학",
            openTime: " 3:00 ",
            remaining: 10,
            studyPeriod: "EIGHTH",
            windowState: "open"
          }
        ]
      })
    ).resolves.toBe(true);

    const request = csrfFetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(request?.body).toBe(
      JSON.stringify({
        date: "2026-06-16",
        periods: [
          {
            capacity: 10,
            closeTime: "04:05",
            confirmedCount: 0,
            date: "2026-06-16",
            enabled: true,
            label: "8면학",
            openTime: "03:00",
            remaining: 10,
            studyPeriod: "EIGHTH",
            windowState: "open"
          }
        ]
      })
    );
  });

  it("sends only a no-show reason when marking a reservation no-show", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(markReservationNoShow("reservation-1")).resolves.toBe(true);

    const request = csrfFetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(request?.body).toBe(JSON.stringify({ reason: "정보실 예약 노쇼" }));
  });
});
