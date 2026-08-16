import { DeviceCodeStartResponseSchema } from "@asimposium/contracts";

const origin = process.env.S1_LOCAL_ORIGIN;
if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  process.stderr.write('{"status":"fail","code":"LOCAL_ORIGIN_INVALID"}\n');
  process.exitCode = 1;
} else {
  const startedAt = performance.now();
  const sponsorId = "usr_local_sponsor_s1";
  const fetchTimeoutMs = 5_000;

  const localFetch = (input: string, init: RequestInit = {}): Promise<Response> =>
    fetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(fetchTimeoutMs),
    });

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

  interface DeviceCounts {
    readonly device_records: number;
    readonly start_attempts: number;
    readonly start_replays: number;
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
    post(
      "/__s1/device-start",
      { client_address: clientAddress, request: body },
      { "idempotency-key": idempotencyKey },
    );

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

  try {
    const mintRequest = {
      sponsor_id: sponsorId,
      request: {
        requested_scopes: ["review"],
        problem_binding: "P-4DSP",
        event_budget: 12,
      },
    };
    const mint = await post("/__s1/mint", mintRequest, { "idempotency-key": "local-mint-1" });
    if (mint.status !== 201) throw new Error("mint-status");
    const minted = (await mint.json()) as { enrollmentId?: unknown; secret?: unknown };
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
    assertMintedSecretAbsentFromCapsuleFaces(
      [
        ["markdown", markdownBody],
        ["json", capsuleJsonBody],
        ["html", htmlBody],
      ],
      minted.secret,
    );

    if (markdown.status !== 200 || html.status !== 200) {
      throw new Error("capsule-face-status");
    }
    if (
      capsuleBody.enrollment_id !== minted.enrollmentId ||
      capsuleBody.claim?.path !== "/v1/fellows"
    ) {
      throw new Error("capsule-json");
    }

    const plantedWrongSecret = await post("/v1/fellows", {
      enrollment_id: minted.enrollmentId,
      secret: `v1.${"z".repeat(43)}`,
      name: "local-orchid",
      model: "local-model",
      harness: "codex",
    });
    const plantedWrongSecretBody = (await plantedWrongSecret.json()) as { code?: unknown };
    if (plantedWrongSecret.status !== 400 || plantedWrongSecretBody.code !== "PAIRING_INVALID") {
      const safeCode =
        typeof plantedWrongSecretBody.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,39}$/.test(plantedWrongSecretBody.code)
          ? plantedWrongSecretBody.code
          : "INVALID_CODE";
      throw new Error(`wrong-secret-status-${plantedWrongSecret.status}-code-${safeCode}`);
    }

    const malformedName = await post("/v1/fellows", {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "codex",
      model: "local-model",
      harness: "codex",
    });
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

    const claimRequest = {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "local-orchid",
      model: "local-model",
      harness: "codex",
    };
    const claim = await post("/v1/fellows", claimRequest, { "idempotency-key": "local-claim-1" });
    const claimBody = (await claim.json()) as { flow_handle?: unknown };
    if (claim.status !== 202 || typeof claimBody.flow_handle !== "string") {
      throw new Error("claim-shape");
    }
    const claimReplay = await post("/v1/fellows", claimRequest, {
      "idempotency-key": "local-claim-1",
    });
    const claimReplayBody = (await claimReplay.json()) as { flow_handle?: unknown };
    if (claimReplay.status !== 202 || claimReplayBody.flow_handle !== claimBody.flow_handle) {
      throw new Error("claim-lost-response-replay");
    }
    const claimConflict = await post(
      "/v1/fellows",
      { ...claimRequest, name: "different-local-orchid" },
      { "idempotency-key": "local-claim-1" },
    );
    const claimConflictBody = (await claimConflict.json()) as { code?: unknown };
    if (claimConflict.status !== 409 || claimConflictBody.code !== "IDEMPOTENCY_CONFLICT") {
      throw new Error("claim-idempotency-conflict");
    }

    for (const enrollmentId of ["ASIMP-EN-7F3K9M2Q8R", minted.enrollmentId]) {
      const card = await post("/__s1/card", {
        sponsor_id: enrollmentId === minted.enrollmentId ? "wrong-local-sponsor" : sponsorId,
        enrollment_id: enrollmentId,
      });
      const cardBody = (await card.json()) as { code?: unknown };
      if (card.status !== 403 || cardBody.code !== "WRONG_PRINCIPAL") {
        throw new Error("approval-card-principal-boundary");
      }
    }

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

    const approval = await post(
      "/__s1/approve",
      {
        sponsor_id: sponsorId,
        enrollment_id: minted.enrollmentId,
      },
      { "idempotency-key": "local-decision-1" },
    );
    if (approval.status !== 200) throw new Error("approval-status");
    const approvalReplay = await post(
      "/__s1/approve",
      { sponsor_id: sponsorId, enrollment_id: minted.enrollmentId },
      { "idempotency-key": "local-decision-1" },
    );
    if (approvalReplay.status !== 200) throw new Error("decision-lost-response-replay");

    const approvedCard = await post("/__s1/card", {
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

    const pollRequest = { flow_handle: claimBody.flow_handle };
    const [issued, issuedReplay] = await Promise.all([
      post("/v1/device-token", pollRequest, { "idempotency-key": "local-poll-1" }),
      post("/v1/device-token", pollRequest, { "idempotency-key": "local-poll-1" }),
    ]);
    const [issuedBody, issuedReplayBody] = (await Promise.all([
      issued.json(),
      issuedReplay.json(),
    ])) as [{ status?: unknown; token?: unknown }, { status?: unknown; token?: unknown }];
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

    const hello = await localFetch(`${origin}/v1/hello`, {
      headers: { authorization: `Bearer ${issuedBody.token}` },
    });
    const helloBody = (await hello.json()) as { fellow?: { name?: unknown } };
    if (hello.status !== 200 || helloBody.fellow?.name !== "local-orchid") {
      throw new Error("hello-binding");
    }

    const raceMint = await post("/__s1/mint", {
      sponsor_id: sponsorId,
      request: { requested_scopes: ["review"] },
    });
    const raceMintBody = (await raceMint.json()) as { enrollmentId?: unknown; secret?: unknown };
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
      post("/v1/fellows", raceClaimRequest, { "idempotency-key": "local-claim-race-1" }),
      post("/v1/fellows", raceClaimRequest, { "idempotency-key": "local-claim-race-1" }),
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

    // This approval collides with the immutable Fellow name already bound
    // above. The following deny deliberately reuses its key with a different
    // digest: it succeeds only if the failed D1 batch rolled back both the
    // grant effect and its idempotency insert.
    const rollbackMint = await post("/__s1/mint", {
      sponsor_id: sponsorId,
      request: { requested_scopes: ["review"] },
    });
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
    const rollbackClaim = await post("/v1/fellows", {
      enrollment_id: rollbackMintBody.enrollmentId,
      secret: rollbackMintBody.secret,
      name: "local-orchid",
      model: "local-model",
      harness: "codex",
    });
    if (rollbackClaim.status !== 202) throw new Error("rollback-claim-shape");
    const rollbackClaimBody = (await rollbackClaim.json()) as { flow_handle?: unknown };
    if (typeof rollbackClaimBody.flow_handle !== "string") {
      throw new Error("rollback-claim-flow-shape");
    }
    const rollbackPending = await post(
      "/v1/fellows/flow",
      { flow_handle: rollbackClaimBody.flow_handle },
      { "idempotency-key": "local-rollback-poll-1" },
    );
    const rollbackPendingBody = (await rollbackPending.json()) as { status?: unknown };
    if (rollbackPending.status !== 200 || rollbackPendingBody.status !== "authorization_pending") {
      throw new Error("rollback-pending-poll");
    }
    const failedApproval = await post(
      "/__s1/approve",
      { sponsor_id: sponsorId, enrollment_id: rollbackMintBody.enrollmentId },
      { "idempotency-key": "local-decision-rollback-1" },
    );
    const failedApprovalBody = (await failedApproval.json()) as { code?: unknown };
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
        decision: { enrollment_id: rollbackMintBody.enrollmentId, decision: "deny" },
      },
      { "idempotency-key": "local-decision-rollback-1" },
    );
    if (recoveredDeny.status !== 200) throw new Error("rollback-key-poisoned");
    const rollbackDenied = await post(
      "/v1/fellows/flow",
      { flow_handle: rollbackClaimBody.flow_handle },
      { "idempotency-key": "local-rollback-poll-1" },
    );
    const rollbackDeniedBody = (await rollbackDenied.json()) as { status?: unknown };
    if (rollbackDenied.status !== 200 || rollbackDeniedBody.status !== "access_denied") {
      throw new Error("stable-poll-key-denial-transition");
    }

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

    const expiryStart = await startDevice(
      "198.51.100.42",
      deviceStartBody("local-device-stable-poll-expire"),
      "local-device-stable-poll-expire",
    );
    const expiryStartBody = DeviceCodeStartResponseSchema.safeParse(await expiryStart.json());
    if (expiryStart.status !== 201 || !expiryStartBody.success) {
      throw new Error("stable-poll-key-expiry-start");
    }
    const expiryPollRequest = { flow_handle: expiryStartBody.data.device_code };
    const expiryPending = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const expiryPendingBody = (await expiryPending.json()) as { status?: unknown };
    if (expiryPending.status !== 200 || expiryPendingBody.status !== "authorization_pending") {
      throw new Error("stable-poll-key-expiry-pending");
    }
    const advanced = await post("/__s1/advance-device-ttl", {});
    if (advanced.status !== 200) throw new Error("stable-poll-key-clock-advance");
    const expiryTerminal = await post("/v1/device-token", expiryPollRequest, {
      "idempotency-key": "local-device-expiry-poll-1",
    });
    const expiryTerminalBody = (await expiryTerminal.json()) as { status?: unknown };
    if (expiryTerminal.status !== 200 || expiryTerminalBody.status !== "expired_token") {
      throw new Error("stable-poll-key-expiry-transition");
    }

    process.stdout.write(
      `${JSON.stringify({
        tool: "bun+wrangler",
        package: "apps/wire",
        suite: "s1-enrollment-local-d1",
        version: Bun.version,
        duration_ms: Math.round(performance.now() - startedAt),
        status: "pass",
        cases: [
          "capsule-public-face-secret-boundary",
          "planted-minted-secret-leak-refusal",
          "planted-wrong-secret-opaque-refusal",
          "name-policy",
          "approval-card-principal-boundary",
          "durable-approval-grant",
          "body-only-flow",
          "approve-token-hello-binding",
          "encrypted-idempotency-lost-response",
          "idempotency-digest-conflict",
          "concurrent-first-claim-replay",
          "failed-batch-does-not-poison-key",
          "stable-poll-key-approval-transition",
          "stable-poll-key-denial-transition",
          "stable-poll-key-expiry-transition",
          "concurrent-device-start-source-limit",
          "concurrent-device-start-final-slot-replay",
        ],
        reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
      })}\n`,
    );
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
