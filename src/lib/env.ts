import { z } from "zod";

type ServerEnvInput = Readonly<Record<string, string | undefined>>;

const BooleanFlagSchema = z.union([z.literal("true"), z.literal("false")]).optional();

const ServerEnvSchema = z.object({
  ADMIN_LOGIN_ID: z.string().optional(),
  ADMIN_LOGIN_PASSWORD: z.string().optional(),
  ADMIN_STUDENT_NUMBERS: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal("")]).optional(),
  ENABLE_LOCAL_ADMIN: BooleanFlagSchema,
  NODE_ENV: z.string().optional(),
  RIRO_MOCK_LOGIN: BooleanFlagSchema,
  SESSION_SECRET: z.string().optional()
});

export type ServerEnv = {
  readonly adminLoginId: string | null;
  readonly adminLoginPassword: string | null;
  readonly adminStudentNumbers: string | null;
  readonly cronSecret: string | null;
  readonly databaseUrl: string | null;
  readonly discordWebhookUrl: string | null;
  readonly enableLocalAdmin: boolean;
  readonly nodeEnv: string;
  readonly riroMockLogin: boolean;
  readonly sessionSecret: string | null;
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
    discordWebhookUrl: normalizeOptional(parsed.data.DISCORD_WEBHOOK_URL),
    enableLocalAdmin: parsed.data.ENABLE_LOCAL_ADMIN === "true",
    nodeEnv: parsed.data.NODE_ENV ?? "development",
    riroMockLogin: parsed.data.RIRO_MOCK_LOGIN === "true",
    sessionSecret: normalizeOptional(parsed.data.SESSION_SECRET)
  };
}

export function assertProductionEnvSafe(raw: ServerEnvInput = process.env): void {
  const env = parseServerEnv(raw);
  if (env.nodeEnv === "production" && env.riroMockLogin) {
    throw new ServerEnvError(["RIRO_MOCK_LOGIN"]);
  }
  if (env.enableLocalAdmin && env.adminLoginPassword !== null && env.adminLoginPassword.length < 12) {
    throw new ServerEnvError(["ADMIN_LOGIN_PASSWORD"]);
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

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export class ServerEnvError extends Error {
  public constructor(keys: readonly string[]) {
    super(`Invalid server environment: ${keys.join(", ")}`);
    this.name = "ServerEnvError";
  }
}
