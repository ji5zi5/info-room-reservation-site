import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdminReservation } from "./admin-create-reservation-client";

const csrfFetchMock = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);

vi.mock("../csrf-fetch", () => ({
  csrfFetch: csrfFetchMock
}));

describe("admin create reservation client", () => {
  afterEach(() => {
    csrfFetchMock.mockReset();
  });

  it("posts the selected student and period to the admin reservation endpoint", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 201 }));

    await expect(
      createAdminReservation({
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        studentNumber: "25001",
        studyPeriod: "EIGHTH"
      })
    ).resolves.toEqual({ kind: "ok" });

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/reservations");
    expect(request?.body).toBe(
      JSON.stringify({
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        studentNumber: "25001",
        studyPeriod: "EIGHTH"
      })
    );
    expect(request?.headers).toEqual({ "content-type": "application/json" });
    expect(request?.method).toBe("POST");
  });

  it("returns the server error message for admin-facing feedback", async () => {
    csrfFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "학생을 찾을 수 없습니다." } }), { status: 404 })
    );

    await expect(
      createAdminReservation({
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        studentNumber: "99999",
        studyPeriod: "FIRST"
      })
    ).resolves.toEqual({ kind: "error", message: "학생을 찾을 수 없습니다." });
  });

  it("returns a retryable message when the request cannot reach the server", async () => {
    csrfFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      createAdminReservation({
        date: "2026-06-16",
        reason: "관리자 수동 추가",
        studentNumber: "25001",
        studyPeriod: "EIGHTH"
      })
    ).resolves.toEqual({ kind: "error", message: "네트워크 연결을 확인하고 다시 시도해주세요." });
  });
});
