import { writeFileSync } from "node:fs";

import {
  DeviceCodeStartResponseSchema,
  EnrollmentHelloResponseSchema,
  isTrustedStoaOrigin,
  PENDING_PROPOSAL_TTL_MS,
  SponsorEnrollmentDecisionResponseSchema,
} from "@asimposium/contracts";

import { DEVICE_CODE_TTL_MS, SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS } from "./service.ts";

/**
 * The two reads hello may offer as a Fellow's first action. This mirrors the
 * staging shell contract in `scripts/e2e-s1-cold-enrollment.sh` rather than
 * trusting whatever the response happens to name: a driver that follows an
 * arbitrary URL because the server said to is a redirector, and the bearer it
 * just received is what makes that dangerous.
 */
export const SAFE_FIRST_READ_PATHS: readonly string[] = ["/protocol.md", "/skill.md"];

/**
 * The complete local-D1 proof corpus. The shell imports this exact exported
 * list when it validates the retained terminal record; a subset must never be
 * enough to turn a local run green.
 */
export const LOCAL_D1_EVIDENCE_CASES = [
  "encrypted-idempotency-lost-response",
  "capsule-public-face-secret-boundary",
  "capsule-public-authority-redaction",
  "planted-minted-secret-leak-refusal",
  "planted-private-authority-leak-refusal",
  "planted-wrong-secret-opaque-refusal",
  "name-policy",
  "idempotency-digest-conflict",
  "claim-missing-idempotency-key-no-write",
  "approval-card-principal-boundary",
  "body-only-flow",
  "decision-step-up-command-required",
  "durable-approval-grant",
  "stable-poll-key-approval-transition",
  "approve-token-hello-binding",
  "authenticated-private-authority-recovery",
  "hello-and-first-read-bearer-echo-refusal",
  "hello-next-action-canonical-first-safe-read",
  "mounted-device-ingress-exact-replay-conflict",
  "mounted-device-pre-decision-slow-down",
  "mounted-device-complete-card-approve-token-hello",
  "mounted-device-second-sponsor-wrong-principal",
  "concurrent-first-claim-replay",
  "failed-batch-does-not-poison-key",
  "stable-poll-key-denial-transition",
  "sponsor-enrollment-rolling-day-budget",
  "concurrent-device-start-source-limit",
  "concurrent-device-start-final-slot-replay",
  "stable-poll-key-30m-expiry-transition",
  "stable-poll-key-30m-lookup-decision-refusal",
  "decision-replay-after-step-up-expiry",
  "stable-poll-key-24h-proposal-expiry-transition",
  "stable-poll-key-24h-proposal-expiry-durable-state",
  "mounted-device-cap-rollback-expiry-replay",
] as const;

export const LOCAL_D1_COMPLETION_SKIP_PLANT = "mounted-device-ingress-exact-replay-conflict";

/**
 * The record is a completion ledger, not a re-serialization of the declared
 * corpus. Each scenario marks itself only after its assertions succeeded; this
 * ledger rejects a missing, duplicate, unknown, or out-of-order completion
 * before any terminal evidence can be written.
 */
export function createLocalEvidenceCompletionLedger(skipCase?: string) {
  const declared: readonly string[] = LOCAL_D1_EVIDENCE_CASES;
  if (skipCase !== undefined && skipCase !== LOCAL_D1_COMPLETION_SKIP_PLANT) {
    throw new Error("evidence-case-skip-invalid");
  }
  const completedCases: string[] = [];
  return {
    complete(caseName: string): void {
      if (!declared.includes(caseName)) throw new Error("evidence-case-unknown");
      if (completedCases.includes(caseName)) throw new Error("evidence-case-duplicate");
      if (caseName === skipCase) return;
      if (declared[completedCases.length] !== caseName) throw new Error("evidence-case-order");
      completedCases.push(caseName);
    },
    cases(): readonly string[] {
      if (
        completedCases.length !== declared.length ||
        !completedCases.every((caseName, index) => caseName === declared[index])
      ) {
        throw new Error("evidence-case-incomplete");
      }
      return completedCases;
    },
  };
}

/** Every local HTTP body is capped before a JSON or text reader can retain it. */
export const LOCAL_RESPONSE_MAX_BYTES = 262_144;

/**
 * The local driver is narrower than the Worker: only a canonical loopback
 * binding can exercise local D1. Reuse the public trusted-origin predicate so
 * default, zero, out-of-range, and leading-zero ports cannot make the local
 * harness accept an origin the enrollment surface itself would refuse.
 */
export function isTrustedLocalD1Origin(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("http://127.0.0.1:") && isTrustedStoaOrigin(value)
  );
}

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

function oversizedLocalResponse(response: Response): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("local-response-too-large"));
      },
    }),
    responseInit(response),
  );
}

/**
 * Retain a response's status and headers but place a byte-counting stream in
 * front of its body. A Content-Length is only an early refusal optimization:
 * the stream is authoritative because a peer may omit or lie about that header.
 */
export function boundedLocalResponse(response: Response): Response {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^(?:0|[1-9][0-9]*)$/.test(declaredLength) &&
    (!Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) > LOCAL_RESPONSE_MAX_BYTES)
  ) {
    return oversizedLocalResponse(response);
  }
  if (response.body === null) return response;

  let observedBytes = 0;
  const boundedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedBytes += chunk.byteLength;
        if (observedBytes > LOCAL_RESPONSE_MAX_BYTES) {
          controller.error(new Error("local-response-too-large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(boundedBody, responseInit(response));
}

/** Fellow bearer prefix (Fable §5.2). Stripping it must not defeat the echo check. */
const FELLOW_TOKEN_PREFIX = "asimp_ag_";

/**
 * Resolve hello's first `next_actions` entry to a URL this driver may fetch
 * **unauthenticated**, or throw a fixed harness code.
 *
 * Separate codes distinguish "hello offered no action list" from "hello offered
 * an unsafe first action", because those are different defects: the first is a
 * contract regression, the second is the redirector this check exists to stop.
 * Neither code carries the offered URL or any response byte.
 *
 * The rule is **raw string equality** against the canonical hrefs this origin can
 * legitimately offer — not a parsed comparison of origin plus pathname.
 *
 * That distinction is the whole check. `new URL()` normalizes before you get to
 * inspect it: `/v1/../protocol.md` parses with `pathname === "/protocol.md"`, and
 * a trailing `?` or `#` parses with `search`/`hash` both empty string. A parsed
 * comparison therefore *accepts* all three, and the driver would follow a URL
 * whose bytes are not the one the Worker composed. Comparing the raw string to a
 * closed set of exact hrefs cannot be fooled that way, and it subsumes every
 * separate userinfo, query, fragment, scheme, port, and path rule at once.
 */
export function firstSafeReadUrl(hello: unknown, origin: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new Error("next-actions-missing");
  }
  const actions = (hello as { next_actions?: unknown } | null)?.next_actions;
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("next-actions-missing");

  const first: unknown = actions[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new Error("next-action-unsafe");
  }
  const { action, url } = first as { action?: unknown; url?: unknown };
  if (action !== "read" || typeof url !== "string") throw new Error("next-action-unsafe");

  const canonical = SAFE_FIRST_READ_PATHS.map((path) => `${base.origin}${path}`);
  if (!canonical.includes(url)) throw new Error("next-action-unsafe");
  return url;
}

/**
 * True when `body` reveals the bearer. The prefix-stripped material counts as an
 * echo for the same reason it does for a minted enrollment secret above: a face
 * that renders the opaque half without `asimp_ag_` has still published the
 * credential.
 */
export function bodyEchoesBearer(body: string, token: string): boolean {
  if (token.length === 0) return false;
  if (body.includes(token)) return true;
  const material = token.startsWith(FELLOW_TOKEN_PREFIX)
    ? token.slice(FELLOW_TOKEN_PREFIX.length)
    : "";
  return material.length > 0 && body.includes(material);
}

function completionSkipPlantCode(): string {
  try {
    const completion = createLocalEvidenceCompletionLedger(LOCAL_D1_COMPLETION_SKIP_PLANT);
    for (const caseName of LOCAL_D1_EVIDENCE_CASES) completion.complete(caseName);
    completion.cases();
    return "evidence-case-skip-accepted";
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    return /^[a-z][a-z0-9-]{0,79}$/.test(candidate) ? candidate : "evidence-case-plant";
  }
}

// Importable for the unit seam without running the driver: the planted
// cross-origin, write-action, and bearer-echo cases must be provable without
// standing up Workerd or sending a single attacker request.
const origin = import.meta.main ? process.env.S1_LOCAL_ORIGIN : undefined;
const evidenceCompletionSelfTest = import.meta.main
  ? process.env.S1_LOCAL_EVIDENCE_COMPLETION_SELF_TEST
  : undefined;
if (!import.meta.main) {
  // Imported for the pure helpers above. The enrollment driver does not run.
} else if (evidenceCompletionSelfTest !== undefined) {
  const code =
    evidenceCompletionSelfTest === "skip-mounted-device"
      ? completionSkipPlantCode()
      : "evidence-completion-self-test-invalid";
  process.stderr.write(
    `${JSON.stringify({
      tool: "bun+wrangler",
      package: "apps/wire",
      suite: "s1-enrollment-local-d1",
      status: "fail",
      code,
    })}\n`,
  );
  process.exitCode = 1;
} else if (!isTrustedLocalD1Origin(origin)) {
  process.stderr.write('{"status":"fail","code":"LOCAL_ORIGIN_INVALID"}\n');
  process.exitCode = 1;
} else {
  const startedAt = performance.now();
  const sponsorId = "usr_local_sponsor_s1";
  const decisionStepUpAuthenticatedAt = Math.floor(Date.now() / 1_000);
  const fetchTimeoutMs = 5_000;
  // Cap the retained record. It is a fixed-shape summary, so this bound is far
  // above any honest value and exists to make the reader's parse total.
  const MAX_EVIDENCE_BYTES = 64 * 1024;
  const evidencePath = process.env.S1_LOCAL_EVIDENCE_PATH;
  const runNonce = process.env.S1_LOCAL_EVIDENCE_NONCE;

  const localFetch = async (input: string, init: RequestInit = {}): Promise<Response> =>
    boundedLocalResponse(
      await fetch(input, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(fetchTimeoutMs),
      }),
    );

  const parseLocalJson = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };

  const approvedHelloUrl = (value: unknown, code: string): string => {
    const expected = `${origin}/v1/hello`;
    if (value !== expected) throw new Error(code);
    return value;
  };

  const readCanonicalHello = async (
    result: Response,
    token: string,
    schemaCode: string,
    echoCode: string,
  ) => {
    const raw = await result.text();
    if (bodyEchoesBearer(raw, token)) throw new Error(echoCode);
    const parsed = EnrollmentHelloResponseSchema.safeParse(parseLocalJson(raw));
    if (result.status !== 200 || !parsed.success) throw new Error(schemaCode);
    return parsed.data;
  };

  const readLocalHelloBinding = async (token: string, code: string) =>
    readCanonicalHello(
      await localFetch(`${origin}/__s1/local-only/hello-binding`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      token,
      code,
      "local-hello-binding-token-echo",
    );

  const assertExactHelloBinding = (
    actual: ReturnType<typeof EnrollmentHelloResponseSchema.parse>,
    expected: ReturnType<typeof EnrollmentHelloResponseSchema.parse>,
    code: string,
  ): void => {
    if (
      actual.fellow.fellow_id !== expected.fellow.fellow_id ||
      actual.fellow.name !== expected.fellow.name ||
      actual.fellow.model !== expected.fellow.model ||
      actual.fellow.harness !== expected.fellow.harness ||
      JSON.stringify(actual.granted_scopes) !== JSON.stringify(expected.granted_scopes) ||
      JSON.stringify(actual.granted_resources) !== JSON.stringify(expected.granted_resources)
    ) {
      throw new Error(code);
    }
  };

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    localFetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const get = (path: string, parameters: Readonly<Record<string, string>>): Promise<Response> => {
    const query = new URLSearchParams(parameters);
    return localFetch(`${origin}${path}?${query.toString()}`);
  };

  interface DeviceCounts {
    readonly device_records: number;
    readonly start_attempts: number;
    readonly start_replays: number;
  }

  interface SponsorEnrollmentCounts {
    readonly join_attempts: number;
    readonly device_attempts: number;
  }

  const readDeviceCounts = async (): Promise<DeviceCounts> => {
    const result = await localFetch(`${origin}/__s1/device-counts`);
    if (result.status !== 200) throw new Error("device-counts-status");
    const body = (await result.json()) as Partial<DeviceCounts>;
    if (
      !Number.isSafeInteger(body.device_records) ||
      !Number.isSafeInteger(body.start_attempts) ||
      !Number.isSafeInteger(body.start_replays) ||
      (body.device_records ?? -1) < 0 ||
      (body.start_attempts ?? -1) < 0 ||
      (body.start_replays ?? -1) < 0
    ) {
      throw new Error("device-counts-shape");
    }
    return body as DeviceCounts;
  };

  const readSponsorEnrollmentCounts = async (): Promise<SponsorEnrollmentCounts> => {
    const result = await get("/__s1/sponsor-enrollment-counts", { sponsor_id: sponsorId });
    if (result.status !== 200) throw new Error("sponsor-enrollment-counts-status");
    const body = (await result.json()) as Partial<SponsorEnrollmentCounts>;
    if (
      !Number.isSafeInteger(body.join_attempts) ||
      !Number.isSafeInteger(body.device_attempts) ||
      (body.join_attempts ?? -1) < 0 ||
      (body.device_attempts ?? -1) < 0
    ) {
      throw new Error("sponsor-enrollment-counts-shape");
    }
    return body as SponsorEnrollmentCounts;
  };

  const deviceStartBody = (name: string): Record<string, unknown> => ({
    name,
    model: "local-model",
    harness: "codex",
    requested_scopes: ["review"],
  });

  const startDevice = (
    clientAddress: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Response> =>
    post("/v1/device-code", body, {
      // Local Workerd does not receive Cloudflare's edge-injected header.
      // This harness-only fixture drives the mounted production route; it
      // does not establish production header provenance.
      "cf-connecting-ip": clientAddress,
      "idempotency-key": idempotencyKey,
    });

  const assertCountDelta = (
    before: DeviceCounts,
    after: DeviceCounts,
    expected: number,
    code: string,
  ): void => {
    if (
      after.device_records - before.device_records !== expected ||
      after.start_attempts - before.start_attempts !== expected ||
      after.start_replays - before.start_replays !== expected
    ) {
      throw new Error(code);
    }
  };

  const assertDecisionAcknowledged = async (result: Response, code: string): Promise<void> => {
    const body = await result.json();
    if (result.status !== 200 || !SponsorEnrollmentDecisionResponseSchema.safeParse(body).success) {
      throw new Error(code);
    }
  };

  /**
   * A capsule may show its explicitly labelled, non-authoritative public
   * demonstration value. The boundary is the secret minted for this specific
   * enrollment, including its opaque material when a renderer strips the
   * `v1.` prefix; a secret-shaped prefix by itself is not a leak.
   */
  const assertMintedSecretAbsentFromCapsuleFaces = (
    faces: readonly (readonly [face: string, body: string])[],
    mintedSecret: string,
  ): void => {
    const mintedSecretMaterial = mintedSecret.slice("v1.".length);
    const leakingFace = faces.find(
      ([_face, body]) =>
        body.includes(mintedSecret) ||
        (mintedSecretMaterial.length > 0 && body.includes(mintedSecretMaterial)),
    )?.[0];
    if (leakingFace !== undefined) {
      // The face name is a fixed local-harness label, never caller content.
      throw new Error(`capsule-secret-boundary:${leakingFace}`);
    }
  };

  /**
   * PLANTED NEGATIVE: the detector must reject the actual value minted by this
   * real local-D1 run. This remains distinct from the normal assertion below,
   * which checks the Worker-rendered public faces.
   */
  const assertPlantedMintedSecretLeakIsRefused = (mintedSecret: string): void => {
    const plantedFace = "planted-minted-secret-leak";
    try {
      assertMintedSecretAbsentFromCapsuleFaces([[plantedFace, mintedSecret]], mintedSecret);
    } catch (error) {
      if (error instanceof Error && error.message === `capsule-secret-boundary:${plantedFace}`) {
        return;
      }
      throw error;
    }
    throw new Error("capsule-planted-minted-secret-leak-accepted");
  };

  const assertSponsorAuthorityAbsentFromCapsuleFaces = (
    faces: readonly (readonly [face: string, body: string])[],
    forbidden: readonly string[],
  ): void => {
    for (const [face, body] of faces) {
      if (forbidden.some((value) => body.includes(value))) {
        throw new Error(`capsule-private-authority-boundary:${face}`);
      }
    }
  };

  const assertPlantedPrivateAuthorityLeakIsRefused = (privateDirective: string): void => {
    try {
      assertSponsorAuthorityAbsentFromCapsuleFaces(
        [["planted-private-authority-leak", privateDirective]],
        [privateDirective],
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "capsule-private-authority-boundary:planted-private-authority-leak"
      ) {
        return;
      }
      throw error;
    }
    throw new Error("capsule-planted-private-authority-leak-accepted");
  };

  try {
    // Validated before the first request, so a run that could never produce
    // readable evidence fails immediately instead of after driving the whole
    // enrollment flow. The nonce is a non-secret run marker; the path must be
    // absolute so this client can never resolve it against its own cwd.
    if (typeof runNonce !== "string" || !/^[0-9a-f]{32}$/.test(runNonce)) {
      throw new Error("evidence-nonce-invalid");
    }
    if (typeof evidencePath !== "string" || !evidencePath.startsWith("/")) {
      throw new Error("evidence-path-invalid");
    }
    const evidenceCompletion = createLocalEvidenceCompletionLedger(
      process.env.S1_LOCAL_EVIDENCE_SKIP_CASE,
    );
    const completeCase = (caseName: string): void => evidenceCompletion.complete(caseName);

    const privateProblem = "P-PRIV9";
    const privateDirective = "private-local-d1-directive-canary-9b3f";
    const privateEventBudget = 9_871;
    const privateArtifactBudget = 987_654_321;
    const mintRequest = {
      sponsor_id: sponsorId,
      request: {
        requested_scopes: ["review"],
        problem_binding: privateProblem,
        first_directive: privateDirective,
        event_budget: privateEventBudget,
        artifact_budget_bytes: privateArtifactBudget,
      },
    };
    const mint = await post("/__s1/mint", mintRequest, {
      "idempotency-key": "local-mint-1",
    });
    if (mint.status !== 201) throw new Error("mint-status");
    const minted = (await mint.json()) as {
      enrollmentId?: unknown;
      secret?: unknown;
    };
    if (typeof minted.enrollmentId !== "string" || typeof minted.secret !== "string") {
      throw new Error("mint-shape");
    }
    const mintReplay = await post("/__s1/mint", mintRequest, {
      "idempotency-key": "local-mint-1",
    });
    const mintReplayBody = (await mintReplay.json()) as {
      enrollmentId?: unknown;
      secret?: unknown;
    };
    if (
      mintReplay.status !== 201 ||
      mintReplayBody.enrollmentId !== minted.enrollmentId ||
      mintReplayBody.secret !== minted.secret
    ) {
      throw new Error("mint-lost-response-replay");
    }
    completeCase("encrypted-idempotency-lost-response");

    const markdown = await localFetch(`${origin}/join/${minted.enrollmentId}`);
    const markdownBody = await markdown.text();
    const capsule = await localFetch(`${origin}/join/${minted.enrollmentId}`, {
      headers: { accept: "application/json" },
    });
    const capsuleJsonBody = await capsule.text();
    if (capsule.status !== 200) throw new Error("capsule-json-status");
    if (!capsule.headers.get("content-type")?.startsWith("application/json")) {
      throw new Error("capsule-json-content-type");
    }
    let capsuleBody: { enrollment_id?: unknown; claim?: { path?: unknown } };
    try {
      capsuleBody = JSON.parse(capsuleJsonBody) as typeof capsuleBody;
    } catch {
      throw new Error("capsule-json-parse");
    }
    const html = await localFetch(`${origin}/join/${minted.enrollmentId}`, {
      headers: { accept: "text/html" },
    });
    const htmlBody = await html.text();

    assertPlantedMintedSecretLeakIsRefused(minted.secret);
    assertPlantedPrivateAuthorityLeakIsRefused(privateDirective);
    const capsuleFaces = [
      ["markdown", markdownBody],
      ["json", capsuleJsonBody],
      ["html", htmlBody],
    ] as const;
    assertMintedSecretAbsentFromCapsuleFaces(capsuleFaces, minted.secret);
    assertSponsorAuthorityAbsentFromCapsuleFaces(capsuleFaces, [
      privateProblem,
      privateDirective,
      String(privateEventBudget),
      String(privateArtifactBudget),
      "requested_scopes",
      "requested_resources",
      "problem_binding",
      "first_directive",
      "event_budget",
      "artifact_budget_bytes",
    ]);

    if (markdown.status !== 200 || html.status !== 200) {
      throw new Error("capsule-face-status");
    }
    if (
      capsuleBody.enrollment_id !== minted.enrollmentId ||
      capsuleBody.claim?.path !== "/v1/fellows"
    ) {
      throw new Error("capsule-json");
    }
    completeCase("capsule-public-face-secret-boundary");
    completeCase("capsule-public-authority-redaction");
    completeCase("planted-minted-secret-leak-refusal");
    completeCase("planted-private-authority-leak-refusal");

    const plantedWrongSecret = await post(
      "/v1/fellows",
      {
        enrollment_id: minted.enrollmentId,
        secret: `v1.${"z".repeat(43)}`,
        name: "local-orchid",
        model: "local-model",
        harness: "codex",
      },
      { "idempotency-key": "local-wrong-secret-claim-1" },
    );
    const plantedWrongSecretBody = (await plantedWrongSecret.json()) as {
      code?: unknown;
    };
    if (plantedWrongSecret.status !== 400 || plantedWrongSecretBody.code !== "PAIRING_INVALID") {
      const safeCode =
        typeof plantedWrongSecretBody.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,39}$/.test(plantedWrongSecretBody.code)
          ? plantedWrongSecretBody.code
          : "INVALID_CODE";
      throw new Error(`wrong-secret-status-${plantedWrongSecret.status}-code-${safeCode}`);
    }
    completeCase("planted-wrong-secret-opaque-refusal");

    const malformedName = await post(
      "/v1/fellows",
      {
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name: "codex",
        model: "local-model",
        harness: "codex",
      },
      { "idempotency-key": "local-malformed-name-claim-1" },
    );
    const malformedNameBody = (await malformedName.json()) as {
      code?: unknown;
      suggestions?: unknown;
    };
    if (
      malformedName.status !== 422 ||
      malformedNameBody.code !== "MODEL_AS_NAME" ||
      !Array.isArray(malformedNameBody.suggestions) ||
      malformedNameBody.suggestions.length !== 3
    ) {
      const safeCode =
        typeof malformedNameBody.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,39}$/.test(malformedNameBody.code)
          ? malformedNameBody.code
          : "INVALID_CODE";
      const suggestionCount = Array.isArray(malformedNameBody.suggestions)
        ? malformedNameBody.suggestions.length
        : -1;
      throw new Error(
        `name-policy-status-${malformedName.status}-code-${safeCode}-suggestions-${suggestionCount}`,
      );
    }
    completeCase("name-policy");

    const claimRequest = {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "local-orchid",
      model: "local-model",
      harness: "codex",
    };
    const claim = await post("/v1/fellows", claimRequest, {
      "idempotency-key": "local-claim-1",
    });
    const claimBody = (await claim.json()) as { flow_handle?: unknown };
    if (claim.status !== 202 || typeof claimBody.flow_handle !== "string") {
      throw new Error("claim-shape");
    }
    const claimReplay = await post("/v1/fellows", claimRequest, {
      "idempotency-key": "local-claim-1",
    });
    const claimReplayBody = (await claimReplay.json()) as {
      flow_handle?: unknown;
    };
    if (claimReplay.status !== 202 || claimReplayBody.flow_handle !== claimBody.flow_handle) {
      throw new Error("claim-lost-response-replay");
    }
    const claimConflict = await post(
      "/v1/fellows",
      { ...claimRequest, name: "different-local-orchid" },
      { "idempotency-key": "local-claim-1" },
    );
    const claimConflictBody = (await claimConflict.json()) as {
      code?: unknown;
    };
    if (claimConflict.status !== 409 || claimConflictBody.code !== "IDEMPOTENCY_CONFLICT") {
      throw new Error("claim-idempotency-conflict");
    }
    completeCase("idempotency-digest-conflict");

    // A write with no replay key is refused before it can reach D1 — proven on a
    // *fresh, never-claimed* enrollment, and with the refusal ordered before the
    // first keyed claim.
    //
    // Order is the entire point. Running the missing-key attempt after a claim has
    // already succeeded is insensitive: the proposal exists either way, so a
    // replay returning the same flow handle is equally consistent with "the
    // rejected write did nothing" and "the rejected write did something the
    // idempotency layer then hid". On a fresh enrollment the two hypotheses
    // separate — if the refused attempt had written a proposal, the keyed claim
    // below could not come back as a fresh 202.
    const freshMint = await post(
      "/__s1/mint",
      { sponsor_id: sponsorId, request: { requested_scopes: ["review"] } },
      { "idempotency-key": "local-mint-nokey-1" },
    );
    if (freshMint.status !== 201) throw new Error("nokey-mint-status");
    const freshMinted = (await freshMint.json()) as { enrollmentId?: unknown; secret?: unknown };
    if (typeof freshMinted.enrollmentId !== "string" || typeof freshMinted.secret !== "string") {
      throw new Error("nokey-mint-shape");
    }
    const freshEnrollmentId = freshMinted.enrollmentId;
    const freshClaimRequest = {
      enrollment_id: freshEnrollmentId,
      secret: freshMinted.secret,
      name: "local-nokey-orchid",
      model: "local-model",
      harness: "codex",
    };

    // Bounded D1 postcondition, read through the sponsor's own approval card.
    // D1 deliberately joins through the proposal table, so a freshly minted
    // enrollment with no proposal has the same privacy-preserving card face as
    // an unknown enrollment: WRONG_PRINCIPAL. A successful claim then creates
    // the pending card. Validate each expected face independently before
    // comparing exact bytes; requiring pending on both sides would make every
    // fresh run fail before it ever exercised the missing-key refusal.
    const proposalState = async (expected: "absent" | "pending"): Promise<string> => {
      const card = await get("/__s1/card", {
        sponsor_id: sponsorId,
        enrollment_id: freshEnrollmentId,
      });
      const raw = await card.text();
      if (expected === "absent") {
        if (card.status !== 403) {
          const body = parseLocalJson(raw);
          const safeCode =
            typeof body === "object" &&
            body !== null &&
            !Array.isArray(body) &&
            "code" in body &&
            typeof body.code === "string" &&
            /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
              ? body.code.toLowerCase()
              : "invalid-code";
          throw new Error(
            `claim-missing-idempotency-key-absent-card-status-${card.status}-${safeCode}`,
          );
        }
        const body = parseLocalJson(raw);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new Error("claim-missing-idempotency-key-absent-card-shape");
        }
        if (!("code" in body) || body.code !== "WRONG_PRINCIPAL") {
          throw new Error("claim-missing-idempotency-key-absent-card-code");
        }
        return `${card.status}:${raw}`;
      }
      if (card.status !== 200) {
        throw new Error(`claim-missing-idempotency-key-pending-card-status-${card.status}`);
      }
      const body = parseLocalJson(raw);
      const localCard =
        typeof body === "object" && body !== null && !Array.isArray(body) && "card" in body
          ? body.card
          : undefined;
      if (typeof localCard !== "object" || localCard === null || Array.isArray(localCard)) {
        throw new Error("claim-missing-idempotency-key-pending-card-shape");
      }
      if (!("enrollmentId" in localCard) || localCard.enrollmentId !== freshEnrollmentId) {
        throw new Error("claim-missing-idempotency-key-pending-card-id");
      }
      if (!("status" in localCard) || localCard.status !== "pending") {
        throw new Error("claim-missing-idempotency-key-pending-card-status-value");
      }
      return `${card.status}:${raw}`;
    };

    const beforeRefusal = await proposalState("absent");
    const missingIdempotencyKey = await post("/v1/fellows", freshClaimRequest);
    const missingIdempotencyKeyBody = (await missingIdempotencyKey.json()) as { code?: unknown };
    if (
      missingIdempotencyKey.status !== 400 ||
      missingIdempotencyKeyBody.code !== "IDEMPOTENCY_KEY_INVALID"
    ) {
      throw new Error("claim-missing-idempotency-key");
    }
    const afterRefusal = await proposalState("absent");
    if (afterRefusal !== beforeRefusal) throw new Error("claim-missing-idempotency-key-wrote");

    // The keyed claim must now succeed as a *first* claim on this enrollment.
    const freshClaim = await post("/v1/fellows", freshClaimRequest, {
      "idempotency-key": "local-claim-nokey-1",
    });
    const freshClaimBody = (await freshClaim.json()) as { flow_handle?: unknown };
    if (freshClaim.status !== 202 || typeof freshClaimBody.flow_handle !== "string") {
      throw new Error("claim-missing-idempotency-key-blocked-fresh-claim");
    }
    // Causal closer: the card *does* move when a write really lands. Without
    // this, an approval card that never changed for any reason would make the
    // unchanged-state assertion above vacuous.
    if ((await proposalState("pending")) === beforeRefusal) {
      throw new Error("claim-missing-idempotency-key-postcondition-insensitive");
    }
    completeCase("claim-missing-idempotency-key-no-write");

    for (const enrollmentId of ["ASIMP-EN-7F3K9M2Q8R", minted.enrollmentId]) {
      const card = await get("/__s1/card", {
        sponsor_id: enrollmentId === minted.enrollmentId ? "wrong-local-sponsor" : sponsorId,
        enrollment_id: enrollmentId,
      });
      const cardBody = (await card.json()) as { code?: unknown };
      if (card.status !== 403 || cardBody.code !== "WRONG_PRINCIPAL") {
        throw new Error("approval-card-principal-boundary");
      }
    }
    completeCase("approval-card-principal-boundary");

    const pending = await post(
      "/v1/fellows/flow",
      { flow_handle: claimBody.flow_handle },
      { "idempotency-key": "local-poll-1" },
    );
    const pendingBody = (await pending.json()) as {
      status?: unknown;
      retry_after_seconds?: unknown;
    };
    if (
      pending.status !== 200 ||
      pendingBody.status !== "authorization_pending" ||
      pendingBody.retry_after_seconds !== 5
    ) {
      throw new Error("pending-flow");
    }
    completeCase("body-only-flow");

    const missingStepUp = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: minted.enrollmentId,
        decision: {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
        },
      },
      { "idempotency-key": "local-decision-1" },
    );
    const missingStepUpBody = (await missingStepUp.json()) as { code?: unknown };
    if (missingStepUp.status !== 400 || missingStepUpBody.code !== "DECISION_BODY_INVALID") {
      throw new Error("decision-step-up-command-required");
    }
    completeCase("decision-step-up-command-required");

    const approval = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: minted.enrollmentId,
        decision: {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-decision-1" },
    );
    await assertDecisionAcknowledged(approval, "approval-status");
    const approvalReplay = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: minted.enrollmentId,
        decision: {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-decision-1" },
    );
    await assertDecisionAcknowledged(approvalReplay, "decision-lost-response-replay");

    const approvedCard = await get("/__s1/card", {
      sponsor_id: sponsorId,
      enrollment_id: minted.enrollmentId,
    });
    const approvedCardBody = (await approvedCard.json()) as {
      card?: { status?: unknown; effectiveGrantedScopes?: unknown };
    };
    if (
      approvedCard.status !== 200 ||
      approvedCardBody.card?.status !== "approved" ||
      !Array.isArray(approvedCardBody.card.effectiveGrantedScopes)
    ) {
      throw new Error("durable-approval-grant");
    }
    completeCase("durable-approval-grant");

    const pollRequest = { flow_handle: claimBody.flow_handle };
    const [issued, issuedReplay] = await Promise.all([
      post("/v1/device-token", pollRequest, {
        "idempotency-key": "local-poll-1",
      }),
      post("/v1/device-token", pollRequest, {
        "idempotency-key": "local-poll-1",
      }),
    ]);
    const [issuedBody, issuedReplayBody] = (await Promise.all([
      issued.json(),
      issuedReplay.json(),
    ])) as [
      { status?: unknown; token?: unknown; hello_url?: unknown },
      { status?: unknown; token?: unknown; hello_url?: unknown },
    ];
    if (
      issued.status !== 200 ||
      issuedBody.status !== "approved" ||
      typeof issuedBody.token !== "string"
    ) {
      throw new Error("issued-shape");
    }
    if (
      issuedReplay.status !== 200 ||
      issuedReplayBody.status !== "approved" ||
      issuedReplayBody.token !== issuedBody.token
    ) {
      throw new Error("token-lost-response-replay");
    }
    completeCase("stable-poll-key-approval-transition");
    const issuedHelloUrl = approvedHelloUrl(issuedBody.hello_url, "issued-hello-url-origin");
    const expectedJoinHello = await readLocalHelloBinding(
      issuedBody.token,
      "join-hello-binding-proof-schema",
    );
    if (
      expectedJoinHello.fellow.name !== "local-orchid" ||
      expectedJoinHello.fellow.model !== "local-model" ||
      expectedJoinHello.fellow.harness !== "codex" ||
      JSON.stringify(expectedJoinHello.granted_scopes) !== JSON.stringify(["review"]) ||
      JSON.stringify(expectedJoinHello.granted_resources) !==
        JSON.stringify({
          problem_binding: privateProblem,
          first_directive: privateDirective,
          event_budget: privateEventBudget,
          artifact_budget_bytes: privateArtifactBudget,
        })
    ) {
      throw new Error("join-hello-binding-proof-content");
    }

    const hello = await localFetch(issuedHelloUrl, {
      headers: { authorization: `Bearer ${issuedBody.token}` },
    });
    // Read the bytes once and parse from them. The echo check has to see the
    // response as it was actually written, not a re-serialization of the parsed
    // object, or a leak in a field this driver does not model would be invisible.
    const helloBody = await readCanonicalHello(
      hello,
      issuedBody.token,
      "hello-schema",
      "hello-token-echo",
    );
    assertExactHelloBinding(helloBody, expectedJoinHello, "hello-binding");

    // The first safe read, driven from hello's real `next_actions` rather than a
    // path this client already knew. That is the whole point: the URL under test
    // is the one the Worker composed from its trusted `STOA_ORIGIN` binding, so a
    // misconfigured or attacker-influenced origin shows up here as a refusal
    // instead of as a bearer sent somewhere it does not belong.
    const firstReadUrl = firstSafeReadUrl(helloBody, origin);
    // Sent with no Authorization header at all, not merely a different one:
    // reads are free (Rule A5), and a first action that needed the bearer would
    // not be a safe first action. `localFetch` adds no default headers, so the
    // absence below is the whole request, and the assertions after it prove the
    // read succeeded *without* credentials rather than in spite of them.
    const firstRead = await localFetch(firstReadUrl);
    const firstReadText = await firstRead.text();
    if (bodyEchoesBearer(firstReadText, issuedBody.token)) {
      throw new Error("first-read-token-echo");
    }
    // A successful canonical public read, served by the production
    // `servePublicText` route table under local Workerd. Anything less — a 404,
    // an empty body, an HTML error face — would mean the Fellow's first action
    // does not actually work, which is the thing S-1 exists to prove.
    if (firstRead.status !== 200) throw new Error("first-read-status");
    if (firstRead.headers.get("content-type") !== "text/markdown; charset=utf-8") {
      throw new Error("first-read-content-type");
    }
    if (firstReadText.trim().length === 0) throw new Error("first-read-empty");
    completeCase("approve-token-hello-binding");
    completeCase("authenticated-private-authority-recovery");
    completeCase("hello-and-first-read-bearer-echo-refusal");
    completeCase("hello-next-action-canonical-first-safe-read");

    // Drive the unaffiliated agent's actual mounted ingress through local
    // Workerd and D1. Sponsor operations remain the harness's narrow local
    // stand-in for Agora's signed envelope; the browser/cross-plane boundary
    // is intentionally outside this local proof.
    const mountedDeviceInput = {
      name: "mounted-device-orchid",
      model: "local-mounted-model",
      harness: "codex",
      requested_scopes: ["promote", "review"],
    } as const;
    const mountedDeviceBefore = await readDeviceCounts();
    const mountedDeviceStart = await startDevice(
      "198.51.100.35",
      mountedDeviceInput,
      "local-mounted-device-start-1",
    );
    const mountedDeviceStartRaw = await mountedDeviceStart.text();
    const mountedDeviceStartBody = DeviceCodeStartResponseSchema.safeParse(
      parseLocalJson(mountedDeviceStartRaw),
    );
    if (mountedDeviceStart.status !== 201 || !mountedDeviceStartBody.success) {
      throw new Error("mounted-device-ingress-start");
    }
    const mountedDeviceReplay = await startDevice(
      "198.51.100.35",
      mountedDeviceInput,
      "local-mounted-device-start-1",
    );
    const mountedDeviceReplayRaw = await mountedDeviceReplay.text();
    const mountedDeviceReplayBody = DeviceCodeStartResponseSchema.safeParse(
      parseLocalJson(mountedDeviceReplayRaw),
    );
    if (
      mountedDeviceReplay.status !== 201 ||
      !mountedDeviceReplayBody.success ||
      mountedDeviceReplayRaw !== mountedDeviceStartRaw
    ) {
      throw new Error("mounted-device-ingress-replay");
    }
    const mountedDeviceConflict = await startDevice(
      "198.51.100.35",
      { ...mountedDeviceInput, name: "mounted-device-conflict" },
      "local-mounted-device-start-1",
    );
    const mountedDeviceConflictBody = (await mountedDeviceConflict.json()) as { code?: unknown };
    if (
      mountedDeviceConflict.status !== 409 ||
      mountedDeviceConflictBody.code !== "IDEMPOTENCY_CONFLICT"
    ) {
      throw new Error("mounted-device-ingress-conflict");
    }
    assertCountDelta(
      mountedDeviceBefore,
      await readDeviceCounts(),
      1,
      "mounted-device-ingress-counts",
    );
    completeCase("mounted-device-ingress-exact-replay-conflict");

    const mountedDevicePending = await post(
      "/v1/device-token",
      { flow_handle: mountedDeviceStartBody.data.device_code },
      { "idempotency-key": "local-mounted-device-poll-1" },
    );
    const mountedDevicePendingBody = (await mountedDevicePending.json()) as {
      status?: unknown;
      retry_after_seconds?: unknown;
    };
    if (
      mountedDevicePending.status !== 200 ||
      mountedDevicePendingBody.status !== "authorization_pending" ||
      mountedDevicePendingBody.retry_after_seconds !== 5
    ) {
      throw new Error("mounted-device-pending");
    }
    const mountedDeviceSlowDown = await post(
      "/v1/device-token",
      { flow_handle: mountedDeviceStartBody.data.device_code },
      { "idempotency-key": "local-mounted-device-poll-1" },
    );
    const mountedDeviceSlowDownBody = (await mountedDeviceSlowDown.json()) as {
      status?: unknown;
      retry_after_seconds?: unknown;
    };
    if (
      mountedDeviceSlowDown.status !== 200 ||
      mountedDeviceSlowDownBody.status !== "slow_down" ||
      typeof mountedDeviceSlowDownBody.retry_after_seconds !== "number" ||
      mountedDeviceSlowDownBody.retry_after_seconds <= mountedDevicePendingBody.retry_after_seconds
    ) {
      throw new Error("mounted-device-slow-down");
    }
    completeCase("mounted-device-pre-decision-slow-down");
    const mountedDeviceLookup = await post("/__s1/device-lookup", {
      sponsor_id: sponsorId,
      user_code: mountedDeviceStartBody.data.user_code,
    });
    const mountedDeviceLookupBody = (await mountedDeviceLookup.json()) as {
      card?: {
        enrollmentId?: unknown;
        name?: unknown;
        model?: unknown;
        harness?: unknown;
        requestedScopes?: unknown;
      };
    };
    const mountedDeviceCard = mountedDeviceLookupBody.card;
    if (
      mountedDeviceLookup.status !== 200 ||
      typeof mountedDeviceCard?.enrollmentId !== "string" ||
      mountedDeviceCard.name !== mountedDeviceInput.name ||
      mountedDeviceCard.model !== mountedDeviceInput.model ||
      mountedDeviceCard.harness !== mountedDeviceInput.harness ||
      JSON.stringify(mountedDeviceCard.requestedScopes) !==
        JSON.stringify(mountedDeviceInput.requested_scopes)
    ) {
      throw new Error("mounted-device-complete-approval-card");
    }
    const mountedDeviceDecision = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: mountedDeviceCard.enrollmentId,
        decision: {
          enrollment_id: mountedDeviceCard.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-mounted-device-decision-1" },
    );
    await assertDecisionAcknowledged(mountedDeviceDecision, "mounted-device-approval");
    const mountedDeviceSecondSponsorDecision = await post(
      "/__s1/approve",
      {
        sponsor_id: "usr_local_second_sponsor_s1",
        enrollment_id: mountedDeviceCard.enrollmentId,
        decision: {
          enrollment_id: mountedDeviceCard.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-mounted-device-second-sponsor-decision-1" },
    );
    const mountedDeviceSecondSponsorBody = (await mountedDeviceSecondSponsorDecision.json()) as {
      code?: unknown;
      token?: unknown;
    };
    if (
      mountedDeviceSecondSponsorDecision.status !== 403 ||
      mountedDeviceSecondSponsorBody.code !== "WRONG_PRINCIPAL" ||
      mountedDeviceSecondSponsorBody.token !== undefined
    ) {
      throw new Error("mounted-device-second-sponsor-wrong-principal");
    }
    const [mountedDeviceIssued, mountedDeviceIssuedReplay] = await Promise.all([
      post(
        "/v1/device-token",
        { flow_handle: mountedDeviceStartBody.data.device_code },
        { "idempotency-key": "local-mounted-device-poll-1" },
      ),
      post(
        "/v1/device-token",
        { flow_handle: mountedDeviceStartBody.data.device_code },
        { "idempotency-key": "local-mounted-device-poll-1" },
      ),
    ]);
    const [mountedDeviceIssuedRaw, mountedDeviceIssuedReplayRaw] = await Promise.all([
      mountedDeviceIssued.text(),
      mountedDeviceIssuedReplay.text(),
    ]);
    if (mountedDeviceIssuedReplayRaw !== mountedDeviceIssuedRaw) {
      throw new Error("mounted-device-token-replay-bytes");
    }
    const mountedDeviceIssuedBody = parseLocalJson(mountedDeviceIssuedRaw) as {
      status?: unknown;
      token?: unknown;
      hello_url?: unknown;
    };
    const mountedDeviceIssuedReplayBody = parseLocalJson(mountedDeviceIssuedReplayRaw) as {
      status?: unknown;
      token?: unknown;
    };
    if (
      mountedDeviceIssued.status !== 200 ||
      mountedDeviceIssuedReplay.status !== 200 ||
      mountedDeviceIssuedBody.status !== "approved" ||
      typeof mountedDeviceIssuedBody.token !== "string" ||
      mountedDeviceIssuedReplayBody.status !== "approved" ||
      mountedDeviceIssuedReplayBody.token !== mountedDeviceIssuedBody.token
    ) {
      throw new Error("mounted-device-token-replay");
    }
    const mountedDeviceHelloUrl = approvedHelloUrl(
      mountedDeviceIssuedBody.hello_url,
      "mounted-device-hello-url-origin",
    );
    const expectedMountedDeviceHello = await readLocalHelloBinding(
      mountedDeviceIssuedBody.token,
      "mounted-device-hello-binding-proof-schema",
    );
    if (
      expectedMountedDeviceHello.fellow.name !== mountedDeviceInput.name ||
      expectedMountedDeviceHello.fellow.model !== mountedDeviceInput.model ||
      expectedMountedDeviceHello.fellow.harness !== mountedDeviceInput.harness ||
      JSON.stringify(expectedMountedDeviceHello.granted_scopes) !==
        JSON.stringify(mountedDeviceInput.requested_scopes) ||
      Object.keys(expectedMountedDeviceHello.granted_resources).length !== 0
    ) {
      throw new Error("mounted-device-hello-binding-proof-content");
    }
    const mountedDeviceHello = await localFetch(mountedDeviceHelloUrl, {
      headers: { authorization: `Bearer ${mountedDeviceIssuedBody.token}` },
    });
    const mountedDeviceHelloBody = await readCanonicalHello(
      mountedDeviceHello,
      mountedDeviceIssuedBody.token,
      "mounted-device-hello-schema",
      "mounted-device-hello-token-echo",
    );
    assertExactHelloBinding(
      mountedDeviceHelloBody,
      expectedMountedDeviceHello,
      "mounted-device-hello",
    );
    completeCase("mounted-device-complete-card-approve-token-hello");
    completeCase("mounted-device-second-sponsor-wrong-principal");

    const raceMint = await post(
      "/__s1/mint",
      {
        sponsor_id: sponsorId,
        request: { requested_scopes: ["review"] },
      },
      { "idempotency-key": "local-race-mint-1" },
    );
    const raceMintBody = (await raceMint.json()) as {
      enrollmentId?: unknown;
      secret?: unknown;
    };
    if (
      raceMint.status !== 201 ||
      typeof raceMintBody.enrollmentId !== "string" ||
      typeof raceMintBody.secret !== "string"
    ) {
      throw new Error("race-mint-shape");
    }
    const raceClaimRequest = {
      enrollment_id: raceMintBody.enrollmentId,
      secret: raceMintBody.secret,
      name: "race-local-orchid",
      model: "local-model",
      harness: "codex",
    };
    const [raceLeft, raceRight] = await Promise.all([
      post("/v1/fellows", raceClaimRequest, {
        "idempotency-key": "local-claim-race-1",
      }),
      post("/v1/fellows", raceClaimRequest, {
        "idempotency-key": "local-claim-race-1",
      }),
    ]);
    const raceBodies = (await Promise.all([raceLeft.json(), raceRight.json()])) as Array<{
      flow_handle?: unknown;
    }>;
    if (
      raceLeft.status !== 202 ||
      raceRight.status !== 202 ||
      typeof raceBodies[0]?.flow_handle !== "string" ||
      raceBodies[0]?.flow_handle !== raceBodies[1]?.flow_handle
    ) {
      throw new Error("concurrent-first-claim-replay");
    }
    completeCase("concurrent-first-claim-replay");

    // This approval collides with the immutable Fellow name already bound
    // above. The following deny deliberately reuses its key with a different
    // digest: it succeeds only if the failed D1 batch rolled back both the
    // grant effect and its idempotency insert.
    const rollbackMint = await post(
      "/__s1/mint",
      {
        sponsor_id: sponsorId,
        request: { requested_scopes: ["review"] },
      },
      { "idempotency-key": "local-rollback-mint-1" },
    );
    const rollbackMintBody = (await rollbackMint.json()) as {
      enrollmentId?: unknown;
      secret?: unknown;
    };
    if (
      rollbackMint.status !== 201 ||
      typeof rollbackMintBody.enrollmentId !== "string" ||
      typeof rollbackMintBody.secret !== "string"
    ) {
      throw new Error("rollback-mint-shape");
    }
    const rollbackClaim = await post(
      "/v1/fellows",
      {
        enrollment_id: rollbackMintBody.enrollmentId,
        secret: rollbackMintBody.secret,
        name: "local-orchid",
        model: "local-model",
        harness: "codex",
      },
      { "idempotency-key": "local-rollback-claim-1" },
    );
    if (rollbackClaim.status !== 202) throw new Error("rollback-claim-shape");
    const rollbackClaimBody = (await rollbackClaim.json()) as {
      flow_handle?: unknown;
    };
    if (typeof rollbackClaimBody.flow_handle !== "string") {
      throw new Error("rollback-claim-flow-shape");
    }
    const rollbackPending = await post(
      "/v1/fellows/flow",
      { flow_handle: rollbackClaimBody.flow_handle },
      { "idempotency-key": "local-rollback-poll-1" },
    );
    const rollbackPendingBody = (await rollbackPending.json()) as {
      status?: unknown;
    };
    if (rollbackPending.status !== 200 || rollbackPendingBody.status !== "authorization_pending") {
      throw new Error("rollback-pending-poll");
    }
    const failedApproval = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: rollbackMintBody.enrollmentId,
        decision: {
          enrollment_id: rollbackMintBody.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-decision-rollback-1" },
    );
    const failedApprovalBody = (await failedApproval.json()) as {
      code?: unknown;
    };
    if (failedApproval.status !== 400 || failedApprovalBody.code !== "NAME_TAKEN") {
      throw new Error(
        failedApproval.status === 503
          ? "rollback-decision-operational-failure"
          : "rollback-decision-unexpected-result",
      );
    }
    const recoveredDeny = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: rollbackMintBody.enrollmentId,
        decision: {
          enrollment_id: rollbackMintBody.enrollmentId,
          decision: "deny",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-decision-rollback-1" },
    );
    await assertDecisionAcknowledged(recoveredDeny, "rollback-key-poisoned");
    const rollbackDenied = await post(
      "/v1/fellows/flow",
      { flow_handle: rollbackClaimBody.flow_handle },
      { "idempotency-key": "local-rollback-poll-1" },
    );
    const rollbackDeniedBody = (await rollbackDenied.json()) as {
      status?: unknown;
    };
    if (rollbackDenied.status !== 200 || rollbackDeniedBody.status !== "access_denied") {
      throw new Error("stable-poll-key-denial-transition");
    }
    completeCase("failed-batch-does-not-poison-key");
    completeCase("stable-poll-key-denial-transition");

    // Real Workerd/D1 proof for the sponsor-owned rolling-day budget. Fill the
    // remaining slots from the durable facts already created above, replay the
    // final successful mint exactly, then prove a distinct key is refused
    // without creating an eleventh fact.
    const sponsorCountsBeforeFill = await readSponsorEnrollmentCounts();
    const occupiedBeforeFill =
      sponsorCountsBeforeFill.join_attempts + sponsorCountsBeforeFill.device_attempts;
    if (occupiedBeforeFill < 1 || occupiedBeforeFill >= SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS) {
      throw new Error("sponsor-enrollment-budget-precondition");
    }
    let finalFillRequest: Record<string, unknown> = mintRequest;
    let finalFillKey = "local-mint-1";
    let finalFillBody: unknown = minted;
    for (
      let ordinal = occupiedBeforeFill;
      ordinal < SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS - 1;
      ordinal += 1
    ) {
      const request = {
        sponsor_id: sponsorId,
        request: { requested_scopes: ["review"] },
      };
      const key = `local-sponsor-rate-fill-${ordinal}`;
      const result = await post("/__s1/mint", request, { "idempotency-key": key });
      const body = await result.json();
      if (result.status !== 201) throw new Error("sponsor-enrollment-budget-fill");
      finalFillRequest = request;
      finalFillKey = key;
      finalFillBody = body;
    }
    const finalFillReplay = await post("/__s1/mint", finalFillRequest, {
      "idempotency-key": finalFillKey,
    });
    const finalFillReplayBody = await finalFillReplay.json();
    if (
      finalFillReplay.status !== 201 ||
      JSON.stringify(finalFillReplayBody) !== JSON.stringify(finalFillBody)
    ) {
      throw new Error("sponsor-enrollment-budget-final-replay");
    }
    const finalDeviceStart = await startDevice(
      "198.51.100.39",
      deviceStartBody("local-sponsor-rate-final-device"),
      "local-sponsor-rate-final-device-start",
    );
    const finalDeviceStartBody = DeviceCodeStartResponseSchema.safeParse(
      await finalDeviceStart.json(),
    );
    if (finalDeviceStart.status !== 201 || !finalDeviceStartBody.success) {
      throw new Error("sponsor-enrollment-budget-device-start");
    }
    const finalDeviceLookup = await post("/__s1/device-lookup", {
      sponsor_id: sponsorId,
      user_code: finalDeviceStartBody.data.user_code,
    });
    const finalDeviceLookupBody = (await finalDeviceLookup.json()) as {
      card?: { enrollmentId?: unknown };
    };
    if (
      finalDeviceLookup.status !== 200 ||
      typeof finalDeviceLookupBody.card?.enrollmentId !== "string"
    ) {
      throw new Error("sponsor-enrollment-budget-device-lookup");
    }
    const finalDeviceDecision = {
      sponsor_id: sponsorId,
      enrollment_id: finalDeviceLookupBody.card.enrollmentId,
      decision: {
        enrollment_id: finalDeviceLookupBody.card.enrollmentId,
        decision: "approve",
        step_up_authenticated_at: decisionStepUpAuthenticatedAt,
      },
    };
    const finalDeviceApproval = await post("/__s1/approve", finalDeviceDecision, {
      "idempotency-key": "local-sponsor-rate-final-device-decision",
    });
    await assertDecisionAcknowledged(
      finalDeviceApproval,
      "sponsor-enrollment-budget-device-approval",
    );
    const finalDeviceApprovalReplay = await post("/__s1/approve", finalDeviceDecision, {
      "idempotency-key": "local-sponsor-rate-final-device-decision",
    });
    await assertDecisionAcknowledged(
      finalDeviceApprovalReplay,
      "sponsor-enrollment-budget-device-replay",
    );
    const sponsorRateRefusal = await post(
      "/__s1/mint",
      { sponsor_id: sponsorId, request: { requested_scopes: ["review"] } },
      { "idempotency-key": "local-sponsor-rate-refusal" },
    );
    const sponsorRateRefusalBody = (await sponsorRateRefusal.json()) as { code?: unknown };
    if (
      sponsorRateRefusal.status !== 429 ||
      sponsorRateRefusalBody.code !== "SPONSOR_ENROLLMENT_RATE_LIMITED"
    ) {
      throw new Error("sponsor-enrollment-budget-refusal");
    }
    const sponsorCountsAfterRefusal = await readSponsorEnrollmentCounts();
    if (
      sponsorCountsAfterRefusal.join_attempts + sponsorCountsAfterRefusal.device_attempts !==
      SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS
    ) {
      throw new Error("sponsor-enrollment-budget-refusal-count");
    }
    completeCase("sponsor-enrollment-rolling-day-budget");

    // Real Workerd/D1 concurrency proof: eleven independently keyed requests
    // arrive together at a fresh source. Exactly ten may commit, and the
    // refused request must not consume a product row, rate slot, or replay row.
    const beforeDistinctStarts = await readDeviceCounts();
    const distinctStartResponses = await Promise.all(
      Array.from({ length: 11 }, (_unused, index) =>
        startDevice(
          "198.51.100.40",
          deviceStartBody(`local-device-distinct-${String(index).padStart(2, "0")}`),
          `local-device-distinct-${String(index).padStart(2, "0")}`,
        ),
      ),
    );
    const distinctStartBodies = await Promise.all(
      distinctStartResponses.map((result) => result.json() as Promise<unknown>),
    );
    const distinctSuccesses = distinctStartResponses
      .map((result, index) => ({ result, body: distinctStartBodies[index] }))
      .filter(({ result }) => result.status === 201);
    const distinctRefusals = distinctStartResponses
      .map((result, index) => ({ result, body: distinctStartBodies[index] }))
      .filter(
        ({ result, body }) =>
          result.status === 429 &&
          typeof body === "object" &&
          body !== null &&
          "code" in body &&
          body.code === "DEVICE_START_RATE_LIMITED",
      );
    if (
      distinctSuccesses.length !== 10 ||
      distinctRefusals.length !== 1 ||
      distinctSuccesses.some(({ body }) => !DeviceCodeStartResponseSchema.safeParse(body).success)
    ) {
      throw new Error("concurrent-device-start-source-limit");
    }
    assertCountDelta(
      beforeDistinctStarts,
      await readDeviceCounts(),
      10,
      "concurrent-device-start-source-limit-counts",
    );
    completeCase("concurrent-device-start-source-limit");

    // At the ninth occupied slot, two simultaneous identical requests share
    // one key and body. Both callers must receive the exact same successful
    // representation while only one tenth product/rate/replay triple commits.
    const beforeReplayBoundary = await readDeviceCounts();
    const boundaryAddress = "198.51.100.41";
    const boundaryFillResponses = await Promise.all(
      Array.from({ length: 9 }, (_unused, index) =>
        startDevice(
          boundaryAddress,
          deviceStartBody(`local-device-boundary-${String(index).padStart(2, "0")}`),
          `local-device-boundary-${String(index).padStart(2, "0")}`,
        ),
      ),
    );
    if (boundaryFillResponses.some((result) => result.status !== 201)) {
      throw new Error("concurrent-device-start-boundary-fill");
    }
    const boundaryBody = deviceStartBody("local-device-boundary-final");
    const [boundaryLeft, boundaryRight] = await Promise.all([
      startDevice(boundaryAddress, boundaryBody, "local-device-boundary-final"),
      startDevice(boundaryAddress, boundaryBody, "local-device-boundary-final"),
    ]);
    const [boundaryLeftBody, boundaryRightBody] = await Promise.all([
      boundaryLeft.json(),
      boundaryRight.json(),
    ]);
    const boundaryLeftParsed = DeviceCodeStartResponseSchema.safeParse(boundaryLeftBody);
    const boundaryRightParsed = DeviceCodeStartResponseSchema.safeParse(boundaryRightBody);
    if (
      boundaryLeft.status !== 201 ||
      boundaryRight.status !== 201 ||
      !boundaryLeftParsed.success ||
      !boundaryRightParsed.success ||
      JSON.stringify(boundaryLeftParsed.data) !== JSON.stringify(boundaryRightParsed.data)
    ) {
      throw new Error("concurrent-device-start-final-slot-replay");
    }
    assertCountDelta(
      beforeReplayBoundary,
      await readDeviceCounts(),
      10,
      "concurrent-device-start-final-slot-replay-counts",
    );
    completeCase("concurrent-device-start-final-slot-replay");

    const expiryStart = await startDevice(
      "198.51.100.42",
      deviceStartBody("local-device-stable-poll-expire"),
      "local-device-stable-poll-expire",
    );
    const expiryStartBody = DeviceCodeStartResponseSchema.safeParse(await expiryStart.json());
    if (expiryStart.status !== 201 || !expiryStartBody.success) {
      throw new Error("stable-poll-key-expiry-start");
    }
    const expiryLookup = await post("/__s1/device-lookup", {
      sponsor_id: sponsorId,
      user_code: expiryStartBody.data.user_code,
    });
    const expiryLookupBody = (await expiryLookup.json()) as {
      card?: { enrollmentId?: unknown };
    };
    if (expiryLookup.status !== 200 || typeof expiryLookupBody.card?.enrollmentId !== "string") {
      throw new Error("stable-poll-key-expiry-card");
    }
    const expiryPollRequest = { flow_handle: expiryStartBody.data.device_code };
    const expiryPending = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const expiryPendingBody = (await expiryPending.json()) as {
      status?: unknown;
    };
    if (expiryPending.status !== 200 || expiryPendingBody.status !== "authorization_pending") {
      throw new Error("stable-poll-key-expiry-pending");
    }
    const advanced = await post("/__s1/advance-device-ttl", {});
    if (advanced.status !== 200) throw new Error("stable-poll-key-clock-advance");
    const expiryLookupAfterDeviceTtl = await post("/__s1/device-lookup", {
      sponsor_id: sponsorId,
      user_code: expiryStartBody.data.user_code,
    });
    const expiryLookupAfterDeviceTtlBody = (await expiryLookupAfterDeviceTtl.json()) as {
      code?: unknown;
      token?: unknown;
    };
    if (
      expiryLookupAfterDeviceTtl.status !== 400 ||
      expiryLookupAfterDeviceTtlBody.code !== "DEVICE_CODE_UNKNOWN" ||
      expiryLookupAfterDeviceTtlBody.token !== undefined
    ) {
      throw new Error("stable-poll-key-device-expiry-lookup-refusal");
    }
    const freshDeviceExpiryStepUpAuthenticatedAt = Math.floor(
      (Date.now() + DEVICE_CODE_TTL_MS) / 1_000,
    );
    const expiryDecisionAfterDeviceTtl = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: expiryLookupBody.card.enrollmentId,
        decision: {
          enrollment_id: expiryLookupBody.card.enrollmentId,
          decision: "approve",
          // This is fresh at the harness's exact 30-minute local clock, so
          // the refusal below reaches the expired device authority boundary.
          step_up_authenticated_at: freshDeviceExpiryStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-device-expiry-decision-after-ttl-1" },
    );
    const expiryDecisionAfterDeviceTtlBody = (await expiryDecisionAfterDeviceTtl.json()) as {
      code?: unknown;
      token?: unknown;
    };
    if (
      expiryDecisionAfterDeviceTtl.status !== 403 ||
      expiryDecisionAfterDeviceTtlBody.code !== "WRONG_PRINCIPAL" ||
      expiryDecisionAfterDeviceTtlBody.token !== undefined
    ) {
      throw new Error("stable-poll-key-device-expiry-decision-refusal");
    }
    // The original approved command still replays exactly after its step-up
    // timestamp ages out. This is distinct from the fresh-step-up device
    // refusal above, which must reach the authority boundary rather than fail
    // only on stale authentication evidence.
    const expiredStepUpReplay = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: minted.enrollmentId,
        decision: {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: decisionStepUpAuthenticatedAt,
        },
      },
      { "idempotency-key": "local-decision-1" },
    );
    await assertDecisionAcknowledged(expiredStepUpReplay, "decision-replay-after-step-up-expiry");
    const expiryTerminal = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const expiryTerminalBody = (await expiryTerminal.json()) as {
      status?: unknown;
    };
    if (expiryTerminal.status !== 200 || expiryTerminalBody.status !== "expired_token") {
      throw new Error("stable-poll-key-expiry-transition");
    }
    completeCase("stable-poll-key-30m-expiry-transition");
    completeCase("stable-poll-key-30m-lookup-decision-refusal");
    completeCase("decision-replay-after-step-up-expiry");
    const proposalPendingProof = await post("/__s1/local-only/poll-terminal-proof", {
      flow_handle: expiryStartBody.data.device_code,
      idempotency_key: "local-device-expiry-poll-1",
    });
    const proposalPendingProofBody = (await proposalPendingProof.json()) as {
      proposal_status?: unknown;
      terminal_poll_replay_rows?: unknown;
    };
    if (
      proposalPendingProof.status !== 200 ||
      proposalPendingProofBody.proposal_status !== "pending" ||
      proposalPendingProofBody.terminal_poll_replay_rows !== 0
    ) {
      throw new Error("stable-poll-key-proposal-expiry-pending-precondition");
    }
    const proposalAdvanced = await post("/__s1/advance-proposal-ttl", {});
    if (proposalAdvanced.status !== 200) throw new Error("proposal-expiry-clock-advance");
    const proposalExpiryTerminal = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const proposalExpiryTerminalRaw = await proposalExpiryTerminal.text();
    const proposalExpiryTerminalBody = parseLocalJson(proposalExpiryTerminalRaw) as {
      status?: unknown;
    };
    if (
      proposalExpiryTerminal.status !== 200 ||
      proposalExpiryTerminalBody.status !== "expired_token"
    ) {
      throw new Error("stable-poll-key-proposal-expiry-transition");
    }
    completeCase("stable-poll-key-24h-proposal-expiry-transition");
    const proposalExpiryProof = await post("/__s1/local-only/poll-terminal-proof", {
      flow_handle: expiryStartBody.data.device_code,
      idempotency_key: "local-device-expiry-poll-1",
    });
    const proposalExpiryProofBody = (await proposalExpiryProof.json()) as {
      proposal_status?: unknown;
      terminal_poll_replay_rows?: unknown;
    };
    if (
      proposalExpiryProof.status !== 200 ||
      proposalExpiryProofBody.proposal_status !== "expired" ||
      proposalExpiryProofBody.terminal_poll_replay_rows !== 1
    ) {
      throw new Error("stable-poll-key-proposal-expiry-durable-state");
    }
    const proposalExpiryReplay = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const proposalExpiryReplayRaw = await proposalExpiryReplay.text();
    if (proposalExpiryReplayRaw !== proposalExpiryTerminalRaw) {
      throw new Error("stable-poll-key-proposal-expiry-replay-bytes");
    }
    const proposalExpiryReplayBody = parseLocalJson(proposalExpiryReplayRaw) as {
      status?: unknown;
    };
    if (
      proposalExpiryReplay.status !== 200 ||
      proposalExpiryReplayBody.status !== proposalExpiryTerminalBody.status
    ) {
      throw new Error("stable-poll-key-proposal-expiry-replay");
    }
    const proposalExpiryReplayProof = await post("/__s1/local-only/poll-terminal-proof", {
      flow_handle: expiryStartBody.data.device_code,
      idempotency_key: "local-device-expiry-poll-1",
    });
    const proposalExpiryReplayProofBody = (await proposalExpiryReplayProof.json()) as {
      proposal_status?: unknown;
      terminal_poll_replay_rows?: unknown;
    };
    if (
      proposalExpiryReplayProof.status !== 200 ||
      proposalExpiryReplayProofBody.proposal_status !== "expired" ||
      proposalExpiryReplayProofBody.terminal_poll_replay_rows !== 1
    ) {
      throw new Error("stable-poll-key-proposal-expiry-replay-row-count");
    }
    completeCase("stable-poll-key-24h-proposal-expiry-durable-state");

    // Real Workerd/D1 cap boundary: exactly three live seeded credentials make
    // the mounted production poll fail atomically; expiry then frees one slot.
    const capStart = await startDevice(
      "198.51.100.43",
      deviceStartBody("local-cap-fellow"),
      "local-device-cap-start-1",
    );
    const capStartBody = DeviceCodeStartResponseSchema.safeParse(await capStart.json());
    if (capStart.status !== 201 || !capStartBody.success) throw new Error("cap-device-start");
    const capLookup = await post("/__s1/device-lookup", {
      sponsor_id: sponsorId,
      user_code: capStartBody.data.user_code,
    });
    const capLookupBody = (await capLookup.json()) as { card?: { enrollmentId?: unknown } };
    if (capLookup.status !== 200 || typeof capLookupBody.card?.enrollmentId !== "string") {
      throw new Error("cap-device-lookup");
    }
    const capEnrollmentId = capLookupBody.card.enrollmentId;
    const capDecision = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: capEnrollmentId,
        decision: {
          enrollment_id: capEnrollmentId,
          decision: "approve",
          step_up_authenticated_at: Math.floor((Date.now() + PENDING_PROPOSAL_TTL_MS) / 1_000),
        },
      },
      { "idempotency-key": "local-device-cap-decision-1" },
    );
    await assertDecisionAcknowledged(capDecision, "cap-approve");

    const capSeed = await post("/__s1/local-only/credential-cap-seed", {
      flow_handle: capStartBody.data.device_code,
    });
    const capSeedBody = parseLocalJson(await capSeed.text()) as {
      seeded?: unknown;
      active?: unknown;
    };
    if (capSeed.status !== 200 || capSeedBody.seeded !== 3 || capSeedBody.active !== 3) {
      throw new Error("cap-seed-boundary");
    }

    const capRefusalKey = "local-device-cap-poll-refusal-1";
    const capProof = async (idempotencyKey: string) => {
      const proof = await post("/__s1/local-only/credential-cap-proof", {
        flow_handle: capStartBody.data.device_code,
        idempotency_key: idempotencyKey,
      });
      const body = parseLocalJson(await proof.text()) as {
        proposal_status?: unknown;
        proposal_has_token?: unknown;
        credentials_total?: unknown;
        credentials_from_proposal?: unknown;
        credentials_expiring_at_now?: unknown;
        poll_replay_rows?: unknown;
      };
      if (proof.status !== 200) throw new Error("cap-proof-status");
      return body;
    };
    const capBefore = await capProof(capRefusalKey);
    if (
      capBefore.proposal_status !== "approved" ||
      capBefore.proposal_has_token !== 0 ||
      capBefore.credentials_total !== 3 ||
      capBefore.credentials_from_proposal !== 0 ||
      capBefore.credentials_expiring_at_now !== 0 ||
      capBefore.poll_replay_rows !== 0
    ) {
      throw new Error("cap-precondition");
    }

    const capRefused = await post(
      "/v1/device-token",
      { flow_handle: capStartBody.data.device_code },
      { "idempotency-key": capRefusalKey },
    );
    const capRefusedRaw = await capRefused.text();
    const capRefusedBody = parseLocalJson(capRefusedRaw) as { code?: unknown; status?: unknown };
    if (
      capRefused.status !== 409 ||
      capRefusedBody.code !== "FELLOW_CREDENTIAL_CAP_REACHED" ||
      capRefusedBody.status !== 409 ||
      capRefused.headers.get("cache-control") !== "private, no-store"
    ) {
      throw new Error("cap-refusal-face");
    }
    if (
      capRefusedRaw.includes("active credential cap reached") ||
      capRefusedRaw.includes(capStartBody.data.device_code)
    ) {
      throw new Error("cap-refusal-opacity");
    }
    const capAfterRefusal = await capProof(capRefusalKey);
    if (
      JSON.stringify(capAfterRefusal) !== JSON.stringify(capBefore) ||
      capAfterRefusal.poll_replay_rows !== 0 ||
      capAfterRefusal.credentials_from_proposal !== 0
    ) {
      throw new Error("cap-refusal-rollback");
    }

    const capAdvanced = await post("/__s1/local-only/advance-to-credential-expiry", {});
    if (capAdvanced.status !== 200) throw new Error("cap-expiry-advance");

    // The local proof reads the real D1 expiry value using the same frozen clock
    // the mounted router will use. An offset that merely overshoots the boundary
    // yields zero here, so this rejects a successful-but-not-exact retry.
    const capIssueKey = "local-device-cap-poll-issued-1";
    const capAtExpiry = await capProof(capIssueKey);
    if (
      capAtExpiry.proposal_status !== "approved" ||
      capAtExpiry.proposal_has_token !== 0 ||
      capAtExpiry.credentials_total !== 3 ||
      capAtExpiry.credentials_from_proposal !== 0 ||
      capAtExpiry.credentials_expiring_at_now !== 1 ||
      capAtExpiry.poll_replay_rows !== 0
    ) {
      throw new Error("cap-expiry-equality");
    }

    // The refusal left no replay row. A new key now drives the same flow once,
    // and its exact replay proves the stored result was served rather than recomputed.
    const capIssued = await post(
      "/v1/device-token",
      { flow_handle: capStartBody.data.device_code },
      { "idempotency-key": capIssueKey },
    );
    const capIssuedRaw = await capIssued.text();
    const capIssuedBody = parseLocalJson(capIssuedRaw) as { status?: unknown; token?: unknown };
    if (
      capIssued.status !== 200 ||
      capIssuedBody.status !== "approved" ||
      typeof capIssuedBody.token !== "string"
    ) {
      throw new Error("cap-expiry-retry");
    }
    const capAfterIssue = await capProof(capIssueKey);
    if (
      capAfterIssue.proposal_has_token !== 1 ||
      capAfterIssue.credentials_total !== 4 ||
      capAfterIssue.credentials_from_proposal !== 1 ||
      capAfterIssue.poll_replay_rows !== 1
    ) {
      throw new Error("cap-expiry-issue-state");
    }

    const capReplay = await post(
      "/v1/device-token",
      { flow_handle: capStartBody.data.device_code },
      { "idempotency-key": capIssueKey },
    );
    const capReplayRaw = await capReplay.text();
    if (capReplay.status !== 200 || capReplayRaw !== capIssuedRaw) {
      throw new Error("cap-replay-not-identical");
    }
    const capAfterReplay = await capProof(capIssueKey);
    if (JSON.stringify(capAfterReplay) !== JSON.stringify(capAfterIssue)) {
      throw new Error("cap-replay-side-effect");
    }
    completeCase("mounted-device-cap-rollback-expiry-replay");

    const evidence = {
      record: "s1-local-d1-evidence",
      schema_version: 1,
      tool: "bun+wrangler",
      package: "apps/wire",
      suite: "s1-enrollment-local-d1",
      // Provenance: the nonce the supervising script minted for this run, and the
      // loopback origin it allocated. Together they bind this artifact to one
      // invocation, so a stale record left in a reused directory cannot be read
      // as evidence for a later run.
      run_nonce: runNonce,
      origin,
      version: Bun.version,
      duration_ms: Math.round(performance.now() - startedAt),
      status: "pass",
      cases: evidenceCompletion.cases(),
      reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
    } as const;

    // One line, and the writer is the only party that can prove it carries no
    // credential: the script supervising this run never learns the bearer, the
    // minted secret, or the sponsor's private directive. Checking here — against
    // the exact bytes about to be written — is therefore the only check that can
    // be causal rather than a guess about what the record probably contains.
    const evidenceLine = `${JSON.stringify(evidence)}\n`;
    const forbiddenInEvidence: readonly string[] = [
      issuedBody.token,
      issuedBody.token.slice(FELLOW_TOKEN_PREFIX.length),
      minted.secret,
      minted.secret.slice("v1.".length),
      privateDirective,
      privateProblem,
      String(privateEventBudget),
      String(privateArtifactBudget),
    ];
    if (forbiddenInEvidence.some((value) => value.length > 0 && evidenceLine.includes(value))) {
      throw new Error("evidence-credential-selfcheck");
    }
    if (evidenceLine.length > MAX_EVIDENCE_BYTES) throw new Error("evidence-too-large");

    // `wx` so the record can only ever be created, never appended to or
    // overwritten. A second terminal record in one file is exactly the ambiguity
    // the reader must not have to resolve.
    writeFileSync(evidencePath, evidenceLine, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(evidenceLine);
  } catch (error) {
    // Only fixed harness-owned codes may cross the diagnostic boundary. Parser,
    // fetch, D1, and schema errors can contain response fragments or URLs.
    const candidate = error instanceof Error ? error.message : "";
    const code = /^[a-z][a-z0-9-]{0,79}$/.test(candidate) ? candidate : "local-d1-scenario";
    process.stderr.write(
      `${JSON.stringify({
        tool: "bun+wrangler",
        package: "apps/wire",
        suite: "s1-enrollment-local-d1",
        version: Bun.version,
        duration_ms: Math.round(performance.now() - startedAt),
        status: "fail",
        code,
        reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
