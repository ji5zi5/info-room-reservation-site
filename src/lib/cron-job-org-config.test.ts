import { describe, expect, it } from "vitest";

import {
  buildClosedPeriodCronJob,
  buildMaintenanceCronJob,
  normalizeCronBaseUrl
} from "./cron-job-org-config";

describe("cron-job.org config", () => {
  it("builds a one-minute closed-period notification job with the cron secret header", () => {
    const job = buildClosedPeriodCronJob({
      baseUrl: "https://info-room-reservation-site.vercel.app/",
      cronSecret: "secret-value"
    });

    expect(job).toMatchObject({
      enabled: true,
      requestMethod: 0,
      requestTimeout: 25,
      schedule: {
        timezone: "Asia/Seoul",
        hours: [-1],
        mdays: [-1],
        minutes: [
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
          10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
          20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
          30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
          40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
          50, 51, 52, 53, 54, 55, 56, 57, 58, 59
        ],
        months: [-1],
        wdays: [-1]
      },
      title: "Info Room closed-period notifications",
      url: "https://info-room-reservation-site.vercel.app/api/cron/closed-period-notifications"
    });
    expect(job.extendedData.headers).toEqual({
      Authorization: "Bearer secret-value"
    });
  });

  it("normalizes a production base URL without leaking path segments into the cron target", () => {
    expect(normalizeCronBaseUrl("https://example.com/admin?tab=settings")).toBe("https://example.com");
  });

  it("builds a distinct daily maintenance job with its own secret", () => {
    const job = buildMaintenanceCronJob({
      baseUrl: "https://info-room-reservation-site.vercel.app/",
      cronSecret: "maintenance-secret"
    });

    expect(job).toMatchObject({
      enabled: true,
      schedule: {
        hours: [4],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        timezone: "Asia/Seoul",
        wdays: [-1]
      },
      title: "Info Room maintenance",
      url: "https://info-room-reservation-site.vercel.app/api/cron/maintenance"
    });
    expect(job.extendedData.headers).toEqual({
      Authorization: "Bearer maintenance-secret"
    });
  });
});
