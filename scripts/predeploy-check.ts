import { assertProductionEnvSafe, parseServerEnv, ServerEnvError } from "../src/lib/env";

const requiredProductionKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "SESSION_SECRET",
  "ADMIN_STUDENT_NUMBERS",
  "CRON_SECRET",
  "DISCORD_WEBHOOK_URL",
  "TRUST_FORWARDED_IP_HEADERS"
] as const;

try {
  const env = parseServerEnv(process.env);
  if (env.nodeEnv === "production") {
    const missing = requiredProductionKeys.filter((key) => process.env[key]?.trim() === undefined || process.env[key]?.trim() === "");
    if (missing.length > 0) {
      throw new ServerEnvError(missing);
    }
  }
  assertProductionEnvSafe(process.env);
  console.log("Predeploy environment check passed.");
} catch (error) {
  if (error instanceof ServerEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
