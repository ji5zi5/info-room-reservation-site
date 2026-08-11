import { describe, expect, it } from "vitest";

import { readAdminRedirectMessage } from "./reservation-home-helpers";

describe("admin root redirect query preservation", () => {
  it("removes only the redirect message key while preserving the deep-link tuple and unrelated duplicates", () => {
    // Given
    const search = "admin=required&source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A&tag=a&tag=b";

    // When
    const result = readAdminRedirectMessage(search);

    // Then
    expect(result).toEqual({
      cleanedSearch: "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A&tag=a&tag=b",
      message: "로그인이 필요합니다."
    });
  });

  it("does not mutate a root query without a recognized admin redirect", () => {
    // Given / When
    const result = readAdminRedirectMessage("admin=other&source=discord&tag=a&tag=b");

    // Then
    expect(result).toEqual({
      cleanedSearch: "admin=other&source=discord&tag=a&tag=b",
      message: null
    });
  });
});
