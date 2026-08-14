import { defineConfig } from "@playwright/test";

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
