import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("liveness route", () => {
  it("returns ok without depending on the database or external services", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
