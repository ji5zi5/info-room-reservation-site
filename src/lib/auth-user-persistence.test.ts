import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("authenticated user persistence ordering contract", () => {
  it("keeps user creation time immutable across profile refreshes", () => {
    // Given: the authenticated-user persistence adapter.
    const source = readFileSync(resolve("src/lib/auth-user-persistence.ts"), "utf8");

    // When: update payload fields are inspected.
    const updatePayload = source.slice(source.indexOf("function authenticatedUserData"));

    // Then: profile refresh never rewrites the pagination creation key.
    expect(updatePayload).not.toContain("createdAt:");
  });
});
