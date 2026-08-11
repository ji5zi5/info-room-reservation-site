import { z } from "zod";

import { DiscordApplicationConfigError, parseDiscordApplicationConfig, type DiscordApplicationConfig } from "./discord-app-config";
import { isDiscordWebhookUrl } from "./discord-webhook-url";
import { resolveLocalStudentNumbers } from "./local-login";

type ServerEnvInput = Readonly<Record<string, string | undefined>>;

const BooleanFlagSchema = z.union([z.literal("true"), z.literal("false")]).optional();
const MIN_PRODUCTION_SECRET_LENGTH = 24;
const REQUIRED_PRODUCTION_KEYS = [
  "ADMIN_STUDENT_NUMBERS",
  "APP_ORIGIN",
  "CLOSED_PERIOD_CRON_SECRET",
  "DATABASE_URL",
  "DIRECT_URL",
  "MAINTENANCE_CRON_SECRET",
  "SESSION_SECRET"
] as const;

const ServerEnvSchema = z.object({
  ADMIN_LOGIN_ID: z.string().optional(),
  ADMIN_LOGIN_PASSWORD: z.string().optional(),
  ADMIN_STUDENT_NUMBERS: z.string().optional(),
  APP_ORIGIN: z.string().optional(),
  CLOSED_PERIOD_CRON_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  DISCORD_ADMIN_ROLE_ID: z.string().optional(),
  DISCORD_ADMIN_USER_MAP: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal("")]).optional(),
  ENABLE_LOCAL_ADMIN: BooleanFlagSchema,
  ENABLE_LOCAL_STUDENT: BooleanFlagSchema,
  ENABLE_PRODUCTION_LOCAL_STUDENT: BooleanFlagSchema,
  LOCAL_STUDENT_LOGIN_ID: z.string().optional(),
  LOCAL_STUDENT_LOGIN_PASSWORD: z.string().optional(),
  LOCAL_STUDENT_NUMBER: z.string().optional(),
  MAINTENANCE_CRON_SECRET: z.string().optional(),
  NODE_ENV: z.string().optional(),
  RETENTION_PURGE_ENABLED: BooleanFlagSchema,
  RIRO_MOCK_LOGIN: BooleanFlagSchema,
  SESSION_SECRET: z.string().optional(),
  TRUST_FORWARDED_IP_HEADERS: BooleanFlagSchema
});

export type ServerEnv = {
  readonly adminLoginId: string | null;
  readonly adminLoginPassword: string | null;
  readonly adminStudentNumbers: string | null;
  readonly appOrigin: string | null;
  readonly closedPeriodCronSecret: string | null;
  readonly cronSecret: string | null;
  readonly databaseUrl: string | null;
  readonly directUrl: string | null;
  readonly discordApplication: DiscordApplicationConfig | null;
  readonly discordWebhookUrl: string | null;
  readonly enableLocalAdmin: boolean;
  readonly enableProductionLocalStudent: boolean;
  readonly enableLocalStudent: boolean;
  readonly localStudentLoginId: string | null;
  readonly localStudentLoginPassword: string | null;
  readonly localStudentNumber: string | null;
  readonly maintenanceCronSecret: string | null;
  readonly nodeEnv: string;
  readonly retentionPurgeEnabled: boolean;
  readonly riroMockLogin: boolean;
  readonly sessionSecret: string | null;
  readonly trustForwardedIpHeaders: boolean;
};

export function parseServerEnv(raw: ServerEnvInput = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServerEnvError(parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean));
  }

  let discordApplication: DiscordApplicationConfig | null;
  try {
    discordApplication = parseDiscordApplicationConfig(parsed.data);
  } catch (error) {
    if (error instanceof DiscordApplicationConfigError) {
      throw new ServerEnvError(error.keys);
    }
    throw error;
  }

  return {
    adminLoginId: normalizeOptional(parsed.data.ADMIN_LOGIN_ID),
    adminLoginPassword: normalizeOptional(raw.ADMIN_LOGIN_PASSWORD),
    adminStudentNumbers: normalizeOptional(parsed.data.ADMIN_STUDENT_NUMBERS),
    appOrigin: parseApplicationOrigin(normalizeOptional(parsed.data.APP_ORIGIN), parsed.data.NODE_ENV ?? "development"),
    closedPeriodCronSecret: normalizeOptional(parsed.data.CLOSED_PERIOD_CRON_SECRET),
    cronSecret: normalizeOptional(parsed.data.CRON_SECRET),
    databaseUrl: normalizeOptional(parsed.data.DATABASE_URL),
    directUrl: normalizeOptional(parsed.data.DIRECT_URL),
    discordApplication,
    discordWebhookUrl: normalizeOptional(parsed.data.DISCORD_WEBHOOK_URL),
    enableLocalAdmin: parsed.data.ENABLE_LOCAL_ADMIN === "true",
    enableProductionLocalStudent: parsed.data.ENABLE_PRODUCTION_LOCAL_STUDENT === "true",
    enableLocalStudent: parsed.data.ENABLE_LOCAL_STUDENT === "true",
    localStudentLoginId: normalizeOptional(parsed.data.LOCAL_STUDENT_LOGIN_ID),
    localStudentLoginPassword: normalizeOptional(raw.LOCAL_STUDENT_LOGIN_PASSWORD),
    localStudentNumber: normalizeOptional(parsed.data.LOCAL_STUDENT_NUMBER),
    maintenanceCronSecret: normalizeOptional(parsed.data.MAINTENANCE_CRON_SECRET),
    nodeEnv: parsed.data.NODE_ENV ?? "development",
    retentionPurgeEnabled: parsed.data.RETENTION_PURGE_ENABLED === "true",
    riroMockLogin: parsed.data.RIRO_MOCK_LOGIN === "true",
    sessionSecret: normalizeOptional(parsed.data.SESSION_SECRET),
    trustForwardedIpHeaders: parsed.data.TRUST_FORWARDED_IP_HEADERS === "true"
  };
}

export function assertProductionEnvSafe(raw: ServerEnvInput = process.env): void {
  const env = parseServerEnv(raw);
  if (env.nodeEnv === "production") {
    const invalidKeys: string[] = [...missingProductionKeys(env)];
    if (env.riroMockLogin) {
      invalidKeys.push("RIRO_MOCK_LOGIN");
    }
    if (env.enableLocalAdmin) {
      invalidKeys.push("ENABLE_LOCAL_ADMIN");
    }
    if (env.enableLocalStudent) {
      invalidKeys.push("ENABLE_LOCAL_STUDENT");
    }
    if (env.discordWebhookUrl === null || !isDiscordWebhookUrl(env.discordWebhookUrl)) {
      invalidKeys.push("DISCORD_WEBHOOK_URL");
    }
    if (!env.trustForwardedIpHeaders) {
      invalidKeys.push("TRUST_FORWARDED_IP_HEADERS");
    }
    if (env.sessionSecret !== null && env.sessionSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      invalidKeys.push("SESSION_SECRET");
    }
    if (env.cronSecret !== null && env.cronSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      invalidKeys.push("CRON_SECRET");
    }
    if (env.cronSecret !== null) {
      invalidKeys.push("CRON_SECRET");
    }
    if (env.closedPeriodCronSecret !== null && env.closedPeriodCronSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      invalidKeys.push("CLOSED_PERIOD_CRON_SECRET");
    }
    if (env.maintenanceCronSecret !== null && env.maintenanceCronSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      invalidKeys.push("MAINTENANCE_CRON_SECRET");
    }
    if (invalidKeys.length > 0) {
      throw new ServerEnvError(invalidKeys);
    }
  }
  if (env.enableLocalAdmin && env.adminLoginPassword !== null && env.adminLoginPassword.length < 12) {
    throw new ServerEnvError(["ADMIN_LOGIN_PASSWORD"]);
  }
  if (isAnyLocalStudentLoginEnabled(env)) {
    const localStudentLoginIds = splitEnvList(env.localStudentLoginId);
    const localStudentLoginPasswords = splitEnvList(env.localStudentLoginPassword);
    const localStudentNumbers = splitEnvList(env.localStudentNumber);
    const missingKeys = [
      localStudentLoginIds.length === 0 ? "LOCAL_STUDENT_LOGIN_ID" : null,
      localStudentLoginPasswords.length === 0 ? "LOCAL_STUDENT_LOGIN_PASSWORD" : null
    ].filter((key): key is string => key !== null);
    if (missingKeys.length > 0) {
      throw new ServerEnvError(missingKeys);
    }
    const shapeErrors = [
      localStudentLoginPasswords.length !== 1 && localStudentLoginPasswords.length !== localStudentLoginIds.length
        ? "LOCAL_STUDENT_LOGIN_PASSWORD"
        : null,
      localStudentNumbers.length > 0 && localStudentNumbers.length !== localStudentLoginIds.length
        ? "LOCAL_STUDENT_NUMBER"
        : null
    ].filter((key): key is string => key !== null);
    if (shapeErrors.length > 0) {
      throw new ServerEnvError(shapeErrors);
    }
    const adminStudentNumbers = new Set(splitEnvList(env.adminStudentNumbers));
    const resolvedLocalStudentNumbers = resolveLocalStudentNumbers({
      ids: localStudentLoginIds,
      studentNumbers: localStudentNumbers
    });
    if (resolvedLocalStudentNumbers.some((studentNumber) => adminStudentNumbers.has(studentNumber))) {
      throw new ServerEnvError([
        "ADMIN_STUDENT_NUMBERS",
        localStudentNumbers.length > 0 ? "LOCAL_STUDENT_NUMBER" : "LOCAL_STUDENT_LOGIN_ID"
      ]);
    }
    if (env.enableLocalAdmin && env.adminLoginId !== null && localStudentLoginIds.includes(env.adminLoginId)) {
      throw new ServerEnvError(["ADMIN_LOGIN_ID", "LOCAL_STUDENT_LOGIN_ID"]);
    }
  }
  if (
    isAnyLocalStudentLoginEnabled(env) &&
    splitEnvList(env.localStudentLoginPassword).some((password) => password.length < 12)
  ) {
    throw new ServerEnvError(["LOCAL_STUDENT_LOGIN_PASSWORD"]);
  }
}

export function isMockLoginEnabled(raw: ServerEnvInput = process.env): boolean {
  assertProductionEnvSafe(raw);
  const env = parseServerEnv(raw);
  return env.riroMockLogin && env.databaseUrl === null && env.nodeEnv !== "production";
}

export function isLocalAdminLoginEnabled(raw: ServerEnvInput = process.env): boolean {
  assertProductionEnvSafe(raw);
  return parseServerEnv(raw).enableLocalAdmin;
}

export function isLocalStudentLoginEnabled(raw: ServerEnvInput = process.env): boolean {
  assertProductionEnvSafe(raw);
  return isAnyLocalStudentLoginEnabled(parseServerEnv(raw));
}

export function shouldTrustForwardedIpHeaders(raw: ServerEnvInput = process.env): boolean {
  return parseServerEnv(raw).trustForwardedIpHeaders;
}

export function isRetentionPurgeEnabled(raw: ServerEnvInput = process.env): boolean {
  return parseServerEnv(raw).retentionPurgeEnabled;
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseApplicationOrigin(value: string | null, nodeEnv: string): string | null {
  if (value === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerEnvError(["APP_ORIGIN"]);
  }
  const isOriginOnly =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  const allowsLocalHttp =
    (nodeEnv === "development" || nodeEnv === "test") &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!isOriginOnly || (url.protocol !== "https:" && !allowsLocalHttp)) {
    throw new ServerEnvError(["APP_ORIGIN"]);
  }
  return url.origin;
}

function splitEnvList(value: string | null): readonly string[] {
  if (value === null) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isAnyLocalStudentLoginEnabled(env: ServerEnv): boolean {
  return env.enableLocalStudent || env.enableProductionLocalStudent;
}

function missingProductionKeys(env: ServerEnv): readonly string[] {
  const values = {
    ADMIN_STUDENT_NUMBERS: env.adminStudentNumbers,
    APP_ORIGIN: env.appOrigin,
    CLOSED_PERIOD_CRON_SECRET: env.closedPeriodCronSecret,
    DATABASE_URL: env.databaseUrl,
    DIRECT_URL: env.directUrl,
    MAINTENANCE_CRON_SECRET: env.maintenanceCronSecret,
    SESSION_SECRET: env.sessionSecret
  } satisfies Record<(typeof REQUIRED_PRODUCTION_KEYS)[number], string | null>;
  return REQUIRED_PRODUCTION_KEYS.filter((key) => values[key] === null);
}

export class ServerEnvError extends Error {
  public constructor(keys: readonly string[]) {
    super(`Invalid server environment: ${keys.join(", ")}`);
    this.name = "ServerEnvError";
  }
}
