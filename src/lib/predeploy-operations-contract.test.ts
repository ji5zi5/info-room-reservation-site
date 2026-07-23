import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const predeployScript = join(root, "scripts", "predeploy-check.ts");

const operationalKeys = [
  "OBSERVABILITY_PROVIDER",
  "OBSERVABILITY_PROJECT_ID",
  "OPERATIONS_ALERT_DESTINATION",
  "OPERATIONS_ESCALATION_PATH",
  "OPERATIONS_OWNER"
] as const;

describe("production predeploy operations contract", () => {
  it("prints immutable deployment and migration provenance for a complete production fixture", () => {
    const result = runPredeploy(productionEnv());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/deploymentSha=[a-f0-9]{40}/);
    expect(result.stdout).toMatch(/migrationDigest=[a-f0-9]{64}/);
  });

  it.each(operationalKeys)("rejects missing %s", (key) => {
    const result = runPredeploy({ ...productionEnv(), [key]: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(key);
  });

  it("rejects a non-immutable deployment SHA", () => {
    const result = runPredeploy({ ...productionEnv(), DEPLOYMENT_SHA: "main" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOYMENT_SHA");
  });
});

function productionEnv(): NodeJS.ProcessEnv {
  return {
    ADMIN_STUDENT_NUMBERS: "99999",
    CLOSED_PERIOD_CRON_SECRET: "closed-period-secret-with-enough-length",
    DATABASE_URL: "postgresql://user:pass@example.test:6543/info_room",
    DEPLOYMENT_SHA: "a".repeat(40),
    DIRECT_URL: "postgresql://user:pass@example.test:5432/info_room",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
    MAINTENANCE_CRON_SECRET: "maintenance-secret-with-enough-length",
    NODE_ENV: "production",
    OBSERVABILITY_PROJECT_ID: "info-room-production",
    OBSERVABILITY_PROVIDER: "example-monitoring",
    OPERATIONS_ALERT_DESTINATION: "school-operations",
    OPERATIONS_ESCALATION_PATH: "owner-then-school-it",
    OPERATIONS_OWNER: "information-room-owner",
    RETENTION_PURGE_ENABLED: "false",
    RIRO_MOCK_LOGIN: "false",
    SESSION_SECRET: "session-secret-with-enough-length",
    TRUST_FORWARDED_IP_HEADERS: "true"
  };
}

function runPredeploy(overrides: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, predeployScript], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...overrides }
  });
}
