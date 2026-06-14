import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAdminSettings } from "./admin-api-client";

describe("admin api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a failure result instead of hiding empty error responses", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(fetchAdminSettings("2026-06-14")).resolves.toEqual({
      kind: "error",
      message: "관리자 데이터를 불러오지 못했습니다."
    });
  });
});
