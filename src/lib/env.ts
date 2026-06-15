import { z } from "zod";

import { isDiscordWebhookUrl } from "./discord-webhook-url";

type ServerEnvInput = Readonly<Record<string, string | undefined>>;

const BooleanFlagSchema = z.union([z.literal("true"), z.literal("false")]).optional();

const ServerEnvSchema = z.object({
  ADMIN_LOGIN_ID: z.string().optional(),
  ADMIN_LOGIN_PASSWORD: z.string().optional(),
  ADMIN_STUDENT_NUMBERS: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal("")]).optional(),
  ENABLE_LOCAL_ADMIN: BooleanFlagSchema,
  ENABLE_LOCAL_STUDENT: BooleanFlagSchema,
  ENABLE_PRODUCTION_LOCAL_STUDENT: BooleanFlagSchema,
  LOCAL_STUDENT_LOGIN_ID: z.string().optional(),
  LOCAL_STUDENT_LOGIN_PASSWORD: z.string().optional(),
  LOCAL_STUDENT_NUMBER: z.string().optional(),
  NODE_ENV: z.string().optional(),
  RIRO_MOCK_LOGIN: BooleanFlagSchema,
  SESSION_SECRET: z.string().optional(),
  TRUST_FORWARDED_IP_HEADERS: BooleanFlagSchema
});

export type ServerEnv = {
  readonly adminLoginId: string | null;
  readonly adminLoginPassword: string | null;
  readonly adminStudentNumbers: string | null;
  readonly cronSecret: string | null;
  readonly databaseUrl: string | null;
  readonly directUrl: string | null;
  readonly discordWebhookUrl: string | null;
  readonly enableLocalAdmin: boolean;
  readonly enableProductionLocalStudent: boolean;
  readonly enableLocalStudent: boolean;
  readonly localStudentLoginId: string | null;
  readonly localStudentLoginPassword: string | null;
  readonly localStudentNumber: string | null;
  readonly nodeEnv: string;
  readonly riroMockLogin: boolean;
  readonly sessionSecret: string | null;
  readonly trustForwardedIpHeaders: boolean;
};

export function parseServerEnv(raw: ServerEnvInput = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServerEnvError(parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean));
  }

  return {
    adminLoginId: normalizeOptional(parsed.data.ADMIN_LOGIN_ID),
    adminLoginPassword: normalizeOptional(raw.ADMIN_LOGIN_PASSWORD),
    adminStudentNumbers: normalizeOptional(parsed.data.ADMIN_STUDENT_NUMBERS),
    cronSecret: normalizeOptional(parsed.data.CRON_SECRET),
    databaseUrl: normalizeOptional(parsed.data.DATABASE_URL),
    directUrl: normalizeOptional(parsed.data.DIRECT_URL),
    discordWebhookUrl: normalizeOptional(parsed.data.DISCORD_WEBHOOK_URL),
    enableLocalAdmin: parsed.data.ENABLE_LOCAL_ADMIN === "true",
    enableProductionLocalStudent: parsed.data.ENABLE_PRODUCTION_LOCAL_STUDENT === "true",
    enableLocalStudent: parsed.data.ENABLE_LOCAL_STUDENT === "true",
    localStudentLoginId: normalizeOptional(parsed.data.LOCAL_STUDENT_LOGIN_ID),
    localStudentLoginPassword: normalizeOptional(raw.LOCAL_STUDENT_LOGIN_PASSWORD),
    localStudentNumber: normalizeOptional(parsed.data.LOCAL_STUDENT_NUMBER),
    nodeEnv: parsed.data.NODE_ENV ?? "development",
    riroMockLogin: parsed.data.RIRO_MOCK_LOGIN === "true",
    sessionSecret: normalizeOptional(parsed.data.SESSION_SECRET),
    trustForwardedIpHeaders: parsed.data.TRUST_FORWARDED_IP_HEADERS === "true"
  };
}

export function assertProductionEnvSafe(raw: ServerEnvInput = process.env): void {
  const env = parseServerEnv(raw);
  if (env.nodeEnv === "production") {
    const invalidKeys: string[] = [];
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

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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

export class ServerEnvError extends Error {
  public constructor(keys: readonly string[]) {
    super(`Invalid server environment: ${keys.join(", ")}`);
    this.name = "ServerEnvError";
  }
}
