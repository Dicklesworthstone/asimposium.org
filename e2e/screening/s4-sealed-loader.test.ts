import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import worker from "../../apps/wire/src/index";
import {
  aggregateScreeningRun,
  type ScreeningObservation,
  type ScreeningRunIdentity,
  screenWithProvider,
} from "../../apps/wire/src/screening/index";
import {
  assertS4CorpusShape,
  createS4Corpus,
  S4_CORPUS_REVISION,
  TIER_A_HARD_REJECT_COUNT,
  TIER_B_HARD_REJECT_COUNT,
  TIER_B_HARD_REJECT_RESERVATIONS,
} from "./s4-corpus";
import {
  createFixtureScreeningProvider,
  FIXTURE_CONFIGURATION_DIGEST,
  FIXTURE_MODEL_VERSION,
  FIXTURE_POLICY_VERSION,
} from "./s4-fixture-provider";
import { runLegitimateOnlyScreening } from "./s4-legitimate-only";
import { runLiveScreening } from "./s4-runner";
import {
  fullRunScorecardJsonl,
  hashSealedCorpusFile,
  loadS4SealedCorpus,
  SealedCorpusError,
} from "./s4-sealed-loader";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SEAL_SCRIPT = resolve(REPO_ROOT, "scripts/s4-corpus-seal.ts");
const MOUNTED_BEARER = "s4-sealed-mounted-bearer-0123456789";

function createSyntheticTierBFile(
  dir: string,
  options: { mode?: number; tamperFirstByte?: boolean; canaryPrefix?: string } = {},
): { filePath: string; bodies: Map<string, string> } {
  const prefix = options.canaryPrefix ?? "SEALED_TIER_B_SYNTHETIC_CANARY";
  const bodies = new Map<string, string>();
  const lines = TIER_B_HARD_REJECT_RESERVATIONS.map(([policy_category, id, rationale], idx) => {
    const body = `${prefix}_${id}_${policy_category}_${rationale}${
      options.tamperFirstByte && idx === 0 ? "_TAMPERED" : ""
    }`;
    bodies.set(id, body);
    return JSON.stringify({
      id,
      policy_category,
      rationale,
      provenance: "synthetic-unit-test-sealed-corpus",
      body,
    });
  });
  const filePath = join(dir, "tier-b-sealed.jsonl");
  writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, options.mode ?? 0o600);
  return { filePath, bodies };
}

function createMountedWorkerAi(decide: (bodyText: string) => "pass" | "reject") {
  const calls: string[] = [];
  return {
    calls,
    async run(
      model: string,
      input?: { messages?: readonly { role?: string; content?: string }[] },
    ) {
      calls.push(model);
      const userContent = input?.messages?.find((m) => m.role === "user")?.content ?? "";
      const decision = decide(userContent);
      return {
        response: JSON.stringify({
          decision,
          coarse_category: decision === "reject" ? "operational-harm" : "benign-context",
          bands: {
            "benign-context": decision === "pass" ? "high" : "low",
            "off-topic": "low",
            "spam-commercial": "low",
            injection: "low",
            "dual-use-boundary": "low",
            "operational-harm": decision === "reject" ? "high" : "low",
            harassment: "low",
            "sexual-content": "low",
            "provider-unavailable": null,
          },
        }),
      };
    },
  };
}

describe("S-4 split adversarial corpus + sealed operator loader (asimposiumorg-rc-populate-s4-corpus-c743)", () => {
  test("POSITIVE 1: 150 legitimate + 30 Tier-A adversarial controls execute cleanly with fail-closed Tier-B reservation", async () => {
    const corpus = await createS4Corpus();
    assertS4CorpusShape(corpus);
    expect(TIER_A_HARD_REJECT_COUNT).toBe(30);
    expect(TIER_B_HARD_REJECT_COUNT).toBe(20);

    const tierA = corpus.filter(
      (example) => example.ground_truth === "hard-reject" && example.source.kind === "inline-safe",
    );
    const tierB = corpus.filter(
      (example) =>
        example.ground_truth === "hard-reject" && example.source.kind === "protected-staging",
    );
    expect(tierA).toHaveLength(30);
    expect(tierB).toHaveLength(20);
    expect(new Set(tierA.map((example) => example.body)).size).toBe(30);
    // Tier-B bodies must never live in the repository manifest.
    expect(tierB.every((example) => example.body === undefined)).toBe(true);
    // Tier-A safe excerpts must never echo violating body text.
    for (const example of tierA) {
      expect(example.safe_excerpt).not.toContain(example.body as string);
    }

    const identity: ScreeningRunIdentity = {
      corpus_revision: S4_CORPUS_REVISION,
      corpus_digest: `sha256:${"a".repeat(64)}`,
      model_version: FIXTURE_MODEL_VERSION,
      policy_version: FIXTURE_POLICY_VERSION,
      configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
    };
    const partialReport = await runLegitimateOnlyScreening({
      corpus,
      provider: createFixtureScreeningProvider({
        decide: (id) => (id.startsWith("hard-") ? "reject" : "pass"),
      }),
      identity,
      evidence_class: "fixture-not-model-evidence",
    });
    expect(partialReport.evaluated_count).toBe(180);
    expect(partialReport.reserved_count).toBe(20);
    expect(partialReport.legitimate_false_positive_rate.rate).toBe(0);
    expect(partialReport.tier_a_hard_reject_observed_count).toBe(30);
    expect(partialReport.tier_a_hard_reject_false_negative_count).toBe(0);
    expect(partialReport.injection_recall.rate).toBe(1);
    expect(partialReport.verdict).toBe("blocked");
    expect(partialReport.exit_code).toBe(78);
  });

  test("POSITIVE 2: chmod-0600 out-of-repo sealed file matching pinned SHA-256 hydrates all 200 entries, runs mounted /internal/screen, and emits a secret-free receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-sealed-positive-"));
    const canaryPrefix = "PRIVATE_SEALED_BODY_NEVER_ECHO";
    const { filePath, bodies } = createSyntheticTierBFile(dir, {
      mode: 0o600,
      canaryPrefix,
    });

    // Step A: Operator seal helper emits ONLY SHA-256 digests and zero body text.
    const sealRun = spawnSync(process.execPath, [SEAL_SCRIPT, "--hash-only", filePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(sealRun.status).toBe(0);
    expect(sealRun.stderr).toBe("");
    expect(sealRun.stdout).not.toContain(canaryPrefix);
    const sealJson = JSON.parse(sealRun.stdout.trim()) as {
      record_type: string;
      sealed_entry_count: number;
      tier_b_manifest_digest: string;
      digests: Record<string, string>;
    };
    expect(sealJson.record_type).toBe("s4-sealed-corpus-hashes");
    expect(sealJson.sealed_entry_count).toBe(20);
    expect(Object.keys(sealJson.digests)).toHaveLength(20);

    // Step B: Sealed loader hydrates all 200 entries in memory without putting Tier-B body on manifest entries.
    const hydrated = await loadS4SealedCorpus(filePath, {
      pinned_digests: sealJson.digests,
      repo_root: REPO_ROOT,
    });
    expect(hydrated.corpus).toHaveLength(200);
    expect(hydrated.resolved_bodies.size).toBe(200);
    expect(hydrated.tier_b_count).toBe(20);
    expect(JSON.stringify(hydrated.corpus)).not.toContain(canaryPrefix);

    // Step C: Live runner traverses the REAL mounted Worker `/internal/screen` route for all 200 entries.
    const tierABodies = new Set(
      hydrated.corpus
        .filter((e) => e.ground_truth === "hard-reject" && e.body !== undefined)
        .map((e) => e.body as string),
    );
    const ai = createMountedWorkerAi((userContent) => {
      if (userContent.includes(canaryPrefix)) return "reject";
      for (const body of tierABodies) {
        if (userContent.includes(body)) return "reject";
      }
      return "pass";
    });
    const env = {
      AI: ai,
      S4_SCREENING_BEARER: MOUNTED_BEARER,
    } as unknown as Parameters<typeof worker.fetch>[1];
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as Parameters<typeof worker.fetch>[2];

    const writes: string[] = [];
    await runLiveScreening({
      sealed_corpus_file: filePath,
      pinned_digests: sealJson.digests,
      repo_root: REPO_ROOT,
      screening_url: new URL("https://a-staging.asimposium.org/internal/screen"),
      bearer: MOUNTED_BEARER,
      fetch_impl: (url, init) => worker.fetch(new Request(url.toString(), init), env, ctx),
      write: (line) => writes.push(line),
    });

    expect(ai.calls).toHaveLength(200);
    expect(writes).toHaveLength(2);
    const combinedOutput = writes.join("");
    for (const secretBody of bodies.values()) {
      expect(combinedOutput).not.toContain(secretBody);
    }
    expect(combinedOutput).not.toContain(canaryPrefix);

    const opsLines = (writes[0] ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const opsRecord = opsLines.find((record) => record.record_type === "screening-aggregate");
    const scorecard = JSON.parse(writes[1] ?? "{}") as Record<string, unknown>;
    expect(opsRecord?.verdict).toBe("pass");
    expect(scorecard).toMatchObject({
      record_type: "s4-scorecard",
      scope: "full-200",
      verdict: "pass",
      evaluated_count: 200,
      reserved_count: 0,
      hard_reject_fn_count: 0,
      hard_reject_observed_count: 50,
    });
    expect((scorecard.legitimate_fp_rate as { rate: number }).rate).toBe(0);
    expect((scorecard.injection_recall as { rate: number }).rate).toBe(1);
    expect(typeof scorecard.latency_p50_ms).toBe("number");
    expect(typeof scorecard.latency_p95_ms).toBe("number");
  });

  test("SHOULD-FAIL CONTROL 1: tampering 1 byte in a sealed entry refuses with CORPUS_DIGEST_MISMATCH and zero body echo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-sealed-tamper-"));
    const canaryPrefix = "TAMPER_CANARY_MUST_NOT_LEAK";
    const { filePath } = createSyntheticTierBFile(dir, { mode: 0o600, canaryPrefix });
    const pinned = await hashSealedCorpusFile(filePath, { repo_root: REPO_ROOT });

    // Overwrite entry 1 with a 1-byte tamper
    const tampered = createSyntheticTierBFile(dir, {
      mode: 0o600,
      tamperFirstByte: true,
      canaryPrefix,
    });

    let caught: unknown;
    try {
      await loadS4SealedCorpus(tampered.filePath, {
        pinned_digests: pinned.digests,
        repo_root: REPO_ROOT,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SealedCorpusError);
    expect((caught as SealedCorpusError).code).toBe("CORPUS_DIGEST_MISMATCH");
    expect(String(caught)).not.toContain(canaryPrefix);
  });

  test("SHOULD-FAIL CONTROL 2: a mock screener missing 1 hard-reject entry (FN = 1 > 0) FAILS the scorecard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-sealed-fn-"));
    const { filePath } = createSyntheticTierBFile(dir, { mode: 0o600 });
    const pinned = await hashSealedCorpusFile(filePath, { repo_root: REPO_ROOT });
    const hydrated = await loadS4SealedCorpus(filePath, {
      pinned_digests: pinned.digests,
      repo_root: REPO_ROOT,
    });

    const identity: ScreeningRunIdentity = {
      ...hydrated.corpus_identity,
      model_version: FIXTURE_MODEL_VERSION,
      policy_version: FIXTURE_POLICY_VERSION,
      configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
    };
    const provider = createFixtureScreeningProvider({
      // Miss exactly one Tier-B hard-reject entry (`hard-031`) -> FN = 1 > 0
      decide: (exampleId) =>
        exampleId.startsWith("hard-") && exampleId !== "hard-031" ? "reject" : "pass",
    });
    const observations: ScreeningObservation[] = await Promise.all(
      hydrated.corpus.map((example) =>
        screenWithProvider(
          provider,
          {
            example_id: example.id,
            body_digest: example.body_digest as string,
            context_digest: example.body_digest as string,
            identity,
          },
          { timeout_ms: 1_000 },
        ),
      ),
    );
    const report = aggregateScreeningRun(hydrated.corpus, observations, identity);
    expect(report.verdict).toBe("fail");
    expect(report.hard_reject_false_negative_rate.numerator).toBe(1);
    expect(report.failures).toContain("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");

    const scorecard = JSON.parse(
      fullRunScorecardJsonl(hydrated.corpus, observations, report, "fixture-not-model-evidence"),
    ) as Record<string, unknown>;
    expect(scorecard.verdict).toBe("fail");
    expect(scorecard.hard_reject_fn_count).toBe(1);

    // Also verify partial Tier-A misses fail immediately (exit 1, not exit 78).
    const baseCorpus = await createS4Corpus();
    const partialMissedTierA = await runLegitimateOnlyScreening({
      corpus: baseCorpus,
      provider: createFixtureScreeningProvider({
        decide: (id) => (id.startsWith("hard-") && id !== "hard-011" ? "reject" : "pass"),
      }),
      identity: {
        corpus_revision: S4_CORPUS_REVISION,
        corpus_digest: `sha256:${"b".repeat(64)}`,
        model_version: FIXTURE_MODEL_VERSION,
        policy_version: FIXTURE_POLICY_VERSION,
        configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
      },
      evidence_class: "fixture-not-model-evidence",
    });
    expect(partialMissedTierA.verdict).toBe("fail");
    expect(partialMissedTierA.exit_code).toBe(1);
    expect(partialMissedTierA.tier_a_hard_reject_false_negative_count).toBe(1);
    expect(partialMissedTierA.failures).toContain("HARD_REJECT_FALSE_NEGATIVE_THRESHOLD_FAILED");
  });

  test("SHOULD-FAIL CONTROL 3: a mock screener flagging 8/150 legitimate math posts (FP = 5.33% >= 5%) FAILS the scorecard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-sealed-fp-"));
    const { filePath } = createSyntheticTierBFile(dir, { mode: 0o600 });
    const pinned = await hashSealedCorpusFile(filePath, { repo_root: REPO_ROOT });
    const hydrated = await loadS4SealedCorpus(filePath, {
      pinned_digests: pinned.digests,
      repo_root: REPO_ROOT,
    });

    const identity: ScreeningRunIdentity = {
      ...hydrated.corpus_identity,
      model_version: FIXTURE_MODEL_VERSION,
      policy_version: FIXTURE_POLICY_VERSION,
      configuration_digest: FIXTURE_CONFIGURATION_DIGEST,
    };
    const falsePositives = new Set([
      "legit-002",
      "legit-003",
      "legit-004",
      "legit-005",
      "legit-006",
      "legit-007",
      "legit-008",
      "legit-009",
    ]);
    const provider = createFixtureScreeningProvider({
      decide: (exampleId) =>
        exampleId.startsWith("hard-") || falsePositives.has(exampleId) ? "reject" : "pass",
    });
    const observations: ScreeningObservation[] = await Promise.all(
      hydrated.corpus.map((example) =>
        screenWithProvider(
          provider,
          {
            example_id: example.id,
            body_digest: example.body_digest as string,
            context_digest: example.body_digest as string,
            identity,
          },
          { timeout_ms: 1_000 },
        ),
      ),
    );
    const report = aggregateScreeningRun(hydrated.corpus, observations, identity);
    expect(report.verdict).toBe("fail");
    expect(report.legitimate_false_positive_rate.numerator).toBe(8);
    expect(report.legitimate_false_positive_rate.denominator).toBe(150);
    expect(report.failures).toContain("LEGITIMATE_FALSE_POSITIVE_THRESHOLD_FAILED");
  });

  test("SHOULD-FAIL CONTROL 4: group/world-readable (0644) sealed file is refused BEFORE reading, and symlinks / in-repo files are refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-sealed-perms-"));
    // Deliberately write invalid JSONL with 0644 perms: permission check must
    // fire BEFORE parsing or reading the file!
    const badPermPath = join(dir, "world-readable.jsonl");
    writeFileSync(badPermPath, "NOT EVEN VALID JSONL — MUST NEVER BE READ\n", { mode: 0o644 });
    chmodSync(badPermPath, 0o644);

    await expect(loadS4SealedCorpus(badPermPath, { repo_root: REPO_ROOT })).rejects.toMatchObject({
      code: "SEALED_CORPUS_INSECURE_PERMISSIONS",
    });
    await expect(hashSealedCorpusFile(badPermPath, { repo_root: REPO_ROOT })).rejects.toMatchObject(
      { code: "SEALED_CORPUS_INSECURE_PERMISSIONS" },
    );

    // Symlink to a valid 0600 file must also be refused before reading.
    const { filePath } = createSyntheticTierBFile(dir, { mode: 0o600 });
    const symlinkPath = join(dir, "symlink-to-sealed.jsonl");
    symlinkSync(filePath, symlinkPath);
    await expect(hashSealedCorpusFile(symlinkPath, { repo_root: REPO_ROOT })).rejects.toMatchObject(
      { code: "SEALED_CORPUS_NOT_REGULAR_FILE" },
    );

    // File inside the repository root must be refused (test via fake repo_root = dir).
    await expect(hashSealedCorpusFile(filePath, { repo_root: dir })).rejects.toMatchObject({
      code: "SEALED_CORPUS_INSIDE_REPO",
    });
  });
});
