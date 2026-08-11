import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const predeployScript = join(root, "scripts", "predeploy-check.ts");
const ciWorkflowPath = join(root, ".github", "workflows", "ci.yml");

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

  it("rejects a missing APP_ORIGIN from the production predeploy fixture", () => {
    // Given
    const result = runPredeploy({ ...productionEnv(), APP_ORIGIN: "" });

    // When / Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APP_ORIGIN");
  });

  it("runs the predeploy check from the Vercel build command", () => {
    // Given
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    // When / Then
    expect(packageJson.scripts["vercel-build"]).toContain("npm run predeploy:check");
  });

  it("supplies an HTTPS application origin to the CI quality fixture", () => {
    // Given
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    // When / Then
    expect(workflow).toMatch(/quality:\n[\s\S]*?APP_ORIGIN: https:\/\/example\.test/);
  });

  it("keeps migration connections administrative and runs integration tests as the runtime role", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const postgresJob = workflow.match(
      /^  postgres-integration:\n(?<job>[\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n|(?![\s\S]))/mu
    )?.groups?.job;

    expect(postgresJob).toBeDefined();

    const databaseUrl = postgresJob?.match(/^      DATABASE_URL: (?<url>\S+)$/mu)?.groups?.url;
    const directUrl = postgresJob?.match(/^      DIRECT_URL: (?<url>\S+)$/mu)?.groups?.url;
    const migrationStepIndex = postgresJob?.indexOf("- run: npx prisma migrate deploy") ?? -1;
    const roleStepIndex = postgresJob?.indexOf("- name: Configure CI runtime role") ?? -1;
    const integrationStepIndex = postgresJob?.indexOf("- name: Run integration tests as runtime role") ?? -1;
    const configuredPassword = postgresJob?.match(
      /ALTER ROLE info_room_runtime WITH LOGIN PASSWORD '(?<password>[^']+)'/mu
    )?.groups?.password;
    const integrationUrl = postgresJob?.match(
      /- name: Run integration tests as runtime role\n[\s\S]*?^          INTEGRATION_DATABASE_URL: (?<url>\S+)$/mu
    )?.groups?.url;
    const adminDatabase = new URL(databaseUrl ?? "invalid:");
    const adminDirect = new URL(directUrl ?? "invalid:");
    const integrationDatabase = new URL(integrationUrl ?? "invalid:");

    expect(adminDatabase.username).toBe("postgres");
    expect(adminDirect.username).toBe("postgres");
    expect(migrationStepIndex).toBeGreaterThanOrEqual(0);
    expect(postgresJob).toMatch(
      /^      - run: npx prisma migrate deploy\n(?=      - name: Configure CI runtime role)/mu
    );
    expect(roleStepIndex).toBeGreaterThan(migrationStepIndex);
    expect(postgresJob).toMatch(
      /- name: Configure CI runtime role\n[\s\S]*?psql "\$DATABASE_URL"[\s\S]*?ALTER ROLE info_room_runtime WITH LOGIN PASSWORD/mu
    );
    expect(integrationStepIndex).toBeGreaterThan(roleStepIndex);
    expect(integrationDatabase.username).toBe("info_room_runtime");
    expect(integrationDatabase.username).not.toBe("postgres");
    expect(integrationDatabase.password).toBe(configuredPassword);
    expect(integrationDatabase.host).toBe(adminDatabase.host);
    expect(integrationDatabase.pathname).toBe(adminDatabase.pathname);
    expect(postgresJob).toMatch(
      /- name: Run integration tests as runtime role\n\s+run: npm run test:integration\n/mu
    );
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
    APP_ORIGIN: "https://example.test",
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
