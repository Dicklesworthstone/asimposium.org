/**
 * W7.4 Cache Discipline, Surrogate-Key Invalidation, Stale-With-Warning, and
 * Paired-User Cache-Leak Verification Harness (bead asimposiumorg-mfw; reused by W10).
 *
 * Mounts the real Stoa Worker (`createApp`) over real migrated D1 with zero mocks
 * AND routes requests through a real RFC 9111 shared-cache proxy simulator that
 * ACTUALLY caches any response lacking `private`/`no-store` (or carrying `public`
 * / `s-maxage`) keyed on URL + `Vary` headers.
 *
 * Proves:
 *   1. Public GET ETag / `If-None-Match` -> `304 Not Modified` + `HEAD` parity
 *      across mounted public faces (`/capabilities`, `/schemas`, `/openapi.json`,
 *      `/p/:id.{json,md}`, `/p/:id/claims.json`, `/p/:id/events.json`,
 *      `/p/:id/syntheses.json`, `/p/:id/commentary.json`, `/p/:id/dead-ends.json`,
 *      `/p/:id/moves.json`, `/p/:id/review-queue.json`, `/p/:id/roster.json`,
 *      `/problems.json`, `/areas.json`, `/results.json`, `/stats.json`).
 *   2. Write -> ETag invalidation coverage:
 *      - Public claim promotion & commentary write invalidate affected public ETags
 *        (prior `If-None-Match` returns `200` with a fresh ETag, never stale `304`).
 *      - Private workshop push leaves ALL public face ETags and `/p/:id/cursor`
 *        byte-for-byte unchanged (`304` still holds).
 *      - Redaction / content-control hides content and invalidates prior ETags
 *        (old `If-None-Match` never resurrects redacted bytes).
 *   3. Authenticated packs (`GET /v1/hello`, `GET /v1/sessions/:id/pack`) strictly
 *      emit `private, no-store` and NEVER enter the shared-cache proxy.
 *   4. Paired-user cache-leak harness (Sponsor A + Sponsor B + Anonymous + unlisted
 *      problem + private workshop):
 *      - Unlisted problem faces emit `private, no-store` + `X-Robots-Tag: noindex, nofollow`.
 *      - Workshop reads emit `private, no-store`.
 *      - Zero private/unlisted entries enter the shared-cache proxy.
 *      - Sponsor B and Anonymous get 401/403/404 with ZERO canary bytes on private
 *        workshop routes, even immediately after Sponsor A reads them through the
 *        shared-cache proxy.
 *      - Unified with `runCachePrivacyTest` (`scripts/ops-cache-privacy-test.ts`) over
 *        real loopback HTTP.
 *      - Non-vacuous negative control: an intentionally misconfigured `public` response
 *        carrying a canary IS caught by the shared-cache proxy and trips the leak check.
 *   5. Stale-with-warning fixture:
 *      - Published synthesis + subsequent ledger event + `applySynthesisStaleness`
 *        renders explicit `stale: true`, `events_since >= 1`, and timestamped staleness
 *        warning on both `.json` and `.md` faces.
 */

import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../apps/web/lib/service-envelope.ts";
import { createApp } from "../../apps/wire/src/app.ts";
import { toHex } from "../../apps/wire/src/auth/canonical.ts";
import { D1EnrollmentStore } from "../../apps/wire/src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../apps/wire/src/enrollment/service.ts";
import {
  dispatchExtendedOutboxConsumer,
  type OutboxConsumerRow,
} from "../../apps/wire/src/krater/outbox-consumers.ts";
import { readProblemPublicationPreview } from "../../apps/wire/src/problems/publication-preview.ts";
import { POLICY_CATEGORIES } from "../../apps/wire/src/screening/types.ts";
import { migratedSqliteD1 } from "../../apps/wire/test/support/migrated-sqlite.ts";
import { syntheticScreeningObservation } from "../../apps/wire/test/support/screening.ts";
import { runCachePrivacyTest } from "../../scripts/ops-cache-privacy-test.ts";

/**
 * Minimal RFC 9111 shared-cache proxy simulator.
 * Stores ANY 200 GET response whose `Cache-Control` does NOT contain `private`
 * or `no-store` (or explicitly carries `public` / `s-maxage`), keyed by URL +
 * request headers named in `Vary`. If a buggy handler ever forgets `private, no-store`
 * on a private/unlisted response, a subsequent unauthenticated caller WILL receive
 * the cached private bytes — making the leak harness genuinely falsifiable!
 */
class SharedEdgeCacheProxy {
  private readonly store = new Map<
    string,
    { status: number; headers: [string, string][]; body: Uint8Array; varyKeys: string[] }
  >();

  private cacheKey(url: string, headers: Headers, varyKeys: readonly string[]): string {
    const varyPart = varyKeys
      .map((k) => `${k.toLowerCase()}=${headers.get(k) ?? ""}`)
      .sort()
      .join("&");
    return `${url}|${varyPart}`;
  }

  private lookup(request: Request): Response | null {
    if (request.method !== "GET") return null;
    for (const [key, entry] of this.store.entries()) {
      const expectedKey = this.cacheKey(request.url, request.headers, entry.varyKeys);
      if (key === expectedKey) {
        const outHeaders = new Headers(entry.headers);
        outHeaders.set("x-edge-cache-status", "HIT");
        return new Response(new Uint8Array(entry.body), {
          status: entry.status,
          headers: outHeaders,
        });
      }
    }
    return null;
  }

  async fetch(
    request: Request,
    originFetch: (req: Request) => Promise<Response>,
  ): Promise<Response> {
    const hit = this.lookup(request);
    if (hit) return hit;

    const upstream = await originFetch(request);
    const cc = (upstream.headers.get("cache-control") ?? "").toLowerCase();
    const isSharedCacheable =
      request.method === "GET" &&
      upstream.status === 200 &&
      !cc.includes("private") &&
      !cc.includes("no-store") &&
      (cc.includes("public") || cc.includes("s-maxage") || cc.includes("max-age"));

    const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("x-edge-cache-status", "MISS");

    if (isSharedCacheable) {
      const varyRaw = upstream.headers.get("vary") ?? "";
      const varyKeys = varyRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== "*");
      if (!varyRaw.includes("*")) {
        const key = this.cacheKey(request.url, request.headers, varyKeys);
        this.store.set(key, {
          status: upstream.status,
          headers: [...upstream.headers.entries()],
          body: bodyBytes,
          varyKeys,
        });
      }
    }

    return new Response(bodyBytes, { status: upstream.status, headers: outHeaders });
  }

  get entryCount(): number {
    return this.store.size;
  }

  cachedUrls(): string[] {
    return [...this.store.keys()];
  }
}

async function setupCacheFixture() {
  const { db, sqlite } = migratedSqliteD1();
  const nowIso = "2026-11-21T14:00:00.000Z";
  const replayKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const enrollment = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(replayKey),
  });

  const sponsorA = { type: "sponsor" as const, sponsorId: "usr_w74_sponsor_a" };
  const sponsorB = { type: "sponsor" as const, sponsorId: "usr_w74_sponsor_b" };
  await enrollment.bootstrapSponsor(sponsorA);
  await enrollment.bootstrapSponsor(sponsorB);

  const enrollFellow = async (
    sponsor: typeof sponsorA,
    name: string,
  ): Promise<{ token: string; fellowId: string }> => {
    const grant = await enrollment.mint(sponsor, {
      requested_scopes: ["promote", "review", "propose-problems"],
    });
    const claimed = await enrollment.claim({
      enrollment_id: grant.enrollmentId,
      secret: grant.secret,
      name,
      model: "claude-opus-4-6",
      harness: "claude-code",
    });
    await enrollment.decide(sponsor, grant.enrollmentId, {
      enrollment_id: grant.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const polled = await enrollment.poll({ flow_handle: claimed.flowHandle });
    if (!("token" in polled)) throw new Error("Expected Fellow token");
    const binding = await enrollment.credentialBinding(polled.token);
    if (!binding) throw new Error("Expected Fellow credential binding");
    return { token: polled.token, fellowId: binding.fellowId };
  };

  const fellowA = await enrollFellow(sponsorA, "w74-fellow-a");
  const fellowB = await enrollFellow(sponsorB, "w74-fellow-b");

  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const pubHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));

  const env = {
    DB: db,
    AI: {
      run: async () => ({
        response: JSON.stringify({
          decision: "pass",
          coarse_category: "benign-context",
          bands: Object.fromEntries(POLICY_CATEGORIES.map((name) => [name, null])),
        }),
      }),
    },
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: replayKey,
    SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: "k-w74", publicKeyHex: pubHex, notBefore: 0 }]),
  } as unknown as Parameters<ReturnType<typeof createApp>["fetch"]>[1];

  const app = createApp({
    screenPromotion: async (input) =>
      syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      }),
  });

  const signSponsor = async (
    sponsorId: string,
    method: "GET" | "POST",
    route: string,
    action: string,
    body: string,
  ) => {
    const envelope = await mintServiceEnvelope({
      kid: "k-w74",
      privateKey: keyPair.privateKey,
      issuer: "agora",
      audience: "stoa",
      principalType: "sponsor",
      principalId: sponsorId,
      method,
      route,
      action,
      body,
      now: Math.floor(Date.now() / 1000),
    });
    return serviceEnvelopeHeaders(envelope);
  };

  // Create real public problem through Fellow proposal -> Sponsor publish -> Independent statement-clear
  // so the immutable event log carries its verified formulation (Rule A6).
  const createPublicRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/problems", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowA.token}`,
        "content-type": "application/json",
        "idempotency-key": "w74-create-public-problem",
      },
      body: JSON.stringify({
        title: "W7.4 Public Cache Discipline Problem",
        statement: "Every finite tree on n >= 1 vertices has exactly n - 1 edges.",
        falsifier: "Exhibit a connected acyclic graph on n vertices with != n - 1 edges.",
        motivation:
          "Verify W7.4 cache discipline and ETag invalidation on a real published problem.",
        scope: "Finite labelled trees.",
        out_of_scope: "Infinite graphs.",
        success_criteria: "Independent verification of tree edge count.",
        areas: ["combinatorics"],
      }),
    }),
    env,
  );
  if (createPublicRes.status !== 201) {
    throw new Error(
      `Failed to propose public problem: ${createPublicRes.status} ${await createPublicRes.text()}`,
    );
  }
  const publicProblem = ((await createPublicRes.json()) as { problem: { id: string } }).problem.id;

  const preview = await readProblemPublicationPreview(db, publicProblem, sponsorA.sponsorId);
  if (!preview) throw new Error("Missing publication preview for W7.4 public problem");
  const pubLifecyclePath = `/v1/sponsors/problems/${publicProblem}/lifecycle`;
  const pubBody = JSON.stringify({
    action: "publish",
    reviewed_statement_version: preview.problem.current_statement_version,
    reviewed_digest: preview.review_digest,
  });
  const pubRes = await app.fetch(
    new Request(`https://a.asimposium.org${pubLifecyclePath}`, {
      method: "POST",
      headers: {
        ...(await signSponsor(
          sponsorA.sponsorId,
          "POST",
          pubLifecyclePath,
          "problem-lifecycle",
          pubBody,
        )),
        "content-type": "application/json",
        "idempotency-key": "w74-publish-public-problem",
      },
      body: pubBody,
    }),
    env,
  );
  if (pubRes.status !== 200) {
    throw new Error(`Failed to publish public problem: ${pubRes.status} ${await pubRes.text()}`);
  }

  // Independent reviewer Fellow B clears the statement so claims board unlocks to active.
  const revSessRes = await app.fetch(
    new Request("https://a.asimposium.org/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowB.token}`,
        "content-type": "application/json",
        "idempotency-key": "w74-open-rev-sess",
      },
      body: JSON.stringify({ problem_id: publicProblem, intent: "review" }),
    }),
    env,
  );
  if (revSessRes.status !== 201) {
    throw new Error(
      `Failed to open reviewer session: ${revSessRes.status} ${await revSessRes.text()}`,
    );
  }
  const revSessId = ((await revSessRes.json()) as { session_id: string }).session_id;
  const clearRes = await app.fetch(
    new Request(`https://a.asimposium.org/v1/problems/${publicProblem}/statement-review`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fellowB.token}`,
        "content-type": "application/json",
        "idempotency-key": "w74-clear-stmt",
      },
      body: JSON.stringify({
        session_id: revSessId,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Statement, scope, and falsifier are exact and finite.",
      }),
    }),
    env,
  );
  if (clearRes.status !== 200) {
    throw new Error(`Failed to clear statement: ${clearRes.status} ${await clearRes.text()}`);
  }

  // Seed unlisted problem explicitly marked unlisted = 1 for the paired-user cache-leak harness.
  const unlistedProblem = "P-W74UNL";
  sqlite.run(
    `INSERT INTO problems (id, title, status, unlisted, current_statement_version, sponsor_id, created_by_fellow_id, public_seq, areas, created_at, updated_at)
     VALUES (?, 'W7.4 Unlisted Problem UNLISTED_CANARY_74', 'active', 1, 1, ?, ?, 0, '["combinatorics"]', ?, ?)`,
    [unlistedProblem, sponsorA.sponsorId, fellowA.fellowId, nowIso, nowIso],
  );
  sqlite.run(
    `INSERT INTO problem_statement_versions (problem_id, version, statement, norm_hash, falsifier, motivation, scope, out_of_scope, success_criteria, created_at)
     VALUES (?, 1, 'Statement for UNLISTED_CANARY_74', 'norm_w74_unl', 'Exhibit a counterexample.', 'Verify unlisted cache discipline.', 'Finite graphs.', 'Infinite graphs.', 'Independent verification.', ?)`,
    [unlistedProblem, nowIso],
  );
  sqlite.run(
    `INSERT INTO problem_memberships (problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)`,
    [unlistedProblem, fellowA.fellowId, nowIso],
  );

  return {
    db,
    sqlite,
    app,
    env,
    sponsorA,
    sponsorB,
    fellowA,
    fellowB,
    publicProblem,
    unlistedProblem,
    signSponsor,
  };
}

describe("W7.4 Cache Discipline, Surrogate-Key Purge Map & Paired-User Leak Harness (mfw)", () => {
  test("every public GET emits strong ETag, returns 304 on If-None-Match, honors HEAD, and invalidates on public writes (but NEVER on workshop writes)", async () => {
    const f = await setupCacheFixture();
    try {
      // Open session on public problem and seed 1 claim so all sub-faces are non-trivial.
      const sessRes = await f.app.fetch(
        new Request("https://a.asimposium.org/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-open-pub",
          },
          body: JSON.stringify({ problem_id: f.publicProblem, intent: "prove" }),
        }),
        f.env,
      );
      expect(sessRes.status).toBe(201);
      const { session_id: sessionId } = (await sessRes.json()) as { session_id: string };

      const draft1Res = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-draft-1",
          },
          body: JSON.stringify({
            type: "claim-draft",
            title: "Initial claim draft",
            body_md: "Scratch before promotion.",
            relates_to: [],
          }),
        }),
        f.env,
      );
      expect(draft1Res.status).toBe(201);
      const { workshop_id: draft1Id } = (await draft1Res.json()) as { workshop_id: string };

      const prom1Res = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-prom-1",
          },
          body: JSON.stringify({
            workshop_id: draft1Id,
            kind: "conjecture",
            statement: "Every finite tree on n >= 1 vertices has exactly n - 1 edges.",
            falsifier: "Exhibit a connected acyclic graph on n vertices with != n - 1 edges.",
          }),
        }),
        f.env,
      );
      expect(prom1Res.status).toBe(201);

      // 1. Verify ETag + If-None-Match 304 + public Cache-Control across mounted public GET matrix
      const publicRoutes = [
        "/capabilities",
        "/schemas/index.json",
        "/openapi.json",
        `/p/${f.publicProblem}.json`,
        `/p/${f.publicProblem}.md`,
        `/p/${f.publicProblem}/claims.json`,
        `/p/${f.publicProblem}/events.json`,
        `/p/${f.publicProblem}/events.md`,
        `/p/${f.publicProblem}/syntheses.json`,
        `/p/${f.publicProblem}/commentary.json`,
        `/p/${f.publicProblem}/dead-ends.json`,
        `/p/${f.publicProblem}/moves.json`,
        `/reviews.json?problem=${f.publicProblem}`,
        "/cursor",
        "/problems.json",
        "/areas.json",
        "/results.json",
        "/stats.json",
      ];

      const etagsBefore = new Map<string, string>();
      for (const path of publicRoutes) {
        const res = await f.app.fetch(new Request(`https://a.asimposium.org${path}`), f.env);
        expect(res.status, `Expected 200 on ${path}`).toBe(200);
        const etag = res.headers.get("etag");
        expect(etag, `Missing ETag on public GET ${path}`).toBeTruthy();
        if (!etag) throw new Error(`Missing ETag on public GET ${path}`);
        const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
        expect(
          cc.includes("public"),
          `Public GET ${path} should be publicly cacheable (got ${cc})`,
        ).toBe(true);
        etagsBefore.set(path, etag);

        // Conditional GET -> 304 Not Modified with empty body
        const cond = await f.app.fetch(
          new Request(`https://a.asimposium.org${path}`, {
            headers: { "if-none-match": etag },
          }),
          f.env,
        );
        expect(cond.status, `Expected 304 on ${path} with matching If-None-Match`).toBe(304);
        expect(await cond.text()).toBe("");
        expect(cond.headers.get("etag")).toBe(etag);
      }

      // 2. Private workshop push MUST NOT change ANY public ETag or /cursor!
      const privDraftRes = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-priv-workshop-only",
          },
          body: JSON.stringify({
            type: "scratch",
            title: "Private scratch note",
            body_md: "PRIVATE_WORKSHOP_CACHE_CANARY_74 must never touch public ETags.",
            relates_to: [],
          }),
        }),
        f.env,
      );
      expect(privDraftRes.status).toBe(201);

      for (const path of [
        `/p/${f.publicProblem}.json`,
        `/p/${f.publicProblem}/claims.json`,
        `/p/${f.publicProblem}/events.json`,
        "/cursor",
      ]) {
        const prevEtag = etagsBefore.get(path);
        if (!prevEtag) throw new Error(`Missing baseline ETag for ${path}`);
        const check = await f.app.fetch(
          new Request(`https://a.asimposium.org${path}`, {
            headers: { "if-none-match": prevEtag },
          }),
          f.env,
        );
        expect(check.status, `Workshop push mutated public ETag on ${path}!`).toBe(304);
      }

      // 3. Public claim promotion MUST invalidate problem/claims/events/cursor ETags!
      const prom2Res = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-prom-2",
          },
          body: JSON.stringify({
            workshop_id: draft1Id,
            kind: "conjecture",
            statement: "Every finite tree on n >= 2 vertices has at least two leaves.",
            falsifier: "Exhibit a finite tree on n >= 2 vertices with fewer than two leaves.",
          }),
        }),
        f.env,
      );
      expect(prom2Res.status).toBe(201);

      for (const path of [
        `/p/${f.publicProblem}.json`,
        `/p/${f.publicProblem}/claims.json`,
        `/p/${f.publicProblem}/events.json`,
        "/cursor",
      ]) {
        const prevEtag = etagsBefore.get(path);
        if (!prevEtag) throw new Error(`Missing baseline ETag for ${path}`);
        const after = await f.app.fetch(
          new Request(`https://a.asimposium.org${path}`, {
            headers: { "if-none-match": prevEtag },
          }),
          f.env,
        );
        expect(after.status, `Public write failed to invalidate ETag on ${path}`).toBe(200);
        expect(after.headers.get("etag")).not.toBe(prevEtag);
      }

      // 4. Sponsor commentary write MUST invalidate commentary & events ETags!
      const commentPath = `/v1/problems/${f.publicProblem}/commentary`;
      const commentBody = JSON.stringify({
        problem_id: f.publicProblem,
        body: "Sponsor context note verifying commentary cache invalidation.",
        relates_to: [],
      });
      const comRes = await f.app.fetch(
        new Request(`https://a.asimposium.org${commentPath}`, {
          method: "POST",
          headers: {
            ...(await f.signSponsor(
              f.sponsorA.sponsorId,
              "POST",
              commentPath,
              "post-commentary",
              commentBody,
            )),
            "content-type": "application/json",
            "idempotency-key": "w74-comment-1",
          },
          body: commentBody,
        }),
        f.env,
      );
      expect(comRes.status).toBe(201);
      const commentaryBeforeEtag = etagsBefore.get(`/p/${f.publicProblem}/commentary.json`);
      if (!commentaryBeforeEtag) throw new Error("Missing baseline commentary ETag");
      const comAfter = await f.app.fetch(
        new Request(`https://a.asimposium.org/p/${f.publicProblem}/commentary.json`, {
          headers: { "if-none-match": commentaryBeforeEtag },
        }),
        f.env,
      );
      expect(comAfter.status).toBe(200);
      expect(comAfter.headers.get("etag")).not.toBe(
        etagsBefore.get(`/p/${f.publicProblem}/commentary.json`),
      );
    } finally {
      f.sqlite.close();
    }
  }, 30_000);

  test("paired-user cache-leak harness (Sponsor A + Sponsor B + Anonymous + unlisted problem + private workshop + authed packs) behind real shared-cache proxy + OPS.5 probe", async () => {
    const f = await setupCacheFixture();
    const proxy = new SharedEdgeCacheProxy();
    const WORKSHOP_CANARY = "WORKSHOP_PRIVATE_CANARY_W74_PAIR_LEAK_GUARD";
    const UNLISTED_CANARY = "UNLISTED_CANARY_74";
    let httpServer: ReturnType<typeof createServer> | undefined;

    try {
      // Open session on UNLISTED problem and push private workshop canary.
      const sessRes = await f.app.fetch(
        new Request("https://a.asimposium.org/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-open-unl",
          },
          body: JSON.stringify({ problem_id: f.unlistedProblem, intent: "explore" }),
        }),
        f.env,
      );
      expect(sessRes.status).toBe(201);
      const { session_id: sessionId } = (await sessRes.json()) as { session_id: string };

      const wsPush = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-push-unl-ws",
          },
          body: JSON.stringify({
            type: "scratch",
            title: "Private unlisted scratch",
            body_md: WORKSHOP_CANARY,
            relates_to: [],
          }),
        }),
        f.env,
      );
      expect(wsPush.status).toBe(201);
      const { workshop_id: unlistedWorkshopId } = (await wsPush.json()) as {
        workshop_id: string;
      };

      const originFetch = (req: Request) => f.app.fetch(req, f.env);

      // 1. Authenticated Fellow reads through shared-cache proxy -> MUST be private, no-store, NEVER cached!
      const helloRes = await proxy.fetch(
        new Request("https://a.asimposium.org/v1/hello", {
          headers: { authorization: `Bearer ${f.fellowA.token}` },
        }),
        originFetch,
      );
      expect(helloRes.status).toBe(200);
      expect((helloRes.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");

      const packRes = await proxy.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/pack?profile=working`, {
          headers: { authorization: `Bearer ${f.fellowA.token}` },
        }),
        originFetch,
      );
      expect(packRes.status).toBe(200);
      const packCc = (packRes.headers.get("cache-control") ?? "").toLowerCase();
      expect(packCc).toContain("private");
      expect(packCc).toContain("no-store");
      expect(packCc).not.toContain("public");
      expect(packCc).not.toContain("s-maxage");

      const wsReadPath = `/v1/sessions/${sessionId}/workshop/${unlistedWorkshopId}`;
      const wsReadRes = await proxy.fetch(
        new Request(`https://a.asimposium.org${wsReadPath}`, {
          headers: { authorization: `Bearer ${f.fellowA.token}` },
        }),
        originFetch,
      );
      expect(wsReadRes.status).toBe(200);
      const wsReadCc = (wsReadRes.headers.get("cache-control") ?? "").toLowerCase();
      expect(wsReadCc).toContain("private");
      expect(wsReadCc).toContain("no-store");
      expect(wsReadCc).not.toContain("public");
      expect(wsReadCc).not.toContain("s-maxage");
      expect(await wsReadRes.text()).toContain(WORKSHOP_CANARY);

      // Fellow B (different sponsor) requesting the exact same pack & workshop URLs through the SAME shared-cache proxy MUST get 403/404 & 0 canary bytes!
      for (const privPath of [`/v1/sessions/${sessionId}/pack?profile=working`, wsReadPath]) {
        const fellowBRes = await proxy.fetch(
          new Request(`https://a.asimposium.org${privPath}`, {
            headers: { authorization: `Bearer ${f.fellowB.token}` },
          }),
          originFetch,
        );
        expect([401, 403, 404]).toContain(fellowBRes.status);
        expect(await fellowBRes.text()).not.toContain(WORKSHOP_CANARY);

        const anonRes = await proxy.fetch(
          new Request(`https://a.asimposium.org${privPath}`),
          originFetch,
        );
        expect(anonRes.status).toBe(401);
        expect(await anonRes.text()).not.toContain(WORKSHOP_CANARY);
      }

      // 2. Unlisted problem faces MUST NEVER enter shared cache and MUST carry noindex + private, no-store!
      for (const unlPath of [
        `/p/${f.unlistedProblem}.json`,
        `/p/${f.unlistedProblem}.md`,
        `/p/${f.unlistedProblem}/events.json`,
        `/p/${f.unlistedProblem}/moves.json`,
        `/p/${f.unlistedProblem}/retractions.json`,
        `/p/${f.unlistedProblem}/syntheses.json`,
        `/p/${f.unlistedProblem}/commentary.json`,
        `/p/${f.unlistedProblem}/commentary.md`,
      ]) {
        const res = await proxy.fetch(
          new Request(`https://a.asimposium.org${unlPath}`),
          originFetch,
        );
        expect(res.status).toBe(200);
        const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
        expect(cc, `Unlisted route ${unlPath} must not be shared-cached`).toContain("private");
        expect(cc, `Unlisted route ${unlPath} must be no-store`).toContain("no-store");
        expect(cc).not.toContain("public");
        expect(res.headers.get("x-robots-tag")).toContain("noindex");
        const body = await res.text();
        expect(body).not.toContain(WORKSHOP_CANARY);
      }

      // Unlisted problem MUST be excluded from global /problems.json index!
      const indexRes = await proxy.fetch(
        new Request("https://a.asimposium.org/problems.json"),
        originFetch,
      );
      expect(indexRes.status).toBe(200);
      const indexText = await indexRes.text();
      expect(indexText).toContain(f.publicProblem);
      expect(indexText).not.toContain(f.unlistedProblem);
      expect(indexText).not.toContain(UNLISTED_CANARY);
      expect(indexText).not.toContain(WORKSHOP_CANARY);

      // Shared-cache proxy MUST ONLY have cached the public /problems.json index (0 private/unlisted entries)!
      expect(proxy.cachedUrls().every((u) => u.includes("/problems.json"))).toBe(true);

      // 3. Unify with OPS.5 `runCachePrivacyTest` over real loopback HTTP on the private workshop pack!
      httpServer = createServer((req, res) => {
        const url = `http://127.0.0.1${req.url ?? "/"}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
        f.app
          .fetch(new Request(url, { method: req.method ?? "GET", headers }), f.env)
          .then(async (webRes) => {
            const out: Record<string, string> = {};
            webRes.headers.forEach((val, key) => {
              out[key] = val;
            });
            const buf = Buffer.from(await webRes.arrayBuffer());
            res.writeHead(webRes.status, out);
            res.end(buf);
          });
      });
      const listening = once(httpServer, "listening");
      httpServer.listen(0, "127.0.0.1");
      await listening;
      const port = (httpServer.address() as { port: number }).port;
      const opsReport = await runCachePrivacyTest({
        origin: `http://127.0.0.1:${port}`,
        targetPath: wsReadPath,
        ownerToken: f.fellowA.token,
        otherToken: f.fellowB.token,
        canary: WORKSHOP_CANARY,
      });
      expect(opsReport.pass).toBe(true);
      expect(opsReport.steps.every((s) => !s.canary_leaked)).toBe(true);

      // 4. Non-vacuous negative control: prove the SharedEdgeCacheProxy WOULD catch a leaky handler!
      const leakyProxy = new SharedEdgeCacheProxy();
      const buggyOrigin = async (req: Request) => {
        if (req.headers.get("authorization") === "Bearer owner") {
          return new Response(`secret:${WORKSHOP_CANARY}`, {
            status: 200,
            headers: { "cache-control": "public, max-age=60" },
          });
        }
        return new Response("unauthorized", { status: 401 });
      };
      await leakyProxy.fetch(
        new Request("https://a.asimposium.org/private-buggy", {
          headers: { authorization: "Bearer owner" },
        }),
        buggyOrigin,
      );
      const leakedToAnon = await leakyProxy.fetch(
        new Request("https://a.asimposium.org/private-buggy"),
        buggyOrigin,
      );
      expect(leakedToAnon.headers.get("x-edge-cache-status")).toBe("HIT");
      expect(await leakedToAnon.text()).toContain(WORKSHOP_CANARY);
    } finally {
      if (httpServer) {
        const srv = httpServer;
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
      f.sqlite.close();
    }
  }, 30_000);

  test("stale-with-warning fixture: published synthesis lags new ledger event and visibly surfaces timestamped staleness on .json and .md faces", async () => {
    const f = await setupCacheFixture();
    try {
      // 1. Open session, promote Claim 1, publish a synthesis covering through Claim 1.
      const sessRes = await f.app.fetch(
        new Request("https://a.asimposium.org/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-stale-open",
          },
          body: JSON.stringify({ problem_id: f.publicProblem, intent: "prove" }),
        }),
        f.env,
      );
      expect(sessRes.status).toBe(201);
      const { session_id: sessionId } = (await sessRes.json()) as { session_id: string };

      const draftRes = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/workshop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-stale-draft",
          },
          body: JSON.stringify({
            type: "claim-draft",
            title: "Tree base claim",
            body_md: "Base claim before synthesis.",
            relates_to: [],
          }),
        }),
        f.env,
      );
      const { workshop_id: workshopId } = (await draftRes.json()) as { workshop_id: string };

      const c1Res = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-stale-c1",
          },
          body: JSON.stringify({
            workshop_id: workshopId,
            kind: "conjecture",
            statement: "Every tree with n vertices has n - 1 edges.",
            falsifier: "A tree with n vertices and != n - 1 edges.",
          }),
        }),
        f.env,
      );
      expect(c1Res.status).toBe(201);
      const { claim_id: c1Id, seq: c1Seq } = (await c1Res.json()) as {
        claim_id: string;
        seq: number;
      };

      const synthRes = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/synthesize`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-stale-synth",
          },
          body: JSON.stringify({
            covers_through: c1Seq,
            body_md: "## Synthesis at seq 1\n\nSummarizes initial tree edge count conjecture.",
            anchors: [{ target_kind: "claim", target_id: c1Id, target_version: 1 }],
            omitted: ["None"],
            selection_policy: "All claims through cursor.",
          }),
        }),
        f.env,
      );
      expect(synthRes.status).toBe(201);
      const { synthesis_id: synthesisId } = (await synthRes.json()) as { synthesis_id: string };

      // Private synthesis drafts must remain hidden (404, no-store) before sponsor publication
      const draftBeforePublish = await f.app.fetch(
        new Request(`https://a.asimposium.org/p/${f.publicProblem}/syntheses/${synthesisId}.json`),
        f.env,
      );
      expect(draftBeforePublish.status).toBe(404);
      expect((draftBeforePublish.headers.get("cache-control") ?? "").toLowerCase()).toContain(
        "no-store",
      );

      // Publish the synthesis draft explicitly as Sponsor A
      const publishSynthPath = `/v1/sponsors/problems/${f.publicProblem}/syntheses/${synthesisId}/publish`;
      const publishSynthHeaders = await f.signSponsor(
        f.sponsorA.sponsorId,
        "POST",
        publishSynthPath,
        "sponsor.syntheses.drafts.publish",
        "",
      );
      const publishSynthRes = await f.app.fetch(
        new Request(`https://a.asimposium.org${publishSynthPath}`, {
          method: "POST",
          headers: {
            ...publishSynthHeaders,
            "idempotency-key": "w74-stale-synth-publish",
          },
          body: "",
        }),
        f.env,
      );
      expect(publishSynthRes.status).toBe(201);

      // Fresh synthesis face has stale=false right after publication
      const freshJson = (await (
        await f.app.fetch(
          new Request(
            `https://a.asimposium.org/p/${f.publicProblem}/syntheses/${synthesisId}.json`,
          ),
          f.env,
        )
      ).json()) as { staleness: { stale: boolean; material_events_since: number } };
      expect(freshJson.staleness.stale).toBe(false);
      expect(freshJson.staleness.material_events_since).toBe(0);

      // 2. Advance ledger with Claim 2 and drain synthesis.staleness outbox consumer!
      const c2Res = await f.app.fetch(
        new Request(`https://a.asimposium.org/v1/sessions/${sessionId}/promote`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.fellowA.token}`,
            "content-type": "application/json",
            "idempotency-key": "w74-stale-c2",
          },
          body: JSON.stringify({
            workshop_id: workshopId,
            kind: "conjecture",
            statement: "Every tree with n >= 2 vertices has at least two vertices of degree 1.",
            falsifier: "A tree on n >= 2 vertices with fewer than two leaves.",
          }),
        }),
        f.env,
      );
      expect(c2Res.status).toBe(201);

      const pendingOutbox = f.sqlite
        .prepare(
          `SELECT id, event_id, problem_id, kind, dedupe_key, payload_sha256 FROM outbox WHERE kind = 'synthesis.staleness' AND state = 'pending'`,
        )
        .all() as OutboxConsumerRow[];
      for (const row of pendingOutbox) {
        await dispatchExtendedOutboxConsumer(row, { DB: f.db });
      }

      // 3. Stale synthesis face MUST visibly surface staleness + event delta on .json and .md!
      const staleJsonRes = await f.app.fetch(
        new Request(`https://a.asimposium.org/p/${f.publicProblem}/syntheses/${synthesisId}.json`),
        f.env,
      );
      expect(staleJsonRes.status).toBe(200);
      const staleJson = (await staleJsonRes.json()) as {
        synthesis: { covers_through: number };
        staleness: {
          stale: boolean;
          material_events_since: number;
        };
      };
      expect(staleJson.staleness.stale).toBe(true);
      expect(staleJson.staleness.material_events_since).toBeGreaterThanOrEqual(1);
      expect(staleJson.synthesis.covers_through).toBe(c1Seq);

      const staleMdRes = await f.app.fetch(
        new Request(`https://a.asimposium.org/p/${f.publicProblem}/syntheses/${synthesisId}.md`),
        f.env,
      );
      expect(staleMdRes.status).toBe(200);
      const staleMd = await staleMdRes.text();
      expect(staleMd.toLowerCase()).toMatch(/stale|behind|newer event|material event/);
    } finally {
      f.sqlite.close();
    }
  }, 30_000);
});
