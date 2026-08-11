import { describe, expect, it } from "vitest";

import {
  buildAdminReservationDeepLinkUrl,
  parseReservationDeepLink,
  resolveReservationDeepLink,
  writeReservationDeepLink
} from "./admin-console-url";

describe("admin reservation deep-link URL contract", () => {
  it("writes one canonical valid tuple while preserving every unrelated key and value", () => {
    // Given
    const search = "notice=first&notice=second&status=NO_SHOW&source=discord&reservation=obsolete";

    // When
    const written = writeReservationDeepLink(search, { date: "2026-08-10", reservationId: "rsv_4-A" });

    // Then
    expect(written).toBe(
      "notice=first&notice=second&source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A"
    );
  });

  it("parses an exact valid tuple without changing unrelated parameters", () => {
    // Given
    const search = "source=discord&section=reservations&date=2028-02-29&status=CONFIRMED&reservation=rsv_4-A&tag=urgent&tag=follow-up";

    // When
    const parsed = parseReservationDeepLink(search);

    // Then
    expect(parsed).toEqual({ kind: "valid", target: { date: "2028-02-29", reservationId: "rsv_4-A" } });
  });

  it.each([
    ["partial tuple", "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED"],
    ["invalid section", "source=discord&section=dashboard&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A"],
    ["non-calendar date", "source=discord&section=reservations&date=2026-02-29&status=CONFIRMED&reservation=rsv_4-A"],
    ["wrong status", "source=discord&section=reservations&date=2026-08-10&status=ALL&reservation=rsv_4-A"],
    ["malformed reservation id", "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv%2F4"],
    ["overlong reservation id", `source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=${"a".repeat(192)}`],
    ["duplicate section", "source=discord&section=reservations&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A"],
    ["duplicate date", "source=discord&section=reservations&date=2026-08-10&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A"],
    ["duplicate status", "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&status=CONFIRMED&reservation=rsv_4-A"],
    ["duplicate reservation", "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A&reservation=rsv_4-A"]
  ] as const)("rejects a %s without a lookup and removes every controlled key", (_caseName, search) => {
    // Given
    let lookupCount = 0;

    // When
    const result = resolveReservationDeepLink(search, () => {
      lookupCount += 1;
      return true;
    });

    // Then
    expect(result).toEqual({ kind: "invalid", cleanedSearch: "source=discord" });
    expect(lookupCount).toBe(0);
  });

  it("cleans only reservation after a valid target is opened so refresh cannot reopen it", () => {
    // Given
    const search = "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A&tag=urgent&tag=follow-up";

    // When
    const result = resolveReservationDeepLink(search, () => true);

    // Then
    expect(result).toEqual({
      kind: "found",
      cleanedSearch: "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&tag=urgent&tag=follow-up",
      target: { date: "2026-08-10", reservationId: "rsv_4-A" }
    });
  });

  it("cleans only reservation when a syntactically valid target is missing or cancelled", () => {
    // Given
    const search = "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=rsv_4-A&tag=urgent&tag=follow-up";

    // When
    const result = resolveReservationDeepLink(search, () => false);

    // Then
    expect(result).toEqual({
      kind: "missing",
      cleanedSearch: "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&tag=urgent&tag=follow-up"
    });
  });

  it("ignores a URL with no controlled tuple and never performs a lookup", () => {
    // Given
    let lookupCount = 0;

    // When
    const result = resolveReservationDeepLink("source=discord&tag=urgent&tag=follow-up", () => {
      lookupCount += 1;
      return true;
    });

    // Then
    expect(result).toEqual({ kind: "absent" });
    expect(lookupCount).toBe(0);
  });

  it("removes the controlled tuple rather than writing a partial tuple for invalid input", () => {
    // Given
    const search = "source=discord&section=reservations&date=2026-08-10&status=CONFIRMED&reservation=obsolete&tag=urgent&tag=follow-up";

    // When
    const written = writeReservationDeepLink(search, { date: "2026-02-29", reservationId: "rsv_4-A" });

    // Then
    expect(written).toBe("source=discord&tag=urgent&tag=follow-up");
  });

  it("builds the canonical absolute Discord deep link from the normalized application origin", () => {
    // Given
    const appOrigin = "https://info-room.example";

    // When
    const deepLink = buildAdminReservationDeepLinkUrl(appOrigin, { date: "2028-02-29", reservationId: "rsv_4-A" });

    // Then
    expect(deepLink).toBe(
      "https://info-room.example/?section=reservations&date=2028-02-29&status=CONFIRMED&reservation=rsv_4-A"
    );
  });
});
