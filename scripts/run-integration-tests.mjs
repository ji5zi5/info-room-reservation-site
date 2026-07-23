import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("INTEGRATION_DATABASE_URL is required for PostgreSQL integration tests.");
}

const parsed = new URL(databaseUrl);
if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
  throw new Error("INTEGRATION_DATABASE_URL must use PostgreSQL.");
}
if (!parsed.pathname.replace(/^\//u, "").endsWith("_test")) {
  throw new Error("Integration database name must end with _test.");
}
if (
  process.env.CI !== "true" &&
  parsed.hostname !== "localhost" &&
  parsed.hostname !== "127.0.0.1" &&
  parsed.hostname !== "::1"
) {
  throw new Error("Non-CI integration tests require a loopback PostgreSQL host.");
}

const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [vitestCli, "run", "--config", "vitest.integration.config.ts"], {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    NODE_ENV: "test"
  },
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
