import { defineConfig } from "@playwright/test";
import { requireDevelopmentClerk } from "./safety";

requireDevelopmentClerk();

export default defineConfig({
  testDir: ".",
  testMatch: "sdk.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  outputDir: "../../test-results/clerk-smoke",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4180",
    browserName: "chromium",
    // Tickets/session credentials must not end up in traces, videos or screenshots.
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
  },
  webServer: {
    command: "pnpm exec vite --config tests/clerk-smoke/vite.config.ts",
    url: "http://127.0.0.1:4180",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});