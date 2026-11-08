import { defineConfig } from "@playwright/test";

// Idle resource scenarios. Run alone, with no builds or other heavy work on the Mac:
//   MELULI_PERF_OUT=.build/perf/<name> pnpm exec playwright test -c playwright.perf.config.ts
export default defineConfig({
  testDir: "./tests/perf",
  timeout: 30 * 60_000,
  workers: 1,
  reporter: "list"
});
