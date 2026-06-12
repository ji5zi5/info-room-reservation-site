import { defineConfig, devices } from "@playwright/test";

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
    trace: "on-first-retry"
  }
});
