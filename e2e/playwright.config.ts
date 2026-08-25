import { defineConfig } from "@playwright/test";

if (process.env.ASIMPOSIUM_PLAYWRIGHT_ENTRY !== "1") {
  throw new Error(
    "Use e2e/run-playwright.sh so the Playwright staging preflight cannot be bypassed.",
  );
}

const artifactDirectory = process.env.ASIMPOSIUM_PLAYWRIGHT_ARTIFACT_DIRECTORY;
if (
  artifactDirectory === undefined ||
  !/^artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/playwright$/.test(artifactDirectory)
) {
  throw new Error(
    "The Playwright entry point must provide one claimed, run-scoped artifact directory.",
  );
}

export default defineConfig({
  testDir: "./playwright",
  timeout: 20_000,
  forbidOnly: true,
  retries: 0,
  reporter: [["line"]],
  outputDir: artifactDirectory,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
