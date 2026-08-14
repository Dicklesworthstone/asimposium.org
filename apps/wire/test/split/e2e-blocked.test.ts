import { expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * This tests the honesty of the E2E gate, not an E2E result.  In particular,
 * an exit 78 is evidence of a named missing integration surface, never proof
 * that S-3 has exercised a Worker, D1, R2, browser, or staging deployment.
 */
test("the mock-free S-3 E2E command stays explicitly blocked with safe diagnostics", async () => {
  const root = resolve(import.meta.dir, "../../../..");
  const child = Bun.spawn({
    cmd: ["bash", "scripts/e2e-s3-split.sh"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const record = JSON.parse(stdout) as Record<string, unknown>;

  expect(exitCode).toBe(78);
  expect(record).toMatchObject({
    tool: "bash",
    package: "@asimposium/wire",
    suite: "e2e-s3-split",
    status: "blocked",
    exit_code: 78,
    code: "SPLIT_E2E_BLOCKED",
    reproduce: "bash scripts/e2e-s3-split.sh",
  });
  expect(String(record.blocked_on)).toContain("D1 and R2 migrations");
  expect(String(record.forbidden_substitutes)).toContain("mocked or stubbed D1/R2");
  expect(stderr).toContain("BLOCKED e2e-s3-split");
  expect(`${stdout}\n${stderr}`).not.toContain(root);
  expect(`${stdout}\n${stderr}`).not.toContain("/Users/");
  expect(`${stdout}\n${stderr}`).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
});
