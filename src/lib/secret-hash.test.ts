import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hashServerSecretValue } from "./secret-hash";

describe("hashServerSecretValue", () => {
  it("uses the production session secret as a keyed hash when it is configured", () => {
    // Given
    vi.stubEnv("SESSION_SECRET", "session-secret-with-enough-length");

    // When
    const hashed = hashServerSecretValue("session-token", "session");

    // Then
    expect(hashed).not.toBe(createHash("sha256").update("session-token").digest("hex"));
    expect(hashed).toHaveLength(64);
  });

  it("separates hashes by purpose so CSRF and session tokens cannot share a digest", () => {
    // Given
    vi.stubEnv("SESSION_SECRET", "session-secret-with-enough-length");

    // When
    const sessionHash = hashServerSecretValue("same-token", "session");
    const csrfHash = hashServerSecretValue("same-token", "csrf");

    // Then
    expect(sessionHash).not.toBe(csrfHash);
  });

  it("rejects production hashing when the session secret is missing", () => {
    // Given
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");

    // When / Then
    expect(() => hashServerSecretValue("session-token", "session")).toThrow("SESSION_SECRET");
  });
});
