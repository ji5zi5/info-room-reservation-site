import { describe, expect, it } from "vitest";

import {
  parseAdminConsoleDeepLink,
  resolveAdminConsoleDeepLink,
  writeAdminConsoleDeepLink,
  buildAdminReservationDeepLinkUrl,
  parseReservationDeepLink,
  resolveReservationDeepLink,
  writeReservationDeepLink
} from "./admin-console-url";

describe("versioned admin exact-target URL codec", () => {
  it.each([
    [{ kind: "reservation", reservationId: "reservation-127" }, "section=reservations&reservation=reservation-127"],
    [{ kind: "user", userId: "user-127" }, "section=students&user=user-127"],
    [{ actionId: "action-227", kind: "audit" }, "section=audit&action=action-227"]
  ] as const)("round-trips one %s target with codec version 1", (target, expected) => {
    // Given: an unrelated query key and one typed exact target.
    const original = "source=operations";

    // When: version 1 writes and parses the target.
    const written = writeAdminConsoleDeepLink(original, target);
    const parsed = parseAdminConsoleDeepLink(written);

    // Then: the approved URL shape is canonical and versioned in the parsed contract.
    expect(written).toBe(`source=operations&${expected}`);
    expect(parsed).toEqual({ kind: "valid", target, version: 1 });
  });

  it("cleans malformed controlled keys without looking up or focusing a substitute", () => {
    // Given: a malformed audit target plus unrelated state.
    let lookupCount = 0;

    // When: the resolver processes the malformed URL.
    const resolved = resolveAdminConsoleDeepLink("source=operations&section=audit&action=bad%2Faction", () => {
      lookupCount += 1;
      return true;
    });

    // Then: all controlled keys are removed and no substitute lookup occurs.
    expect(resolved).toEqual({ cleanedSearch: "source=operations", kind: "invalid" });
    expect(lookupCount).toBe(0);
  });

  it("refuses to write a malformed typed target after cleaning controlled keys", () => {
    // Given: stale controlled keys and a malformed reservation target from an untrusted caller.
    const search = "source=operations&section=audit&action=old-action";

    // When: the versioned writer receives an invalid identifier.
    const written = writeAdminConsoleDeepLink(search, { kind: "reservation", reservationId: "bad/id" });

    // Then: only unrelated state remains and no partial or substitute target is written.
    expect(written).toBe("source=operations");
  });

  it("cleans a missing exact target and never focuses a substitute row", () => {
    // Given: a syntactically valid user target.
    const search = "source=operations&section=students&user=user-127";

    // When: the authorized exact lookup reports no matching target.
    const resolved = resolveAdminConsoleDeepLink(search, () => false);

    // Then: only controlled keys are removed and no target is returned.
    expect(resolved).toEqual({ cleanedSearch: "source=operations", kind: "missing" });
  });

  it("cleans a forbidden exact target using the non-disclosing missing outcome", () => {
    // Given: a syntactically valid audit target that the authorized lookup must not disclose.
    let lookupCount = 0;
    const search = "source=operations&section=audit&action=action-forbidden";

    // When: the authorized exact lookup refuses to expose the target.
    const resolved = resolveAdminConsoleDeepLink(search, () => {
      lookupCount += 1;
      return false;
    });

    // Then: controlled keys are removed and no substitute target is focused.
    expect(resolved).toEqual({ cleanedSearch: "source=operations", kind: "missing" });
    expect(lookupCount).toBe(1);
    expect(resolved).not.toHaveProperty("target");
  });
});

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
