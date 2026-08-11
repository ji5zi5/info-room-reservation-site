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
const discordApplicationKeys = [
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_CHANNEL_ID",
  "DISCORD_ADMIN_ROLE_ID",
  "DISCORD_ADMIN_USER_MAP"
] as const;

describe("production predeploy operations contract", () => {
  it("prints immutable deployment and migration provenance for a complete production fixture", () => {
    const result = runPredeploy(productionEnv());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("discordApplication=webhook-only");
    expect(result.stdout).toMatch(/deploymentSha=[a-f0-9]{40}/);
    expect(result.stdout).toMatch(/migrationDigest=[a-f0-9]{64}/);
  });

  it("accepts a complete optional Discord application group in production", () => {
    const result = runPredeploy({
      ...productionEnv(),
      DISCORD_ADMIN_ROLE_ID: "623456789012345678",
      DISCORD_ADMIN_USER_MAP: "723456789012345678:31001",
      DISCORD_APPLICATION_ID: "123456789012345678",
      DISCORD_BOT_TOKEN: "fixture-token",
      DISCORD_CHANNEL_ID: "223456789012345678",
      DISCORD_GUILD_ID: "323456789012345678",
      DISCORD_PUBLIC_KEY: "a".repeat(64)
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("discordApplication=enabled");
  });

  it.each(discordApplicationKeys)("rejects a partial Discord application group missing %s", (missingKey) => {
    const appEnv = {
      DISCORD_ADMIN_ROLE_ID: "623456789012345678",
      DISCORD_ADMIN_USER_MAP: "723456789012345678:31001",
      DISCORD_APPLICATION_ID: "123456789012345678",
      DISCORD_BOT_TOKEN: "fixture-token",
      DISCORD_CHANNEL_ID: "223456789012345678",
      DISCORD_GUILD_ID: "323456789012345678",
      DISCORD_PUBLIC_KEY: "a".repeat(64)
    };
    const result = runPredeploy({ ...productionEnv(), ...appEnv, [missingKey]: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missingKey);
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

describe("Discord interaction operator tooling", () => {
  it.each(["verify-signature", "render-messages", "render-snapshots", "authorize-matrix"])(
    "emits a passing machine-readable %s fixture",
    (command) => {
      const result = spawnSync(process.execPath, [tsxCli, join(root, "scripts", "discord-interaction-fixture.ts"), command], {
        cwd: root,
        encoding: "utf8"
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ command, ok: true });
    }
  );

  it("refuses full smoke mode without an explicitly safe test database", () => {
    const env = { ...process.env };
    delete env.INTEGRATION_DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      [tsxCli, join(root, "scripts", "discord-interaction-smoke.ts"), "--mode", "full", "--port", "3218"],
      { cwd: root, encoding: "utf8", env }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback PostgreSQL database whose name ends with _test");
  });

  it.each([
    "postgresql://fixture:fixture@example.test/info_room_test",
    "postgresql://fixture:fixture@127.0.0.1/info_room"
  ])("refuses full smoke mode for unsafe database %s", (databaseUrl) => {
    const result = spawnSync(
      process.execPath,
      [tsxCli, join(root, "scripts", "discord-interaction-smoke.ts"), "--mode", "full", "--port", "3218"],
      { cwd: root, encoding: "utf8", env: { ...process.env, INTEGRATION_DATABASE_URL: databaseUrl } }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback PostgreSQL database whose name ends with _test");
  });

  it("exposes the documented operator commands through package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(packageJson.scripts["discord:verify-setup"]).toContain("scripts/verify-discord-setup.ts");
    expect(packageJson.scripts["discord:disable-pending"]).toContain("scripts/disable-discord-pending.ts");
    expect(packageJson.scripts["discord:fixture"]).toContain("scripts/discord-interaction-fixture.ts");
    expect(packageJson.scripts["discord:smoke"]).toContain("scripts/discord-interaction-smoke.ts");
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
  const env = { ...process.env };
  for (const key of discordApplicationKeys) delete env[key];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [tsxCli, predeployScript], {
    cwd: root,
    encoding: "utf8",
    env
  });
}
