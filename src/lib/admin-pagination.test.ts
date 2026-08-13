import { describe, expect, it } from "vitest";

import {
  ADMIN_CURSOR_TTL_MS,
  ADMIN_PAGE_SIZE,
  AdminCursorError,
  issueAdminCursor,
  parseAdminCursor
} from "./admin-pagination";

const secret = "cursor-test-secret";
const now = new Date("2026-08-13T01:00:00.000Z");
const filters = { bookingStatus: "ALL", query: "김" } as const;
const last = { createdAt: "2026-08-12T01:00:00.000Z", id: "user-50" } as const;

describe("authenticated admin pagination", () => {
  it("round-trips a versioned 15-minute creation-bounded cursor", () => {
    // Given: normalized filters and an immutable user tuple.
    const cursor = issueAdminCursor({ cutoff: now, filters, last, now, resource: "users", secret });

    // When: the cursor is parsed for the bound resource and filters.
    const parsed = parseAdminCursor({ cursor, filters, now, resource: "users", secret });

    // Then: all creation-bound movement fields are authenticated.
    expect(parsed).toMatchObject({ cutoff: now.toISOString(), filters, last, resource: "users", v: 1 });
    expect(parsed.exp - parsed.iat).toBe(ADMIN_CURSOR_TTL_MS);
    expect(ADMIN_PAGE_SIZE).toBe(50);
  });

  it.each([
    ["tampered", (cursor: string) => `${cursor.startsWith("a") ? "b" : "a"}${cursor.slice(1)}`, "CURSOR_TAMPERED"],
    ["expired", (cursor: string) => cursor, "CURSOR_EXPIRED"]
  ] as const)("rejects a %s cursor with a typed error", (_label, mutate, code) => {
    // Given: an issued cursor and either tampering or an expired clock.
    const issued = issueAdminCursor({ cutoff: now, filters, last, now, resource: "users", secret });
    const parseNow = code === "CURSOR_EXPIRED" ? new Date(now.getTime() + ADMIN_CURSOR_TTL_MS) : now;

    // When: the untrusted cursor crosses the parser boundary.
    const parse = () => parseAdminCursor({ cursor: mutate(issued), filters, now: parseNow, resource: "users", secret });

    // Then: the expected typed failure is returned.
    expect(parse).toThrowError(expect.objectContaining({ code, name: "AdminCursorError" }));
  });

  it("rejects wrong-resource reuse and normalized-filter drift", () => {
    // Given: a user cursor bound to one normalized query.
    const cursor = issueAdminCursor({ cutoff: now, filters, last, now, resource: "users", secret });

    // When: callers reuse it for another resource or query.
    const wrongResource = () => parseAdminCursor({
      cursor,
      filters: { action: "ALL", query: "김" },
      now,
      resource: "audits",
      secret
    });
    const driftedFilter = () => parseAdminCursor({ cursor, filters: { ...filters, query: "박" }, now, resource: "users", secret });

    // Then: both failures remain distinguishable to the API boundary.
    expect(wrongResource).toThrowError(expect.objectContaining({ code: "CURSOR_RESOURCE_MISMATCH" }));
    expect(driftedFilter).toThrowError(expect.objectContaining({ code: "CURSOR_FILTER_MISMATCH" }));
    expect(AdminCursorError).toBeDefined();
  });
});
