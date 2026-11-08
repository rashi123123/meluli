import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  // Native focus, shortcuts and audio devices are shared across Electron apps.
  workers: 1,
  // Electron occasionally misses its first window on a cold CI runner; one retry
  // keeps that from failing a release, and the report still marks it flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    trace: "retain-on-failure"
  }
});
