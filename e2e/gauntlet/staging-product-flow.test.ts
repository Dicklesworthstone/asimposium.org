import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  parseJoinUrlsFile,
  runStagingCohort,
  validateStagingAgentOrigin,
} from "./staging-product-flow.mjs";

const PROBLEM_ID = "P-STAGING-REHEARSAL";
const SPONSOR_ID = "usr_staging_rehearsal_sponsor";

/**
 * Minimal real HTTP loopback staging server exercising the full Fable §7 / §16.1
 * wire protocol over real TCP sockets (zero mocked fetch, real recording proxy,
 * real injected 422 PROMOTE_BODY_INVALID rejection and recovery, independent
 * anonymous GET /p/:id/claims.json check).
 */
async function startLoopbackStagingServer() {
  const enrollments = new Map<
    string,
    {
      secret: string;
      approved: boolean;
      fellowId: string;
      token: string;
      flowHandle: string;
    }
  >();
  const tokens = new Map<string, { fellowId: string; sponsorId: string }>();
  const sessions = new Map<string, { fellowId: string; problemId: string }>();
  const publicClaims: Array<{
    claim_id: string;
    kind: string;
    statement: string;
    falsifier: string;
    author_fellow_id: string;
    session_id: string;
  }> = [];
  let seq = 0;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && url.pathname.startsWith("/join/")) {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end("# Join Capsule\nPOST /v1/fellows with enrollment_id and fragment secret.\n");
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/fellows") {
      const body = JSON.parse(bodyText) as { enrollment_id: string; secret: string };
      const en = enrollments.get(body.enrollment_id);
      if (!en || en.secret !== body.secret) {
        return json(401, { code: "PAIRING_INVALID" });
      }
      return json(202, {
        status: "pending_approval",
        flow_handle: en.flowHandle,
        poll_url: "/v1/fellows/poll",
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/fellows/poll") {
      const body = JSON.parse(bodyText) as { flow_handle: string };
      const en = [...enrollments.values()].find((e) => e.flowHandle === body.flow_handle);
      if (!en) return json(400, { code: "FLOW_INVALID" });
      if (!en.approved) return json(202, { status: "authorization_pending" });
      return json(200, { status: "approved", token: en.token, hello_url: "/v1/hello" });
    }

    if (req.method === "GET" && url.pathname === `/p/${PROBLEM_ID}/claims.json`) {
      return json(200, { problem_id: PROBLEM_ID, claims: publicClaims });
    }

    const authHeader = req.headers.authorization ?? "";
    const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const principal = tokens.get(rawToken);
    if (!principal) {
      return json(401, { code: "FELLOW_TOKEN_INVALID" });
    }

    if (req.method === "GET" && url.pathname === "/v1/hello") {
      return json(200, {
        fellow: { fellow_id: principal.fellowId, sponsor_id: principal.sponsorId },
        problem_id: PROBLEM_ID,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      const body = JSON.parse(bodyText) as { problem_id: string };
      const sessionId = `S-STG-${++seq}`;
      sessions.set(sessionId, { fellowId: principal.fellowId, problemId: body.problem_id });
      return json(201, { session_id: sessionId, problem_id: body.problem_id });
    }

    const packMatch = /^\/v1\/sessions\/([^/]+)\/pack$/.exec(url.pathname);
    if (req.method === "GET" && packMatch && sessions.has(packMatch[1]!)) {
      return json(200, {
        problem_id: PROBLEM_ID,
        profile: "working",
        cursor: seq,
        omitted: [],
      });
    }

    const workshopMatch = /^\/v1\/sessions\/([^/]+)\/workshop$/.exec(url.pathname);
    if (req.method === "POST" && workshopMatch && sessions.has(workshopMatch[1]!)) {
      const workshopId = `W-${String(++seq).padStart(26, "0")}`;
      return json(201, { workshop_id: workshopId, version: 1 });
    }

    const promoteMatch = /^\/v1\/sessions\/([^/]+)\/promote$/.exec(url.pathname);
    if (req.method === "POST" && promoteMatch && sessions.has(promoteMatch[1]!)) {
      const session = sessions.get(promoteMatch[1]!)!;
      const body = JSON.parse(bodyText) as {
        workshop_id?: string;
        kind?: string;
        statement?: string;
        falsifier?: string;
      };
      if (typeof body.workshop_id !== "string" || body.workshop_id.length === 0) {
        return json(422, {
          code: "PROMOTE_BODY_INVALID",
          title: "Missing workshop_id",
          fix_hint: "Include workshop_id from POST /v1/sessions/:id/workshop.",
        });
      }
      const claimId = `C-${++seq}`;
      publicClaims.push({
        claim_id: claimId,
        kind: body.kind ?? "conjecture",
        statement: body.statement ?? "For every n >= 1, 2n is even.",
        falsifier: body.falsifier ?? "Exhibit an integer n >= 1 where 2n mod 2 != 0.",
        author_fellow_id: session.fellowId,
        session_id: promoteMatch[1]!,
      });
      return json(201, {
        claim_id: claimId,
        version: 1,
        event_id: `E-STG-${seq}`,
        sequence: seq,
        content_digest: `sha256:${"a".repeat(64)}`,
        created_at: new Date().toISOString(),
      });
    }

    const closeMatch = /^\/v1\/sessions\/([^/]+)\/close$/.exec(url.pathname);
    if (req.method === "POST" && closeMatch && sessions.has(closeMatch[1]!)) {
      return json(200, {
        session_id: closeMatch[1]!,
        closed_at: new Date().toISOString(),
      });
    }

    return json(404, { code: "ROUTE_NOT_FOUND" });
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  function mint(attemptIndex: number) {
    const enrollmentId = `ASIMP-EN-STGREH${String(attemptIndex).padStart(4, "0")}`;
    const secret = `v1.stgsecret${String(attemptIndex).padStart(16, "0")}`;
    const fellowId = `F-STG-${attemptIndex}`;
    const token = `asimp_ag_stgtoken_${attemptIndex}_${"z".repeat(24)}`;
    const flowHandle = `fh_stg_${attemptIndex}`;
    enrollments.set(enrollmentId, {
      secret,
      approved: false,
      fellowId,
      token,
      flowHandle,
    });
    tokens.set(token, { fellowId, sponsorId: SPONSOR_ID });
    return {
      enrollmentId,
      secret,
      joinUrl: `${origin}/join/${enrollmentId}#${secret}`,
    };
  }

  function approve(enrollmentId: string) {
    const en = enrollments.get(enrollmentId);
    if (en) en.approved = true;
  }

  return {
    origin,
    mint,
    approve,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Deterministic scripted agent driving the full Fable §7 loop through the recording proxy. */
async function scriptedAgentLoop(
  joinUrl: string,
  problemId: string,
  options: { skipPack?: boolean; skipRetry422?: boolean; tokensUsed?: number } = {},
) {
  const parsed = new URL(joinUrl);
  const base = parsed.origin;
  const enrollmentId = parsed.pathname.split("/").pop()!;
  const secret = parsed.hash.slice(1);

  await fetch(`${base}/join/${enrollmentId}`);
  const claimRes = await fetch(`${base}/v1/fellows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollment_id: enrollmentId, secret }),
  });
  const { flow_handle } = (await claimRes.json()) as { flow_handle: string };
  const pollRes = await fetch(`${base}/v1/fellows/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flow_handle }),
  });
  const { token } = (await pollRes.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  await fetch(`${base}/v1/hello`, { headers: auth });
  const sRes = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ problem_id: problemId }),
  });
  const { session_id } = (await sRes.json()) as { session_id: string };

  if (!options.skipPack) {
    await fetch(`${base}/v1/sessions/${session_id}/pack?profile=working`, { headers: auth });
  }

  const wRes = await fetch(`${base}/v1/sessions/${session_id}/workshop`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "draft", body_md: "Scratch work" }),
  });
  const { workshop_id } = (await wRes.json()) as { workshop_id: string };

  const promotePayload = {
    workshop_id,
    kind: "conjecture",
    statement: "Every positive even integer is divisible by 2.",
    falsifier: "An integer n >= 1 with 2n mod 2 != 0.",
  };
  const firstPromote = await fetch(`${base}/v1/sessions/${session_id}/promote`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(promotePayload),
  });
  if (firstPromote.status === 422 && !options.skipRetry422) {
    await fetch(`${base}/v1/sessions/${session_id}/promote`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(promotePayload),
    });
  }

  await fetch(`${base}/v1/sessions/${session_id}/close`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      handback: { summary: "Promoted conjecture and closed cleanly." },
    }),
  });
  return { tokensUsed: options.tokensUsed ?? 14_200 };
}

describe("state-derived staging Cold-Agent Gauntlet runner (bead fd5e)", () => {
  test("should-fail control 1: canonical production origins are refused fail-closed", () => {
    for (const forbidden of [
      "https://a.asimposium.org",
      "https://asimposium.org",
      "https://artifacts.asimposium.org",
    ]) {
      expect(validateStagingAgentOrigin(forbidden)).toEqual({
        ok: false,
        exitCode: 64,
        code: "STAGING_ORIGIN_PRODUCTION_FORBIDDEN",
      });
    }
    expect(validateStagingAgentOrigin("http://127.0.0.1:8787")).toEqual({
      ok: false,
      exitCode: 64,
      code: "STAGING_AGENT_BASE_URL_INVALID",
    });
    expect(validateStagingAgentOrigin("http://127.0.0.1:8787", { allowLoopback: true })).toEqual({
      ok: true,
      origin: "http://127.0.0.1:8787",
    });
    expect(validateStagingAgentOrigin("https://staging-a.asimposium.org")).toEqual({
      ok: true,
      origin: "https://staging-a.asimposium.org",
    });
  });

  test("positive: loopback-staging 10-attempt 3-adapter rehearsal passes with state-derived verdicts and zero secret leaks", async () => {
    const server = await startLoopbackStagingServer();
    try {
      const minted = Array.from({ length: 10 }, (_, i) => server.mint(i));
      const fileLines = minted.map((m) =>
        JSON.stringify({ join_url: m.joinUrl, problem_id: PROBLEM_ID, sponsor_id: SPONSOR_ID }),
      );
      const entries = parseJoinUrlsFile(fileLines.join("\n"));
      const emitted: string[] = [];

      const outcome = await runStagingCohort({
        targetOrigin: server.origin,
        entries,
        allowLoopback: true,
        approveEnrollment: ({ enrollmentId }) => server.approve(enrollmentId),
        runner: ({ joinUrl, problemId }) => scriptedAgentLoop(joinUrl, problemId),
        emit: (record) => emitted.push(JSON.stringify(record)),
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.code).toBe("GAUNTLET_STAGING_PASS");
      expect(outcome.scorecard?.total).toBe(10);
      expect(outcome.scorecard?.completed).toBe(10);
      expect(outcome.scorecard?.harnesses).toHaveLength(3);
      expect(outcome.scorecard?.medianTokens).toBeLessThanOrEqual(25_000);
      expect(outcome.scorecard?.passed).toBe(true);

      // Zero join secrets or bearer tokens leaked into emitted NDJSON!
      const allOutput = emitted.join("\n");
      for (const m of minted) {
        expect(allOutput).not.toContain(m.secret);
      }
      expect(allOutput).not.toContain("asimp_ag_");
    } finally {
      await server.close();
    }
  });

  test("should-fail controls 2 & 3: 7/10 completions, 2-only harnesses, missing pack-before-promote, and missing 422 recovery all fail honestly", async () => {
    const server = await startLoopbackStagingServer();
    try {
      // 7/10 completions (attempts 0..2 skip pack or 422 recovery) -> FAILS scorecard!
      const mintedA = Array.from({ length: 10 }, (_, i) => server.mint(100 + i));
      const entriesA = parseJoinUrlsFile(mintedA.map((m) => m.joinUrl).join("\n"), {
        problemId: PROBLEM_ID,
        sponsorId: SPONSOR_ID,
      });
      const sevenOfTen = await runStagingCohort({
        targetOrigin: server.origin,
        entries: entriesA,
        allowLoopback: true,
        approveEnrollment: ({ enrollmentId }) => server.approve(enrollmentId),
        runner: ({ attemptIndex, joinUrl, problemId }) => {
          if (attemptIndex === 0) return scriptedAgentLoop(joinUrl, problemId, { skipPack: true });
          if (attemptIndex === 1)
            return scriptedAgentLoop(joinUrl, problemId, { skipRetry422: true });
          if (attemptIndex === 2) return scriptedAgentLoop(joinUrl, problemId, { tokensUsed: 0 });
          return scriptedAgentLoop(joinUrl, problemId);
        },
      });
      expect(sevenOfTen.ok).toBe(false);
      expect(sevenOfTen.exitCode).toBe(1);
      expect(sevenOfTen.scorecard?.completed).toBe(7);
      expect(sevenOfTen.scorecard?.passed).toBe(false);
      expect(sevenOfTen.results[0]?.completed).toBe(false);
      expect(sevenOfTen.results[1]?.completed).toBe(false);
      expect(sevenOfTen.results[2]?.completed).toBe(false);

      // Only 2 distinct harnesses across 10 completions -> FAILS scorecard!
      const mintedB = Array.from({ length: 10 }, (_, i) => server.mint(200 + i));
      const entriesB = parseJoinUrlsFile(
        mintedB
          .map((m, i) =>
            JSON.stringify({
              join_url: m.joinUrl,
              problem_id: PROBLEM_ID,
              sponsor_id: SPONSOR_ID,
              harness: i % 2 === 0 ? "claude-code" : "codex",
            }),
          )
          .join("\n"),
      );
      const twoHarnesses = await runStagingCohort({
        targetOrigin: server.origin,
        entries: entriesB,
        allowLoopback: true,
        approveEnrollment: ({ enrollmentId }) => server.approve(enrollmentId),
        runner: ({ joinUrl, problemId }) => scriptedAgentLoop(joinUrl, problemId),
      });
      expect(twoHarnesses.ok).toBe(false);
      expect(twoHarnesses.scorecard?.completed).toBe(10);
      expect(twoHarnesses.scorecard?.harnesses).toHaveLength(2);
      expect(twoHarnesses.scorecard?.passed).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("REGRESSION (Bug #10): fetchAnonymousPublicClaims parses real Stoa ClaimsListResponse + ClaimFaceResponse claim-detail body", async () => {
    const { fetchAnonymousPublicClaims } = await import("./staging-product-flow.mjs");
    const server = createServer((req, res) => {
      if (req.url === "/p/P-REALSHAPE/claims.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            claims: [
              {
                id: "C-1",
                version: 1,
                kind: "conjecture",
                statement: "Every n >= 1 satisfies 2n mod 2 = 0.",
                source_seq: 2,
                created_at: "2026-11-21T00:00:00.000Z",
                stale: false,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/p/P-REALSHAPE/claims/C-1.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schema: "asimposium.claim-face.v1",
            kind: "claim-face",
            profile: "claim",
            problem: "P-REALSHAPE",
            cursor: 2,
            items: [
              {
                kind: "claim-detail",
                id: "C-1@1",
                scope: "problem",
                untrusted: true,
                why_included: "requested claim",
                body: JSON.stringify({
                  claim_id: "C-1",
                  version: 1,
                  kind: "conjecture",
                  statement: "Every n >= 1 satisfies 2n mod 2 = 0.",
                  falsifier: "Exhibit n >= 1 with 2n mod 2 != 0.",
                  fellow: "F-REAL-1",
                  session: "S-REAL-1",
                }),
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const port = (server.address() as { port: number }).port;
    try {
      const claims = await fetchAnonymousPublicClaims(`http://127.0.0.1:${port}`, "P-REALSHAPE");
      expect(claims).toEqual([
        {
          claim_id: "C-1",
          author_fellow_id: "F-REAL-1",
          session_id: "S-REAL-1",
          has_falsifier: true,
          conjecture_class: true,
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
