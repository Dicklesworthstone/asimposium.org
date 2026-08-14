const origin = process.env.S1_LOCAL_ORIGIN;
if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  process.stderr.write('{"status":"fail","code":"LOCAL_ORIGIN_INVALID"}\n');
  process.exitCode = 1;
} else {
  const startedAt = performance.now();
  const sponsorId = "local-sponsor-s1";

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    const mint = await post("/__s1/mint", {
      sponsor_id: sponsorId,
      request: {
        requested_scopes: ["review"],
        problem_binding: "P-4DSP",
        event_budget: 12,
      },
    });
    if (mint.status !== 201) throw new Error("mint-status");
    const minted = (await mint.json()) as { enrollmentId?: unknown; secret?: unknown };
    if (typeof minted.enrollmentId !== "string" || typeof minted.secret !== "string") {
      throw new Error("mint-shape");
    }

    const markdown = await fetch(`${origin}/join/${minted.enrollmentId}`);
    const markdownBody = await markdown.text();
    if (
      markdown.status !== 200 ||
      markdownBody.includes(minted.secret) ||
      markdownBody.includes("v1.")
    ) {
      throw new Error("capsule-secret-boundary");
    }
    const capsule = await fetch(`${origin}/join/${minted.enrollmentId}`, {
      headers: { accept: "application/json" },
    });
    const capsuleBody = (await capsule.json()) as {
      enrollment_id?: unknown;
      claim?: { path?: unknown };
    };
    if (
      capsule.status !== 200 ||
      capsuleBody.enrollment_id !== minted.enrollmentId ||
      capsuleBody.claim?.path !== "/v1/fellows"
    ) {
      throw new Error("capsule-json");
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
      throw new Error("name-policy");
    }

    const claim = await post("/v1/fellows", {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "local-orchid",
      model: "local-model",
      harness: "codex",
    });
    const claimBody = (await claim.json()) as { flow_handle?: unknown };
    if (claim.status !== 202 || typeof claimBody.flow_handle !== "string") {
      throw new Error("claim-shape");
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

    const approval = await post("/__s1/approve", {
      sponsor_id: sponsorId,
      enrollment_id: minted.enrollmentId,
    });
    if (approval.status !== 200) throw new Error("approval-status");

    const issued = await post("/v1/device-token", { flow_handle: claimBody.flow_handle });
    const issuedBody = (await issued.json()) as { status?: unknown; token?: unknown };
    if (
      issued.status !== 200 ||
      issuedBody.status !== "approved" ||
      typeof issuedBody.token !== "string"
    ) {
      throw new Error("issued-shape");
    }

    const hello = await fetch(`${origin}/v1/hello`, {
      headers: { authorization: `Bearer ${issuedBody.token}` },
    });
    const helloBody = (await hello.json()) as { fellow?: { name?: unknown } };
    if (hello.status !== 200 || helloBody.fellow?.name !== "local-orchid") {
      throw new Error("hello-binding");
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
          "capsule-secret-boundary",
          "name-policy",
          "body-only-flow",
          "approve-token-hello-binding",
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
