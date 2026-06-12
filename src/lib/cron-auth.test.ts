import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "./cron-auth";

describe("cron authorization", () => {
  it("accepts only the configured bearer token", () => {
    expect(isAuthorizedCronRequest("Bearer cron-secret", "cron-secret")).toBe(true);
    expect(isAuthorizedCronRequest("cron-secret", "cron-secret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer wrong", "cron-secret")).toBe(false);
    expect(isAuthorizedCronRequest(null, "cron-secret")).toBe(false);
  });

  it("rejects when CRON_SECRET is missing", () => {
    expect(isAuthorizedCronRequest("Bearer anything", undefined)).toBe(false);
  });
});
