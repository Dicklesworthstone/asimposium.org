import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import worker from "../../apps/wire/src/index";
import type {
  ScreeningCorpusExample,
  ScreeningObservation,
  ScreeningRunIdentity,
} from "../../apps/wire/src/screening";
import { WORKERS_AI_MODEL } from "../../apps/wire/src/screening/workers-ai";
import {
  assertS4CorpusShape,
  assertS4ManifestReadyForLiveRun,
  createS4Corpus,
  deriveS4EvaluatedCorpusIdentity,
  inspectS4ManifestReadiness,
} from "./s4-corpus";
import {
  cleanupBoundedResponseReader,
  fetchBoundedLiveJson,
  runIndependentLivePhases,
  runLiveScreening,
  s4TerminalDiagnostic,
} from "./s4-runner";

const root = resolve(import.meta.dir, "../..");
const STAGING_CONFIGURATION_DIGEST = `sha256:${"f".repeat(64)}`;
const MOUNTED_SCREENING_BEARER = "s4-mounted-runner-bearer-0123456789";

function runCaptured(args: string[], env: Record<string, string> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "s4-runner-test-"));
  const stdoutPath = join(logDir, "stdout.log");
  const stderrPath = join(logDir, "stderr.log");
  const child = spawnSync(
    "bash",
    [
      "-c",
      'stdout_path="$1"; stderr_path="$2"; shift 2; exec "$@" >>"$stdout_path" 2>>"$stderr_path"',
      "s4-log-runner",
      stdoutPath,
      stderrPath,
      process.execPath,
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 10000,
    },
  );
  return {
    exitCode: child.status ?? 1,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
  };
}

function scoreBands(): ScreeningObservation["category_score_bands"] {
  return {
    "benign-context": undefined,
    "spam-commercial": undefined,
    injection: undefined,
    "dual-use-boundary": undefined,
    "operational-harm": undefined,
    harassment: undefined,
    "sexual-content": undefined,
    "provider-unavailable": undefined,
  };
}

function validObservations(
  corpus: readonly ScreeningCorpusExample[],
  identity: ScreeningRunIdentity,
): ScreeningObservation[] {
  return corpus.map((example) => ({
    example_id: example.id,
    evaluated_body_digest: example.body_digest as string,
    decision: example.ground_truth === "hard-reject" ? "reject" : "pass",
    coarse_category:
      example.ground_truth === "hard-reject" ? example.policy_category : "benign-context",
    category_score_bands: scoreBands(),
    model_version: identity.model_version,
    policy_version: identity.policy_version,
    configuration_digest: identity.configuration_digest,
    provider_status: "ok",
    decision_path: "provider",
    status_code: "SCREENED",
    latency_ms: 1,
    retry_count: 0,
  }));
}

/** Contract stub only: it proves mounted routing, never screening accuracy. */
function mountedContractAi() {
  const calls: string[] = [];
  return {
    calls,
    async run(model: string) {
      calls.push(model);
      return {
        response: JSON.stringify({
          decision: "pass",
          coarse_category: "benign-context",
          bands: { "benign-context": "low" },
        }),
      };
    },
  };
}

function mountedWorkerEnv(ai: ReturnType<typeof mountedContractAi>) {
  const env = {
    AI: ai,
    S4_SCREENING_BEARER: MOUNTED_SCREENING_BEARER,
  } as unknown as Parameters<typeof worker.fetch>[1];
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as Parameters<typeof worker.fetch>[2];
  return { env, context };
}

/**
 * Bind the runner POST to the mounted route. Optional `mutate` is the planted
 * request-shape defect: the runner still goes through fetchBoundedLiveJson, but
 * the bytes the route sees are wrong.
 */
function mountedFetchImpl(
  env: Parameters<typeof worker.fetch>[1],
  context: Parameters<typeof worker.fetch>[2],
  mutate?: (body: Record<string, unknown>) => unknown,
): {
  readonly posted: Record<string, unknown>[];
  readonly fetch_impl: (url: URL, init: RequestInit) => Promise<Response>;
} {
  const posted: Record<string, unknown>[] = [];
  return {
    posted,
    fetch_impl: async (url, init) => {
      if (typeof init.body !== "string") {
        throw new Error("mounted S-4 runner must POST a JSON string");
      }
      const parsed = JSON.parse(init.body) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("mounted S-4 runner must POST a JSON object");
      }
      const body = parsed as Record<string, unknown>;
      posted.push(body);
      const forwarded = mutate === undefined ? init.body : JSON.stringify(mutate(body));
      return worker.fetch(new Request(url.toString(), { ...init, body: forwarded }), env, context);
    },
  };
}

describe("S-4 frozen corpus", () => {
  test("has diverse safe bodies and records that absent protected bodies BLOCK live accuracy evidence", async () => {
    const corpus = await createS4Corpus();
    expect(corpus).toHaveLength(200);
    expect(corpus.filter((example) => example.ground_truth === "legitimate")).toHaveLength(150);
    expect(corpus.filter((example) => example.ground_truth === "hard-reject")).toHaveLength(50);
    expect(corpus.filter((example) => example.aggregation_pair_id)).toHaveLength(10);
    expect(
      Object.fromEntries(
        ["spam-commercial", "injection", "dual-use-boundary", "operational-harm", "harassment"].map(
          (category) => [
            category,
            corpus.filter(
              (example) =>
                example.ground_truth === "hard-reject" && example.policy_category === category,
            ).length,
          ],
        ),
      ),
    ).toEqual({
      "spam-commercial": 10,
      injection: 10,
      "dual-use-boundary": 10,
      "operational-harm": 10,
      harassment: 10,
    });
    expect(new Set(corpus.flatMap((example) => example.aggregation_pair_id ?? [])).size).toBe(5);
    expect(() => assertS4CorpusShape(corpus)).not.toThrow();
    expect(
      new Set(
        corpus
          .filter((example) => example.ground_truth === "legitimate")
          .map((example) => example.body),
      ).size,
    ).toBe(150);
    expect(inspectS4ManifestReadiness(corpus)).toEqual({
      status: "blocked",
      blockers: ["EVALUATED_BODY_DIGEST_MISSING", "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE"],
    });
    await expect(assertS4ManifestReadyForLiveRun(corpus)).rejects.toThrow(
      "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
    );
  });

  test("binds the declared corpus identity to sorted, locally rehashed bodies rather than request serialization", async () => {
    const corpus = await createS4Corpus();
    const evaluable = corpus.filter((example) => example.source.availability === "available");
    const identity = await deriveS4EvaluatedCorpusIdentity(evaluable);
    const reorderedIdentity = await deriveS4EvaluatedCorpusIdentity([...evaluable].reverse());
    expect(identity).toEqual(reorderedIdentity);

    const first = evaluable[0];
    if (first === undefined || first.body === undefined)
      throw new Error("expected an inline fixture");
    const tampered = evaluable.map((example) =>
      example.id === first.id ? { ...example, body: `${first.body} tampered` } : example,
    );
    await expect(deriveS4EvaluatedCorpusIdentity(tampered)).rejects.toThrow(
      "EVALUATED_CORPUS_BODY_DIGEST_MISMATCH",
    );
  });

  test("the current evaluable corpus traverses the mounted route while absent hard-reject bodies remain blocked", async () => {
    // Supply the real 200-row manifest to the runner. Its honest partial path
    // sends only the 150 digest-bound inline bodies to the route; the 50
    // protected rows have neither bodies nor digests and remain unmeasured.
    const corpus = await createS4Corpus();
    const ai = mountedContractAi();
    const { env, context } = mountedWorkerEnv(ai);
    const { posted, fetch_impl } = mountedFetchImpl(env, context);
    const writes: string[] = [];
    let failure: unknown;
    try {
      await runLiveScreening({
        corpus,
        screening_url: new URL("https://a-staging.asimposium.org/internal/screen"),
        bearer: MOUNTED_SCREENING_BEARER,
        fetch_impl,
        write: (line) => writes.push(line),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "S4_PARTIAL_RUN_HARD_REJECT_UNMEASURED",
      exit_code: 78,
    });
    expect(writes).toHaveLength(1);
    // The intercepted record has the production live-run label because the
    // runner cannot know this test supplied a contract stub. It is asserted as
    // response wiring only and is not retained or cited as model evidence.
    expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({
      record_type: "screening-partial-aggregate",
      evidence_class: "provider-measured",
      verdict: "blocked",
      evaluated_count: 150,
      reserved_count: 50,
      exit_code: 78,
    });
    expect(posted).toHaveLength(1);
    const request = posted[0] ?? {};
    expect(request.partial_run).toBe(true);
    expect(Array.isArray(request.examples)).toBe(true);
    const examples = request.examples as { source?: { kind?: string }; body?: unknown }[];
    expect(examples).toHaveLength(150);
    expect(examples.every((example) => example.source?.kind === "inline-safe")).toBe(true);
    expect(examples.every((example) => typeof example.body === "string")).toBe(true);
    expect(ai.calls).toHaveLength(150);
    expect(ai.calls.every((model) => model === WORKERS_AI_MODEL)).toBe(true);
    expect(corpus.filter((example) => example.source.kind === "protected-staging")).toHaveLength(
      50,
    );
    expect(
      corpus
        .filter((example) => example.source.kind === "protected-staging")
        .every(
          (example) =>
            example.body === undefined &&
            example.body_digest === undefined &&
            example.source.availability === "blocked",
        ),
    ).toBe(true);
  });

  test("PLANTED NEGATIVE: dropping partial_run from the runner POST is refused by the mounted route with no aggregate", async () => {
    const corpus = await createS4Corpus();
    const ai = mountedContractAi();
    const { env, context } = mountedWorkerEnv(ai);
    const { fetch_impl } = mountedFetchImpl(env, context, (body) => {
      const rest = { ...body };
      delete rest.partial_run;
      return rest;
    });
    const writes: string[] = [];
    let failure: unknown;
    try {
      await runLiveScreening({
        corpus,
        screening_url: new URL("https://a-staging.asimposium.org/internal/screen"),
        bearer: MOUNTED_SCREENING_BEARER,
        fetch_impl,
        write: (line) => writes.push(line),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "WORKERS_AI_STAGING_UNAVAILABLE",
      exit_code: 78,
    });
    expect(writes).toEqual([]);
    expect(ai.calls).toEqual([]);
  });

  test("PLANTED NEGATIVE: appending a real protected-staging row to the runner POST is refused with no aggregate", async () => {
    const corpus = await createS4Corpus();
    const protectedRow = corpus.find((example) => example.source.kind === "protected-staging");
    if (protectedRow === undefined) throw new Error("expected a protected-staging corpus row");
    expect(protectedRow.body).toBeUndefined();
    expect(protectedRow.body_digest).toBeUndefined();
    const ai = mountedContractAi();
    const { env, context } = mountedWorkerEnv(ai);
    const { posted, fetch_impl } = mountedFetchImpl(env, context, (body) => ({
      ...body,
      examples: [...((body.examples as unknown[]) ?? []), protectedRow],
    }));
    const writes: string[] = [];
    let failure: unknown;
    try {
      await runLiveScreening({
        corpus,
        screening_url: new URL("https://a-staging.asimposium.org/internal/screen"),
        bearer: MOUNTED_SCREENING_BEARER,
        fetch_impl,
        write: (line) => writes.push(line),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "WORKERS_AI_STAGING_UNAVAILABLE",
      exit_code: 78,
    });
    expect(writes).toEqual([]);
    expect(ai.calls).toEqual([]);
    expect(posted).toHaveLength(1);
    const postedExamples = posted[0]?.examples;
    expect(Array.isArray(postedExamples)).toBe(true);
    expect(Array.isArray(postedExamples) ? postedExamples.length : 0).toBe(150);
  });

  test("PLANTED NEGATIVE: the real self-test reports the identity of the available bodies, never a placeholder digest", async () => {
    const corpus = await createS4Corpus();
    const expectedIdentity = await deriveS4EvaluatedCorpusIdentity(
      corpus.filter((example) => example.source.availability === "available"),
    );
    const { stdout, stderr, exitCode } = runCaptured([
      resolve(import.meta.dir, "s4-runner.ts"),
      "self-test",
    ]);
    const records = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const partial = records.find((record) => record.record_type === "screening-partial-aggregate");
    const summary = records.find((record) => record.record_type === "screening-self-test-summary");

    expect(exitCode).toBe(78);
    expect(stderr).toBe("");
    for (const record of [partial, summary]) {
      expect(record).toMatchObject({
        corpus_revision: expectedIdentity.corpus_revision,
        corpus_digest: expectedIdentity.corpus_digest,
      });
    }
    expect(stdout).not.toContain(`sha256:${"0".repeat(64)}`);
  });

  test("PLANTED NEGATIVE: a reserved legitimate body is named as legitimate evidence, never as a protected hard-reject body", async () => {
    const corpus = await createS4Corpus();
    const original = corpus.find((example) => example.ground_truth === "legitimate");
    if (original === undefined) throw new Error("expected a legitimate fixture");
    const withReservedLegitimate = corpus.map((example) =>
      example.id === original.id
        ? {
            ...original,
            body: undefined,
            body_digest: undefined,
            source: {
              ...original.source,
              kind: "protected-staging" as const,
              locator: "protected-staging:s4-legitimate/reserved-001",
              availability: "blocked" as const,
            },
          }
        : example,
    );
    expect(inspectS4ManifestReadiness(withReservedLegitimate).blockers).toEqual([
      "EVALUATED_BODY_DIGEST_MISSING",
      "LEGITIMATE_BODY_UNAVAILABLE",
      "PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE",
    ]);
  });

  test("PLANTED NEGATIVE: malformed or credential-shaped staging identities are refused before a partial record is written", async () => {
    const corpus = await createS4Corpus();
    const submitted = corpus.filter((example) => example.source.availability === "available");
    const corpusIdentity = await deriveS4EvaluatedCorpusIdentity(submitted);
    const safeIdentity: ScreeningRunIdentity = {
      ...corpusIdentity,
      model_version: "staging-model-v1",
      policy_version: "staging-policy-v1",
      configuration_digest: STAGING_CONFIGURATION_DIGEST,
    };

    for (const model_version of ["asimp_ag_0123456789abcdef", "staging model/v1"]) {
      const writes: string[] = [];
      await expect(
        runLiveScreening({
          corpus,
          screening_url: new URL("https://screening.example.test/v1/s4"),
          bearer: "test-bearer-token-with-sufficient-length",
          fetch_live_json: async () => ({
            ...safeIdentity,
            model_version,
            observations: validObservations(submitted, safeIdentity),
          }),
          write: (line) => writes.push(line),
        }),
      ).rejects.toMatchObject({ code: "STAGING_RUN_IDENTITY_INVALID", exit_code: 1 });
      expect(writes).toEqual([]);
    }
  });

  test("PLANTED NEGATIVE: staging misreporting the run scope is refused before any record is written", async () => {
    // The corpus ships with protected hard-reject bodies absent, so this run is
    // PARTIAL. A staging deployment that attests `partial_run: false` would let a
    // legitimate-only measurement be filed as the full 200-body G0 pass. Bind it.
    const corpus = await createS4Corpus();
    const submitted = corpus.filter((example) => example.source.availability === "available");
    const corpusIdentity = await deriveS4EvaluatedCorpusIdentity(submitted);
    const safeIdentity: ScreeningRunIdentity = {
      ...corpusIdentity,
      model_version: "staging-model-v1",
      policy_version: "staging-policy-v1",
      configuration_digest: STAGING_CONFIGURATION_DIGEST,
    };

    // Case 1: staging claims the run was complete when it was not.
    // Case 2: staging omits the attestation entirely (an older deployment).
    for (const scope of [{ partial_run: false }, {}] as const) {
      const writes: string[] = [];
      await expect(
        runLiveScreening({
          corpus,
          screening_url: new URL("https://screening.example.test/v1/s4"),
          bearer: "test-bearer-token-with-sufficient-length",
          fetch_live_json: async () => ({
            ...safeIdentity,
            ...scope,
            observations: validObservations(submitted, safeIdentity),
          }),
          write: (line) => writes.push(line),
        }),
      ).rejects.toMatchObject({ code: "STAGING_PARTIAL_RUN_SCOPE_MISMATCH", exit_code: 1 });
      expect(writes).toEqual([]);
    }
  });

  test("PLANTED NEGATIVE: scalar and array staging JSON is invalid, fails 1, and never leaks a response body", async () => {
    const corpus = await createS4Corpus();
    const canary = "staging-response-body-canary";
    for (const response of [null, [canary], canary, 42, false] as const) {
      const writes: string[] = [];
      let failure: unknown;
      try {
        await runLiveScreening({
          corpus,
          screening_url: new URL("https://screening.example.test/v1/s4"),
          bearer: "test-bearer-token-with-sufficient-length",
          fetch_live_json: async () => response,
          write: (line) => writes.push(line),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "WORKERS_AI_STAGING_INVALID_RESPONSE", exit_code: 1 });
      expect(String(failure)).not.toContain(canary);
      expect(writes).toEqual([]);
    }
  });
});

describe("S-4 live-response bounds", () => {
  test("terminal outcomes are typed, explicit about exit code, and never serialize an arbitrary error", () => {
    expect(s4TerminalDiagnostic(new Error("secret=not-safe-to-log"), 78)).toEqual({
      record_type: "s4-runner-terminal",
      suite: "s4-screening-oauth",
      status: "blocked",
      code: "S4_RUNNER_REQUEST_FAILED",
      exit_code: 78,
    });
  });

  test("PLANTED NEGATIVE: an invalid command emits exactly one typed terminal diagnostic", async () => {
    const { stdout, stderr, exitCode } = runCaptured([
      resolve(import.meta.dir, "s4-runner.ts"),
      "not-a-command",
    ]);
    const lines = stderr.split("\n").filter((line) => line.length > 0);

    expect(exitCode).toBe(64);
    expect(stdout).toBe("");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{} ")).toEqual({
      record_type: "s4-runner-terminal",
      suite: "s4-screening-oauth",
      status: "fail",
      code: "S4_RUNNER_USAGE",
      exit_code: 64,
    });
  });

  test("PLANTED NEGATIVE: the deadline covers a body that stalls after headers", async () => {
    const canary = "body-canary-must-not-reach-a-diagnostic";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`{"partial":"${canary}`));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    try {
      await expect(
        fetchBoundedLiveJson(new URL(`http://127.0.0.1:${server.port}/`), {}, { timeout_ms: 25 }),
      ).rejects.toMatchObject({ code: "S4_LIVE_RESPONSE_TIMEOUT" });
    } finally {
      server.stop(true);
    }
  });

  test("PLANTED NEGATIVE: a complete response over the byte ceiling is refused without echo", async () => {
    const canary = "oversized-body-canary-must-not-reach-a-diagnostic";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ payload: canary.repeat(8) }),
    });
    try {
      try {
        await fetchBoundedLiveJson(
          new URL(`http://127.0.0.1:${server.port}/`),
          {},
          { max_bytes: 32 },
        );
        throw new Error("expected a bounded-body refusal");
      } catch (error) {
        expect(error).toMatchObject({ code: "S4_LIVE_RESPONSE_TOO_LARGE" });
        expect(String(error)).not.toContain(canary);
      }
    } finally {
      server.stop(true);
    }
  });

  test("PLANTED NEGATIVE: redirects are rejected manually before the target can receive the request", async () => {
    let redirectTargetRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname === "/redirect") {
          return Response.redirect(new URL("/redirect-target", request.url).toString(), 302);
        }
        redirectTargetRequests += 1;
        return Response.json({ unexpected: "redirect target was reached" });
      },
    });
    try {
      await expect(
        fetchBoundedLiveJson(new URL(`http://127.0.0.1:${server.port}/redirect`), {}),
      ).rejects.toMatchObject({ code: "S4_LIVE_RESPONSE_UNAVAILABLE" });
      expect(redirectTargetRequests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("PLANTED NEGATIVE: reader cleanup errors cannot replace the original bounded failure", () => {
    const reader = {
      cancel() {
        throw new Error("cancel cleanup failure");
      },
      releaseLock() {
        throw new Error("release cleanup failure");
      },
    } as unknown as Parameters<typeof cleanupBoundedResponseReader>[0];
    expect(() => cleanupBoundedResponseReader(reader)).not.toThrow();
  });

  test("PLANTED NEGATIVE: OAuth still runs and is reported after an early screening failure, after screening evidence", async () => {
    const records: Record<string, unknown>[] = [];
    let oauthCalls = 0;
    let failure: unknown;
    try {
      await runIndependentLivePhases(
        async () => {
          records.push({ record_type: "screening-aggregate", evidence_class: "provider-measured" });
          throw new Error("S4_SCREENING_SYNTHETIC_FAILURE");
        },
        async () => {
          oauthCalls += 1;
        },
        (record) => records.push(record),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "S4_SCREENING_SYNTHETIC_FAILURE", exit_code: 78 });
    expect(oauthCalls).toBe(1);
    expect(records.map((record) => record.record_type)).toEqual([
      "screening-aggregate",
      "screening-live-diagnostic",
      "oauth-dry-check",
    ]);
    expect(records[1]).toMatchObject({ status: "blocked", code: "S4_SCREENING_SYNTHETIC_FAILURE" });
    expect(records[2]).toMatchObject({ status: "pass", code: "OAUTH_DRY_CHECK_GREEN" });
  });

  test("PLANTED NEGATIVE: a later OAuth failure cannot discard already-emitted screening evidence", async () => {
    const records: Record<string, unknown>[] = [];
    await expect(
      runIndependentLivePhases(
        async () => {
          records.push({ record_type: "screening-aggregate", evidence_class: "provider-measured" });
        },
        async () => {
          throw new Error("OAUTH_DRY_CHECK_INVALID_RESPONSE");
        },
        (record) => records.push(record),
      ),
    ).rejects.toMatchObject({ code: "OAUTH_DRY_CHECK_INVALID_RESPONSE", exit_code: 78 });
    expect(records.map((record) => record.record_type)).toEqual([
      "screening-aggregate",
      "oauth-dry-check",
    ]);
    expect(records[1]).toMatchObject({
      status: "blocked",
      code: "OAUTH_DRY_CHECK_INVALID_RESPONSE",
    });
  });
});
