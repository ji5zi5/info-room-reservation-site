import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = process.cwd();

describe("production CI contract", () => {
  it("defines bounded unit and guarded PostgreSQL integration commands", () => {
    const packageJson = z.object({
      scripts: z.record(z.string(), z.string())
    }).parse(JSON.parse(read("package.json")));

    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["test:integration"]).toBe("node scripts/run-integration-tests.mjs");
    expect(packageJson.scripts["verify:receipts"]).toBe("node scripts/verify-readiness-receipts.mjs");
    expect(read("vitest.config.ts")).toContain("maxWorkers: 4");
    expect(exists("vitest.integration.config.ts")).toBe(true);
    expect(exists("scripts/run-integration-tests.mjs")).toBe(true);
    expect(exists("scripts/verify-readiness-receipts.mjs")).toBe(true);
  });

  it("runs clean migrations and real database scenarios in Postgres 16", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).not.toContain("actions/checkout@v4");
    expect(workflow).not.toContain("actions/setup-node@v4");
    expect(workflow).toContain("image: postgres:16");
    expect(workflow).toContain("npx prisma migrate deploy");
    expect(workflow).toContain("npm run test:integration");
    expect(workflow).toContain("INTEGRATION_DATABASE_URL:");
  });

  it("keeps every Prisma migration free of a UTF-8 byte-order mark", () => {
    const migrationRoot = join(root, "prisma", "migrations");
    const migrationFiles = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(migrationRoot, entry.name, "migration.sql"))
      .filter(existsSync);

    expect(migrationFiles).not.toHaveLength(0);
    for (const migrationFile of migrationFiles) {
      expect(readFileSync(migrationFile).subarray(0, 3), migrationFile)
        .not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    }
  });

  it("runs one explicit-server Chromium production smoke", () => {
    const workflow = read(".github/workflows/ci.yml");
    const playwrightConfig = read("playwright.config.ts");

    expect(playwrightConfig).toContain("process.env.E2E_BASE_URL");
    expect(playwrightConfig).not.toContain("webServer:");
    expect(workflow).toContain("npx playwright install --with-deps chromium");
    expect(workflow).toContain("E2E_BASE_URL: http://127.0.0.1:3100");
    expect(workflow).toContain("tests/production-smoke.spec.ts");
    expect(exists("tests/production-smoke.spec.ts")).toBe(true);
  });
});

function exists(path: string): boolean {
  return existsSync(join(root, path));
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}
