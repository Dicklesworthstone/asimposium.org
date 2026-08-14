import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");

test("the S-3 harness binds readiness to its child and bounds every checker request", () => {
  const script = readFileSync(resolve(root, "scripts/e2e-s3-split.sh"), "utf8");
  const worker = readFileSync(resolve(root, "apps/wire/src/split/local-worker.ts"), "utf8");
  const checker = readFileSync(resolve(root, "apps/wire/src/split/local-check.ts"), "utf8");

  expect(script).toContain("S3_PORT_OCCUPIED");
  expect(script).toMatch(/--var "S3_RUN_TOKEN:\$\{S3_RUN_TOKEN\}"/);
  expect(script).toMatch(/health.*run_token.*S3_RUN_TOKEN/s);
  expect(script).toContain("CHECKER_DEADLINE_SECONDS");
  expect(worker).toContain("run_token: env.S3_RUN_TOKEN");
  expect(checker).toContain("S3_LOCAL_ORIGIN_MUST_BE_LOOPBACK");
  expect(checker).toContain("AbortSignal.timeout(FETCH_TIMEOUT_MS)");
});

test(
  "PLANTED: an occupied pinned port is refused before foreign readiness can be borrowed",
  async () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('{"status":"ok"}\n'),
    });
    try {
      const child = Bun.spawn({
        cmd: ["bash", "scripts/e2e-s3-split.sh"],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          S3_PORT: String(listener.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('"code":"S3_PORT_OCCUPIED"');
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"pass"');
    } finally {
      listener.stop(true);
    }
  },
  { timeout: 10_000 },
);

/**
 * The command must positively exercise local workerd D1/R2 and renderer
 * boundaries before honestly blocking staging-only identity/browser proof.
 */
test(
  "the S-3 command proves local bindings and blocks only staging proof",
  async () => {
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
    const records = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const local = records.find(
      (record) => record.suite === "s3-local-bindings" && record.status === "pass",
    );
    const staging = records.find((record) => record.suite === "s3-staging-paired-principal");
    const assertions = records.filter(
      (record) =>
        record.suite === "e2e-s3-split-local" &&
        typeof record.assertion === "string" &&
        record.assertion !== "local_binding_summary",
    );

    expect(exitCode).toBe(78);
    expect(local).toMatchObject({
      tool: "wrangler+bun",
      package: "@asimposium/wire",
      suite: "s3-local-bindings",
      status: "pass",
      bindings: { d1: "DB", r2: "ARTIFACTS" },
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(staging).toMatchObject({
      tool: "wrangler",
      package: "@asimposium/wire",
      suite: "s3-staging-paired-principal",
      status: "blocked",
      exit_code: 78,
      code: "S3_STAGING_ENVIRONMENT_ABSENT",
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(String(staging?.blocked_on)).toContain("paired sponsor plus anonymous browser proof");
    expect(String(staging?.forbidden_substitutes)).toContain("local-workerd behavior");
    expect(assertions).toHaveLength(34);
    expect(assertions.every((record) => record.status === "pass")).toBe(true);
    for (const assertion of [
      "caller_cannot_choose_a_workshop_identifier",
      "caller_cannot_choose_a_claim_identifier",
      "staged_private_digest_is_not_publicly_readable_before_promotion",
      "only_the_explicitly_published_public_artifact_is_readable_after_complete_D1_binding",
      "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
      "concurrent_workshop_pushes_use_D1_RETURNING_sequences_without_duplicates_or_burns",
      "concurrent_promotions_allocate_server_claim_ids_and_D1_RETURNING_public_sequences_without_burns",
      "every_empty_pre_promotion_face_validator_changes_after_the_public_event",
      "public_errors_search_and_export_never_reflect_private_probe_material",
      "post_promotion_public_search_and_export_contain_only_the_public_event",
    ]) {
      expect(
        assertions.some((record) => record.assertion === assertion && record.status === "pass"),
      ).toBe(true);
    }
    expect(stderr).toContain("BLOCKED s3-staging-paired-principal");
    expect(`${stdout}\n${stderr}`).not.toContain(root);
    expect(`${stdout}\n${stderr}`).not.toContain("/Users/");
    expect(`${stdout}\n${stderr}`).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
  },
  { timeout: 20_000 },
);
