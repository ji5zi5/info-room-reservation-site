export const CLOSED_PERIOD_CRON_TITLE = "Info Room closed-period notifications";
export const CLOSED_PERIOD_CRON_PATH = "/api/cron/closed-period-notifications";
export const MAINTENANCE_CRON_TITLE = "Info Room maintenance";
export const MAINTENANCE_CRON_PATH = "/api/cron/maintenance";

const EVERY_MINUTE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  50, 51, 52, 53, 54, 55, 56, 57, 58, 59
] as const;

export type CronJobOrgSchedule = {
  readonly expiresAt: number;
  readonly hours: readonly number[];
  readonly mdays: readonly number[];
  readonly minutes: readonly number[];
  readonly months: readonly number[];
  readonly timezone: string;
  readonly wdays: readonly number[];
};

export type CronJobOrgPayload = {
  readonly enabled: boolean;
  readonly extendedData: {
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly requestMethod: number;
  readonly requestTimeout: number;
  readonly saveResponses: boolean;
  readonly schedule: CronJobOrgSchedule;
  readonly title: string;
  readonly url: string;
};

export type ClosedPeriodCronInput = {
  readonly baseUrl: string;
  readonly cronSecret: string;
};

export function buildClosedPeriodCronJob(input: ClosedPeriodCronInput): CronJobOrgPayload {
  return buildCronJob({
    ...input,
    path: CLOSED_PERIOD_CRON_PATH,
    schedule: {
      expiresAt: 0,
      hours: [-1],
      mdays: [-1],
      minutes: EVERY_MINUTE,
      months: [-1],
      timezone: "Asia/Seoul",
      wdays: [-1]
    },
    title: CLOSED_PERIOD_CRON_TITLE
  });
}

export function buildMaintenanceCronJob(input: ClosedPeriodCronInput): CronJobOrgPayload {
  return buildCronJob({
    ...input,
    path: MAINTENANCE_CRON_PATH,
    schedule: {
      expiresAt: 0,
      hours: [4],
      mdays: [-1],
      minutes: [0],
      months: [-1],
      timezone: "Asia/Seoul",
      wdays: [-1]
    },
    title: MAINTENANCE_CRON_TITLE
  });
}

function buildCronJob(input: ClosedPeriodCronInput & {
  readonly path: string;
  readonly schedule: CronJobOrgSchedule;
  readonly title: string;
}): CronJobOrgPayload {
  return {
    enabled: true,
    extendedData: {
      headers: {
        Authorization: `Bearer ${input.cronSecret}`
      }
    },
    requestMethod: 0,
    requestTimeout: 25,
    saveResponses: true,
    schedule: input.schedule,
    title: input.title,
    url: `${normalizeCronBaseUrl(input.baseUrl)}${input.path}`
  };
}

export function normalizeCronBaseUrl(input: string): string {
  const url = new URL(input);
  return url.origin;
}
