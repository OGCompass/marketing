import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  outputDir: "../../test-results/access",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config tests/access/vite.config.ts",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});