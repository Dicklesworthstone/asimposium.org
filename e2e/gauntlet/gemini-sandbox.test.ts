import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GEMINI_SANDBOX_ENTERED, geminiSandboxLaunch } from "./gemini-sandbox.mjs";

const run = promisify(execFile);
const testKey = "synthetic-local-transport-test-key";

test("Gemini preflight blocks without an explicit provider credential", () => {
  expect(geminiSandboxLaunch(["--version"], {})).toEqual({ unavailable: "auth" });
  expect(geminiSandboxLaunch(["--version"], { GEMINI_API_KEY: " " })).toEqual({
    unavailable: "auth",
  });
});

// This path deliberately requires a real Bubblewrap/user-cgroup host. The
// synthetic process exercises Linux persistence and the loopback transport.
test.skipIf(process.env.ASIMPOSIUM_GAUNTLET_GEMINI_KERNEL_TEST !== "1")(
  "Gemini's real launcher confines file writes and opens a fresh sandbox each time",
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), "asimp-gemini-boundary-"));
    const installation = join(fixture, "gemini-cli");
    const outside = join(fixture, "outside-canary");
    mkdirSync(join(installation, "bundle"), { recursive: true });
    writeFileSync(
      join(installation, "package.json"),
      JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "bundle/gemini.js" } }),
    );
    writeFileSync(
      join(installation, "bundle", "gemini.js"),
      `const { existsSync, statSync, statfsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [mode, outside, url] = process.argv.slice(2);
const names = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "TMPDIR"];
const paths = [process.cwd(), ...names.map(name => process.env[name])];
const files = paths.map(path => join(path, "session-canary"));
function rejects(path) {
  try { writeFileSync(path, "synthetic-canary", { flag: "wx" }); }
  catch (error) { return ["EROFS", "ENOENT", "EACCES"].includes(error.code); }
  return false;
}
(async () => {
  const empty = files.every(path => !existsSync(path));
  if (mode === "seed") for (const path of files) writeFileSync(path, "synthetic-canary");
  const response = await fetch(url, { headers: { "user-agent": "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)" } });
  console.log(JSON.stringify({
    empty,
    privateMode: paths.every(path => (statSync(path).mode & 0o777) === 0o700),
    onTmpfs: paths.every(path => statfsSync(path).type === 0x01021994),
    insideWritable: mode !== "seed" || files.every(path => existsSync(path)),
    outsideRefused: rejects(outside),
    installationRefused: rejects("/opt/gemini/bundle/install-canary"),
    repoAbsent: !existsSync("/data/projects/asimposium.org"),
    parentEnvironmentAbsent: process.env.HOST_ONLY_CANARY === undefined && process.env.DBUS_SESSION_BUS_ADDRESS === undefined,
    providerCredentialPresent: typeof process.env.GEMINI_API_KEY === "string",
    loopback: response.ok
  }));
})().catch(() => { process.exitCode = 1; });`,
    );

    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      for (const mode of ["seed", "fresh"]) {
        const launch = geminiSandboxLaunch([mode, outside, http.url.href], {
          ASIMPOSIUM_GAUNTLET_GEMINI_PACKAGE: installation,
          GEMINI_API_KEY: testKey,
          HOST_ONLY_CANARY: "synthetic-parent-environment",
        });
        assert(!("unavailable" in launch), "a real no-swap kernel boundary is required");
        expect(launch.argv.join(" ")).not.toContain(testKey);
        const result = await run(launch.binary, launch.argv, {
          env: launch.env,
          cwd: "/",
          timeout: 10_000,
        });
        expect(result.stderr.split("\n")).toContain(GEMINI_SANDBOX_ENTERED);
        expect(JSON.parse(result.stdout)).toEqual({
          empty: true,
          privateMode: true,
          onTmpfs: true,
          insideWritable: true,
          outsideRefused: true,
          installationRefused: true,
          repoAbsent: true,
          parentEnvironmentAbsent: true,
          providerCredentialPresent: true,
          loopback: true,
        });
      }
      const withoutSwapLimit = geminiSandboxLaunch(["seed", outside, http.url.href], {
        ASIMPOSIUM_GAUNTLET_GEMINI_PACKAGE: installation,
        GEMINI_API_KEY: testKey,
      });
      assert(!("unavailable" in withoutSwapLimit));
      const args = withoutSwapLimit.argv.map((arg) =>
        arg === "--property=MemorySwapMax=0" ? "--property=MemorySwapMax=infinity" : arg,
      );
      await expect(
        run(withoutSwapLimit.binary, args, {
          env: withoutSwapLimit.env,
          cwd: "/",
          timeout: 10_000,
        }),
      ).rejects.toMatchObject({ code: 1, stdout: "", stderr: "" });
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(installation, "bundle", "install-canary"))).toBe(false);
    } finally {
      await http.stop(true);
    }
  },
);
