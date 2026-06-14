import { assertProductionEnvSafe, parseServerEnv, ServerEnvError } from "../src/lib/env";

const requiredProductionKeys = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "ADMIN_STUDENT_NUMBERS",
  "CRON_SECRET"
] as const;

try {
  assertProductionEnvSafe(process.env);
  const env = parseServerEnv(process.env);
  if (env.nodeEnv === "production") {
    const missing = requiredProductionKeys.filter((key) => process.env[key]?.trim() === undefined || process.env[key]?.trim() === "");
    if (missing.length > 0) {
      throw new ServerEnvError(missing);
    }
  }
  console.log("Predeploy environment check passed.");
} catch (error) {
  if (error instanceof ServerEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
