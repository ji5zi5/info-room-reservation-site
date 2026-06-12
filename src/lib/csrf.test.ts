import { describe, expect, it } from "vitest";

import { mintCsrfToken, validateCsrfToken, type CsrfTokenRecord, type CsrfTokenStore } from "./csrf";

describe("CSRF tokens", () => {
  it("validates a token for the same session", async () => {
    const store = memoryStore();
    const now = new Date("2026-06-12T10:00:00.000Z");
    const token = await mintCsrfToken({ now, sessionId: "session-a", store });

    await expect(validateCsrfToken({ now, sessionId: "session-a", store, token })).resolves.toEqual({ kind: "ok" });
    expect(store.records[0]?.tokenHash).not.toBe(token);
  });

  it("rejects missing, unknown, cross-session, and expired tokens", async () => {
    const store = memoryStore();
    const now = new Date("2026-06-12T10:00:00.000Z");
    const token = await mintCsrfToken({ now, sessionId: "session-a", store });

    await expect(validateCsrfToken({ now, sessionId: "session-a", store, token: null })).resolves.toEqual({
      kind: "error",
      reason: "csrf_missing"
    });
    await expect(validateCsrfToken({ now, sessionId: "session-a", store, token: "unknown" })).resolves.toEqual({
      kind: "error",
      reason: "csrf_invalid"
    });
    await expect(validateCsrfToken({ now, sessionId: "session-b", store, token })).resolves.toEqual({
      kind: "error",
      reason: "csrf_invalid"
    });
    await expect(
      validateCsrfToken({ now: new Date("2026-06-12T13:01:00.000Z"), sessionId: "session-a", store, token })
    ).resolves.toEqual({
      kind: "error",
      reason: "csrf_expired"
    });
  });
});

function memoryStore(): CsrfTokenStore & { readonly records: CsrfTokenRecord[] } {
  const records: CsrfTokenRecord[] = [];
  return {
    records,
    async create(record) {
      records.push(record);
    },
    async findByHash(tokenHash) {
      return records.find((record) => record.tokenHash === tokenHash) ?? null;
    }
  };
}
