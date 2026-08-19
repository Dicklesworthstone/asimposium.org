import { describe, expect, test } from "bun:test";
import worker from "../../src/index";
import {
  type ScreeningCorpusExample,
  verifyObservationBodyBindings,
} from "../../src/screening/index";
import { handleScreeningRequest, SCREENING_MAX_REQUEST_BYTES } from "../../src/screening/route";
import { WORKERS_AI_MODEL } from "../../src/screening/workers-ai";
import { boundEnv, executionContext } from "../support/bindings";

/**
 * Contract tests for the S-4 staging screening route (`POST /internal/screen`).
 *
 * The `AI` binding is the external boundary, so it is stubbed here with a
 * canned `run()` — the same discipline the fixture provider documents: these
 * tests prove the route's wiring (auth, bounds, digest binding, fail-closed
 * translation), and nothing here is evidence about model accuracy. That proof
 * is the live staging run.
 */

const BEARER = "s4-test-bearer-token-0123456789";

/** The route's problem documents and observation lists, narrowed once here. */
function refusalCode(json: unknown): string {
  if (
    typeof json === "object" &&
    json !== null &&
    "code" in json &&
    typeof json.code === "string"
  ) {
    return json.code;
  }
  throw new Error("expected a problem document carrying a string code");
}

function refusalFixHint(json: unknown): unknown {
  if (typeof json === "object" && json !== null && "fix_hint" in json) return json.fix_hint;
  return undefined;
}

function observationsOf(json: unknown): Record<string, unknown>[] {
  if (
    typeof json === "object" &&
    json !== null &&
    "observations" in json &&
    Array.isArray(json.observations) &&
    json.observations.every(
      (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
  ) {
    return json.observations as Record<string, unknown>[];
  }
  throw new Error("expected a screening response carrying an observations array");
}

function topLevelField(json: unknown, field: string): unknown {
  if (typeof json === "object" && json !== null && field in json) {
    return (json as Record<string, unknown>)[field];
  }
  return undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A canned classification the stub binding returns for every example. */
function cannedClassification(decision: string, category = "benign-context") {
  return {
    response: JSON.stringify({
      decision,
      coarse_category: category,
      bands: {
        "benign-context": decision === "pass" ? "high" : "low",
        "spam-commercial": "low",
        injection: "low",
        "dual-use-boundary": decision === "reject" ? "high" : "low",
        "operational-harm": "low",
        harassment: "low",
        "sexual-content": "low",
        "provider-unavailable": null,
      },
    }),
  };
}

function passingAi() {
  const calls: { model: string; input: unknown }[] = [];
  return {
    calls,
    async run(model: string, input: unknown) {
      calls.push({ model, input });
      return cannedClassification("pass");
    },
  };
}

interface CorpusEntry {
  id: string;
  body: string;
  body_digest: string;
}

interface CorpusRequest {
  corpus_revision: string;
  corpus_digest: string;
  partial_run: boolean;
  examples: {
    manifest_version: string;
    id: string;
    body_digest: string;
    body?: string;
    source: Record<string, unknown>;
    ground_truth: string;
    expected_outcome: string;
    policy_category: string;
    stratum: string;
    rationale: string;
    safe_excerpt: string;
  }[];
}

async function corpusRequest(
  entries: readonly { id: string; body: string }[],
): Promise<CorpusRequest> {
  const examples: CorpusEntry[] = [];
  for (const entry of entries) {
    examples.push({ ...entry, body_digest: `sha256:${await sha256Hex(entry.body)}` });
  }
  const members = examples
    .map((example) => ({ id: example.id, body_digest: example.body_digest }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    corpus_revision: "s4-manifest-test-v1",
    corpus_digest: `sha256:${await sha256Hex(JSON.stringify(members))}`,
    partial_run: true,
    examples: examples.map((example) => ({
      manifest_version: "s4-manifest-v2",
      id: example.id,
      body_digest: example.body_digest,
      body: example.body,
      source: {
        kind: "inline-safe",
        locator: `test:${example.id}`,
        version: "1",
        provenance: "route unit test",
        license: "test-fixture",
        availability: "available",
      },
      ground_truth: "legitimate",
      expected_outcome: "pass-or-warning",
      policy_category: "benign-context",
      stratum: "unit-test",
      rationale: "Route wiring test entry.",
      safe_excerpt: "Route wiring test entry.",
    })),
  };
}

function screeningEnv(ai: unknown, bearer: string | null = BEARER) {
  const env: Record<string, unknown> = { ...boundEnv() };
  if (bearer !== null) env.S4_SCREENING_BEARER = bearer;
  if (ai !== undefined) env.AI = ai;
  return env;
}

function screeningRequest(body: string, bearer: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return new Request("https://a-staging.asimposium.org/internal/screen", {
    method: "POST",
    headers,
    body,
  });
}

async function postScreening(
  body: unknown,
  options: { bearer?: string | null; env?: unknown } = {},
) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  const request = screeningRequest(
    serialized,
    options.bearer === null ? null : (options.bearer ?? BEARER),
  );
  const env = options.env ?? screeningEnv(passingAi());
  const response = await worker.fetch(
    request,
    env as never,
    executionContext() as unknown as Parameters<typeof worker.fetch>[2],
  );
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

describe("POST /internal/screen", () => {
  function firstExample(corpus: {
    examples: { body?: unknown; body_digest?: unknown; source?: unknown }[];
  }) {
    const example = corpus.examples[0];
    if (example === undefined) throw new Error("fixture corpus has no first example");
    return example;
  }

  test("screens a valid corpus and returns the runner's typed response shape", async () => {
    const ai = passingAi();
    const corpus = await corpusRequest([
      { id: "legit-001", body: "Compare two chromatic-polynomial roots after deleting a bridge." },
      { id: "legit-002", body: "Does every planar triangulation admit a bounded separator?" },
    ]);
    const res = await postScreening(corpus, { env: screeningEnv(ai) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // The runner reads the identity fields at the top level of a bare object.
    expect(topLevelField(res.json, "corpus_revision")).toBe(corpus.corpus_revision);
    expect(topLevelField(res.json, "corpus_digest")).toBe(corpus.corpus_digest);
    expect(typeof topLevelField(res.json, "model_version")).toBe("string");
    expect(typeof topLevelField(res.json, "policy_version")).toBe("string");
    expect(topLevelField(res.json, "configuration_digest")).toMatch(/^sha256:[a-f0-9]{64}$/);

    const observations = observationsOf(res.json);
    expect(observations).toHaveLength(2);
    for (const [index, example] of corpus.examples.entries()) {
      const observation = observations[index];
      if (observation === undefined) throw new Error(`missing observation for ${example.id}`);
      expect(observation.example_id).toBe(example.id);
      // The body binding is the attestation: the digest the runner sent is the
      // digest this observation answers for.
      expect(observation.evaluated_body_digest).toBe(example.body_digest);
      expect(observation.decision).toBe("pass");
      expect(observation.coarse_category).toBe("benign-context");
      expect(observation.provider_status).toBe("ok");
      expect(observation.decision_path).toBe("provider");
      expect(observation.status_code).toBe("SCREENED");
      // The provider contract's exact-key score-band record. Keys whose band
      // is undefined (here: provider-unavailable, a fail-closed marker the
      // model never emits) do not survive JSON serialization.
      const bands = observation.category_score_bands;
      expect(typeof bands === "object" && bands !== null ? Object.keys(bands).sort() : []).toEqual(
        [
          "benign-context",
          "dual-use-boundary",
          "harassment",
          "injection",
          "operational-harm",
          "sexual-content",
          "spam-commercial",
        ].sort(),
      );
    }
    // The adapter called the model the binding is pinned to, once per example.
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls.every((call) => call.model === WORKERS_AI_MODEL)).toBe(true);
  });

  test("malformed JSON gets the teaching 422, not a crash", async () => {
    const res = await postScreening("{not json");

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(refusalCode(res.json)).toBe("SCREENING_REQUEST_MALFORMED");
    expect(typeof refusalFixHint(res.json)).toBe("string");
  });

  test("a structurally wrong corpus object gets the shape-teaching 422", async () => {
    const res = await postScreening({ corpus_revision: "s4-manifest-test-v1", examples: [] });

    expect(res.status).toBe(422);
    expect(refusalCode(res.json)).toBe("SCREENING_REQUEST_MALFORMED");
  });

  test("a missing bearer is a flat 401", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { bearer: null });

    expect(res.status).toBe(401);
    expect(refusalCode(res.json)).toBe("SCREENING_UNAUTHORIZED");
    // The refusal must not echo or hint at the expected token.
    expect(res.text).not.toContain(BEARER);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("a wrong bearer is the same flat 401", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { bearer: "s4-test-bearer-token-999999999" });

    expect(res.status).toBe(401);
    expect(refusalCode(res.json)).toBe("SCREENING_UNAUTHORIZED");
  });

  test("an unset bearer refuses 503 before reading the body", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { env: screeningEnv(passingAi(), null) });

    expect(res.status).toBe(503);
    expect(refusalCode(res.json)).toBe("SCREENING_UNAVAILABLE");
  });

  test("a missing AI binding refuses the same 503 as a missing bearer", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const withoutAi = await postScreening(corpus, { env: screeningEnv(undefined) });
    const withoutBearer = await postScreening(corpus, {
      env: screeningEnv(passingAi(), null),
    });

    expect(withoutAi.status).toBe(503);
    expect(refusalCode(withoutAi.json)).toBe("SCREENING_UNAVAILABLE");
    // Opaque by construction: the two disabled states teach identically.
    expect(withoutAi.text).toBe(withoutBearer.text);
  });

  test("a provider error yields the quarantine path, never a pass", async () => {
    const failingAi = {
      async run() {
        throw new Error("workers ai unavailable");
      },
    };
    const corpus = await corpusRequest([
      { id: "legit-001", body: "A benign post." },
      { id: "legit-002", body: "Another benign post." },
    ]);
    const res = await postScreening(corpus, { env: screeningEnv(failingAi) });

    // The run completes; every example is held rather than passed.
    expect(res.status).toBe(200);
    const observations = observationsOf(res.json);
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation.decision).toBe("quarantine");
      expect(observation.coarse_category).toBe("provider-unavailable");
      expect(observation.provider_status).toBe("error");
      expect(observation.decision_path).toBe("provider-error-fail-closed");
      expect(observation.status_code).toBe("SCREENING_PROVIDER_ERROR");
    }
  });

  test("a provider timeout yields the timeout quarantine path, never a pass", async () => {
    const hangingAi = {
      run: () => new Promise<never>(() => undefined),
    };
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const response = await handleScreeningRequest(
      screeningRequest(JSON.stringify(corpus), BEARER),
      screeningEnv(hangingAi) as never,
      { perExampleTimeoutMs: 25 },
    );
    const observations = observationsOf(await response.json());

    expect(response.status).toBe(200);
    expect(observations).toHaveLength(1);
    const first = observations[0];
    if (first === undefined) throw new Error("missing the timeout observation");
    expect(first.decision).toBe("quarantine");
    expect(first.provider_status).toBe("timeout");
    expect(first.decision_path).toBe("provider-timeout-fail-closed");
    expect(first.status_code).toBe("SCREENING_PROVIDER_TIMEOUT");
  });

  test("an unparseable model completion is a provider error, not a pass", async () => {
    const proseAi = {
      async run() {
        return { response: "I cannot classify this post because…" };
      },
    };
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { env: screeningEnv(proseAi) });

    expect(res.status).toBe(200);
    const observation = observationsOf(res.json)[0];
    if (observation === undefined) throw new Error("missing observation");
    expect(observation.decision).toBe("quarantine");
    expect(observation.provider_status).toBe("error");
  });

  test("an out-of-vocabulary model decision is a provider error, not a pass", async () => {
    const inventiveAi = {
      async run() {
        return cannedClassification("definitely-fine");
      },
    };
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { env: screeningEnv(inventiveAi) });

    const observation = observationsOf(res.json)[0];
    if (observation === undefined) throw new Error("missing observation");
    expect(observation.decision).toBe("quarantine");
    expect(observation.provider_status).toBe("error");
  });

  test("a body that does not hash to its declared digest is refused 422", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    firstExample(corpus).body = "A different body than the digest attests.";
    const res = await postScreening(corpus);

    expect(res.status).toBe(422);
    expect(refusalCode(res.json)).toBe("SCREENING_BODY_DIGEST_MISMATCH");
  });

  test("a declared corpus digest that does not match the example set is refused 422", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    corpus.corpus_digest = `sha256:${"0".repeat(64)}`;
    const res = await postScreening(corpus);

    expect(res.status).toBe(422);
    expect(refusalCode(res.json)).toBe("SCREENING_CORPUS_DIGEST_MISMATCH");
  });

  test("an entry without an evaluable inline body is refused 422, not screened", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const first = firstExample(corpus);
    first.source = {
      ...(typeof first.source === "object" && first.source !== null ? first.source : {}),
      kind: "protected-staging",
    };
    first.body = undefined;
    const res = await postScreening(corpus);

    expect(res.status).toBe(422);
    expect(refusalCode(res.json)).toBe("SCREENING_BODY_UNEVALUABLE");
  });

  test("an oversized body is refused 413", async () => {
    const request = new Request("https://a-staging.asimposium.org/internal/screen", {
      method: "POST",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
        "content-length": String(SCREENING_MAX_REQUEST_BYTES + 1),
      },
      body: "{}",
    });
    const response = await worker.fetch(
      request,
      screeningEnv(passingAi()) as never,
      executionContext() as unknown as Parameters<typeof worker.fetch>[2],
    );

    expect(response.status).toBe(413);
    expect(refusalCode(await response.json())).toBe("SCREENING_REQUEST_TOO_LARGE");
  });

  test("the route teaches nothing about classified content in its refusals", async () => {
    // ADR-18: refusals name checks, never matched content or trigger text.
    const corpus = await corpusRequest([
      { id: "legit-001", body: "A body whose exact wording must never appear in a refusal." },
    ]);
    firstExample(corpus).body_digest = `sha256:${"1".repeat(64)}`;
    corpus.corpus_digest = `sha256:${"2".repeat(64)}`;
    const res = await postScreening(corpus);

    expect(res.status).toBe(422);
    expect(res.text).not.toContain("exact wording");
    expect(res.text).not.toContain("A body whose exact wording");
  });

  // The live runner feeds this route's parsed JSON straight into
  // verifyObservationBodyBindings, so the wire form — not the in-process
  // object — is the contract. JSON cannot carry an undefined score band; these
  // tests prove the response validates after a real serialize/parse round
  // trip, for the provider-ok shape (bands present) and the fail-closed shape
  // (every band absent).
  test("the wire response passes the runner's body-binding verification after JSON round-trip", async () => {
    const corpus = await corpusRequest([
      { id: "legit-001", body: "A benign graph-theory post." },
      { id: "legit-002", body: "A benign combinatorics post." },
    ]);
    const res = await postScreening(corpus, { env: screeningEnv(passingAi()) });
    // The test corpus builder emits the manifest-entry shape; the cast names
    // the boundary where the runner's own typed corpus would arrive.
    const submitted = corpus.examples as unknown as ScreeningCorpusExample[];
    const roundTripped: unknown = JSON.parse(res.text);

    expect(() =>
      verifyObservationBodyBindings(submitted, observationsOf(roundTripped) as never),
    ).not.toThrow();
  });

  test("fail-closed observations (every band absent) pass the runner's wire verification", async () => {
    const failingAi = {
      async run() {
        throw new Error("workers ai unavailable");
      },
    };
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus, { env: screeningEnv(failingAi) });
    const submitted = corpus.examples as unknown as ScreeningCorpusExample[];
    const roundTripped: unknown = JSON.parse(res.text);
    const observations = observationsOf(roundTripped);

    // The all-undefined band record serialized to no keys at all.
    const firstObservation = observations[0];
    if (firstObservation === undefined) throw new Error("missing observation");
    const bands = firstObservation.category_score_bands;
    expect(typeof bands === "object" && bands !== null ? Object.keys(bands) : null).toEqual([]);
    expect(() => verifyObservationBodyBindings(submitted, observations as never)).not.toThrow();
  });

  test("a foreign band key smuggled into an observation is refused by the runner's verification", async () => {
    const corpus = await corpusRequest([{ id: "legit-001", body: "A benign post." }]);
    const res = await postScreening(corpus);
    const submitted = corpus.examples as unknown as ScreeningCorpusExample[];
    const observations = observationsOf(JSON.parse(res.text));
    const firstObservation = observations[0];
    if (firstObservation === undefined) throw new Error("missing observation");
    const bands = firstObservation.category_score_bands;
    if (typeof bands !== "object" || bands === null) throw new Error("expected band record");
    (bands as Record<string, unknown>)["made-up-category"] = "high";

    expect(() => verifyObservationBodyBindings(submitted, observations as never)).toThrow();
  });
});
