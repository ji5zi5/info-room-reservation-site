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
    expect(read("vitest.config.ts")).toContain('include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]');
    expect(read("vitest.config.ts")).toContain("maxWorkers: 4");
    expect(exists("vitest.integration.config.ts")).toBe(true);
    expect(exists("scripts/run-integration-tests.mjs")).toBe(true);
    expect(exists("scripts/verify-readiness-receipts.mjs")).toBe(true);
  });

  it("runs the portable owned-database operational gate from a tracked-only checkout", () => {
    const workflow = read(".github/workflows/ci.yml");
    const verifier = read("scripts/verify-operational-fomo-evidence.mjs");

    expect(workflow).toMatch(/permissions:\r?\n  contents: read/u);
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toMatch(/actions\/checkout@v6\r?\n\s+with:\r?\n\s+fetch-depth: 0/u);
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).not.toContain("actions/checkout@v4");
    expect(workflow).not.toContain("actions/setup-node@v4");
    expect(workflow).not.toMatch(/^\s+services:/mu);
    expect(workflow).toContain("npm run qa:operational:core -- --phase full --ci");
    expect(verifier).toContain('await import("./operational-fomo-harness.mjs")');
    expect(verifier).toContain('["prisma", "migrate", "deploy"]');
    expect(verifier).toContain('"test:integration"');
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

  it("runs one explicit-server Chromium operational smoke", () => {
    const workflow = read(".github/workflows/ci.yml");
    const playwrightConfig = read("playwright.config.ts");

    expect(playwrightConfig).toContain("process.env.E2E_BASE_URL");
    expect(playwrightConfig).not.toContain("webServer:");
    expect(workflow).toContain("npx playwright install --with-deps chromium");
    expect(workflow).toContain("EVIDENCE_DIR: ${{ runner.temp }}/operational-fomo-browser-evidence");
    expect(workflow).toContain("npm run qa:operational:core -- --phase full --ci");
    expect(exists("tests/production-smoke.spec.ts")).toBe(true);
  });
});

function exists(path: string): boolean {
  return existsSync(join(root, path));
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}
