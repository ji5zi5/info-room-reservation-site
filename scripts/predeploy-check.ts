import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertProductionEnvSafe, parseServerEnv, ServerEnvError } from "../src/lib/env";

const requiredProductionKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "SESSION_SECRET",
  "ADMIN_STUDENT_NUMBERS",
  "CLOSED_PERIOD_CRON_SECRET",
  "MAINTENANCE_CRON_SECRET",
  "DISCORD_WEBHOOK_URL",
  "TRUST_FORWARDED_IP_HEADERS",
  "OBSERVABILITY_PROVIDER",
  "OBSERVABILITY_PROJECT_ID",
  "OPERATIONS_ALERT_DESTINATION",
  "OPERATIONS_ESCALATION_PATH",
  "OPERATIONS_OWNER"
] as const;
const fullGitShaPattern = /^[a-f0-9]{40}$/;

try {
  const env = parseServerEnv(process.env);
  const deploymentSha = resolveDeploymentSha(process.env);
  if (env.nodeEnv === "production") {
    const invalid: string[] = requiredProductionKeys.filter((key) => !process.env[key]?.trim());
    if (!deploymentSha || !fullGitShaPattern.test(deploymentSha)) {
      invalid.push("DEPLOYMENT_SHA");
    }
    if (invalid.length > 0) {
      throw new ServerEnvError(invalid);
    }
  }
  assertProductionEnvSafe(process.env);
  console.log(
    `Predeploy environment check passed. deploymentSha=${deploymentSha ?? "unbound"} ` +
    `migrationDigest=${migrationDigest()}`
  );
} catch (error) {
  if (error instanceof ServerEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

function resolveDeploymentSha(raw: NodeJS.ProcessEnv): string | null {
  return (
    raw.DEPLOYMENT_SHA?.trim() ||
    raw.VERCEL_GIT_COMMIT_SHA?.trim() ||
    raw.GITHUB_SHA?.trim() ||
    null
  );
}

function migrationDigest(): string {
  const migrationRoot = join(process.cwd(), "prisma", "migrations");
  const migrationFiles = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(migrationRoot, entry.name, "migration.sql")
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (migrationFiles.length === 0) {
    throw new Error("No Prisma migrations found.");
  }

  const hash = createHash("sha256");
  for (const migration of migrationFiles) {
    hash.update(migration.name);
    hash.update("\0");
    hash.update(readFileSync(migration.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}
