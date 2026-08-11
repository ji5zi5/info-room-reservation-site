import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAdminReservations } from "./admin-read-api-client";

describe("admin read api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes an optional reservationId alongside the independent reservation read input", async () => {
    // Given
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ reservations: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    // When
    await fetchAdminReservations({
      date: "2026-06-16",
      query: "",
      reservationId: "deep-link-target-101",
      status: "CONFIRMED",
      studyPeriod: "ALL"
    });

    // Then
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/reservations?date=2026-06-16&query=&status=CONFIRMED&studyPeriod=ALL&reservationId=deep-link-target-101",
      undefined
    );
  });
});
