const origin = process.env.S1_LOCAL_ORIGIN;
if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  process.stderr.write('{"status":"fail","code":"LOCAL_ORIGIN_INVALID"}\n');
  process.exitCode = 1;
} else {
  const startedAt = performance.now();
  const sponsorId = "local-sponsor-s1";
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

    const pending = await post("/v1/fellows/flow", { flow_handle: claimBody.flow_handle });
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
    const issued = await post("/v1/device-token", pollRequest, {
      "idempotency-key": "local-poll-1",
    });
    const issuedBody = (await issued.json()) as { status?: unknown; token?: unknown };
    if (
      issued.status !== 200 ||
      issuedBody.status !== "approved" ||
      typeof issuedBody.token !== "string"
    ) {
      throw new Error("issued-shape");
    }
    const issuedReplay = await post("/v1/device-token", pollRequest, {
      "idempotency-key": "local-poll-1",
    });
    const issuedReplayBody = (await issuedReplay.json()) as { status?: unknown; token?: unknown };
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
    const failedApproval = await post(
      "/__s1/approve",
      { sponsor_id: sponsorId, enrollment_id: rollbackMintBody.enrollmentId },
      { "idempotency-key": "local-decision-rollback-1" },
    );
    if (failedApproval.status !== 400) throw new Error("rollback-decision-failure");
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
        ],
        reproduce: "scripts/e2e-s1-cold-enrollment.sh --local-d1",
      })}\n`,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "local-d1-scenario";
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
