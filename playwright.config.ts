import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL?.trim();
if (!baseURL) {
  throw new Error("E2E_BASE_URL is required. Start the target server explicitly before Playwright.");
}
const protocol = new URL(baseURL).protocol;
if (protocol !== "http:" && protocol !== "https:") {
  throw new Error("E2E_BASE_URL must use HTTP or HTTPS.");
}

export default defineConfig({
  expect: {
    timeout: 5_000
  },
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"]
    }
  ],
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  workers: 1
});
