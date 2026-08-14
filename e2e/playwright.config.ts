import { defineConfig } from "@playwright/test";

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY !== "1") {
  throw new Error("Use e2e/run-playwright.sh so the Playwright staging preflight cannot be bypassed.");
}

export default defineConfig({
  testDir: "./playwright",
  timeout: 20_000,
  forbidOnly: true,
  retries: 0,
  reporter: [["line"]],
  outputDir: "artifacts/playwright",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
