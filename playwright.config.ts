import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  // Native focus, shortcuts and audio devices are shared across Electron apps.
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure"
  }
});
