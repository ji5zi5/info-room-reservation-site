import { afterEach, describe, expect, it, vi } from "vitest";

import { mintCsrfToken, validateCsrfToken } from "./csrf";
import { getCsrfTokenStore, resetMockCsrfTokenStoreForTests } from "./csrf-token-store";
import { prismaCsrfTokenStore } from "./prisma-csrf-store";

describe("CSRF token store selection", () => {
  afterEach(() => {
    resetMockCsrfTokenStoreForTests();
    vi.unstubAllEnvs();
  });

  it("mints and validates tokens when mock login runs without a database", async () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "");

    const store = getCsrfTokenStore();
    const now = new Date("2026-06-14T00:00:00.000Z");
    const token = await mintCsrfToken({ now, sessionId: "mock-session", store });

    await expect(validateCsrfToken({ now, sessionId: "mock-session", store, token })).resolves.toEqual({
      kind: "ok"
    });
  });

  it("keeps mock token records on global storage for route chunk reuse", async () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "");

    const now = new Date("2026-06-14T00:00:00.000Z");
    await mintCsrfToken({ now, sessionId: "mock-session", store: getCsrfTokenStore() });

    const records = Reflect.get(globalThis, "__infoRoomMockCsrfTokenRecords");
    expect(records).toBeInstanceOf(Map);
    if (!(records instanceof Map)) {
      throw new Error("Mock CSRF records were not stored globally");
    }
    expect(records.size).toBe(1);
  });

  it("keeps at most four live tokens per mock session without deleting another session", async () => {
    // Given
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "");
    const store = getCsrfTokenStore();
    const now = new Date("2026-06-14T00:00:00.000Z");
    const otherSessionToken = await mintCsrfToken({ now, sessionId: "other-session", store });

    // When
    const sessionTokens: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      sessionTokens.push(await mintCsrfToken({ now, sessionId: "mock-session", store }));
    }

    // Then
    const records = Reflect.get(globalThis, "__infoRoomMockCsrfTokenRecords");
    expect(records).toBeInstanceOf(Map);
    if (!(records instanceof Map)) {
      throw new Error("Mock CSRF records were not stored globally");
    }
    const oldestToken = sessionTokens.at(0);
    const newestToken = sessionTokens.at(-1);
    if (oldestToken === undefined || newestToken === undefined) {
      throw new Error("Expected minted CSRF tokens");
    }
    expect(records.size).toBe(5);
    await expect(validateCsrfToken({ now, sessionId: "mock-session", store, token: oldestToken })).resolves.toEqual({
      kind: "error",
      reason: "csrf_invalid"
    });
    await expect(validateCsrfToken({ now, sessionId: "mock-session", store, token: newestToken })).resolves.toEqual({
      kind: "ok"
    });
    await expect(
      validateCsrfToken({ now, sessionId: "other-session", store, token: otherSessionToken })
    ).resolves.toEqual({ kind: "ok" });
  });

  it("keeps the Prisma token store when a database URL is configured", () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.test:5432/info_room");

    expect(getCsrfTokenStore()).toBe(prismaCsrfTokenStore);
  });
});
