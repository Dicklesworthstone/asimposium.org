import { describe, expect, test } from "bun:test";
import {
  GapFiledResponseSchema,
  PackResponseSchema,
  PromoteResponseSchema,
  type ScreeningPublicationNotice,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import { ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import { createApp } from "../../src/app";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service";
import type { Env } from "../../src/env";
import { loadProofGaps } from "../../src/ledger/proof-gaps-service";
import { loadProofGapMove } from "../../src/mega-commands/gap-moves-service";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import { readFormalGapSection } from "../../src/sessions/formal-pack";
import { PROBLEM, publicationContextFixture, SPONSOR } from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

const ORIGIN = "https://a.asimposium.org";
const REPLAY_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WARNING: ScreeningPublicationNotice = {
  category: "dual-use-boundary",
  action: "published-with-warning",
  notice: "screening-warning",
};
const OFF_SCOPE: ScreeningPublicationNotice = {
  category: "off-topic",
  action: "published-with-warning",
  notice: "off-scope",
};
const OBLIGATION =
  "WARNING-GAP: establish a uniform bound before exchanging the limit and integral.";
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const f = await publicationContextFixture();
  try {
    await fn(f);
  } finally {
    f.sql.close();
  }
}

// Actual authenticated routes and atomic writers on every shipped migration.
// The classifier is synthetic; Workerd separately exercises native D1 bindings.
async function routeFixture(f: Fixture) {
  let screens = 0;
  const app = createApp({
    screenPromotion: async (input) => {
      screens++;
      return syntheticScreeningObservation(input, {
        decision: input.kind === "gaps" ? "allow-with-warning" : "pass",
        coarse_category:
          input.kind !== "gaps"
            ? "benign-context"
            : input.statement.includes("OFF-SCOPE-GAP")
              ? "off-topic"
              : "dual-use-boundary",
        provider_status: "ok",
      });
    },
  });
  const env = {
    DB: f.db,
    STOA_ORIGIN: ORIGIN,
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
  } as Env;
  const service = new EnrollmentService({
    stoaOrigin: ORIGIN,
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(f.db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(REPLAY_KEY),
  });
  const sponsor = { type: "sponsor" as const, sponsorId: SPONSOR };
  const grant = await service.mint(sponsor, { requested_scopes: ["promote", "review"] });
  const proposal = await service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "gap-warning-author",
    model: "test/model",
    harness: "curl",
  });
  await service.decide(sponsor, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await service.poll({ flow_handle: proposal.flowHandle });
  if (!("token" in issued)) throw new Error("Expected a durable Fellow credential");
  let serial = 0;
  const request = (path: string, init: RequestInit = {}, authenticated = false) => {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${issued.token}`);
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, env);
  };
  const post = async (
    path: string,
    body: unknown,
    key = `gap-warning-${++serial}`,
    status = 201,
  ) => {
    const response = await request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      },
      true,
    );
    const bytes = await response.text();
    expect(response.status, `${path}: ${bytes}`).toBe(status);
    return JSON.parse(bytes) as unknown;
  };
  const session = SessionOpenResponseSchema.parse(
    await post("/v1/sessions", { problem_id: PROBLEM, intent: "prove" }),
  );
  const path = `/v1/sessions/${session.session_id}`;
  const workshop = WorkshopPushResponseSchema.parse(
    await post(`${path}/workshop`, {
      type: "claim-draft",
      title: "Uniform convergence",
      body_md: "PRIVATE_WORKSHOP_CANARY",
      relates_to: [],
    }),
  );
  const claim = PromoteResponseSchema.parse(
    await post(`${path}/promote`, {
      workshop_id: workshop.workshop_id,
      kind: "conjecture",
      statement: "The uniformly bounded sequence converges under integration.",
      falsifier: "A sequence for which the integral limit is unequal to the limit integral.",
    }),
  );
  const body = {
    target_claim_id: claim.claim_id,
    target_version: 1,
    obligation: OBLIGATION,
    closes_what: "The exchange of the limit with the integral.",
  };
  return { request, post, path, body, claim, screens: () => screens };
}

const formalAt = (f: Fixture, through: number) =>
  readFormalGapSection(f.db, PROBLEM, through, {
    gaps: loadProofGaps,
    neutralize: (text) => text,
  });

describe("proof-gap warning publications", () => {
  test("only the exact filing route admits bound warnings; settlements and mismatched receipts stay held", () =>
    withFixture(async (f) => {
      for (const [kind, route, mismatch, admitted] of [
        ["gaps", "gaps", false, true],
        ["gaps", "promote", false, false],
        ["gap-close", "gaps/close", false, false],
        ["gap-close", "gaps", false, false],
        ["gaps", "gaps", true, false],
      ] as const) {
        const result = await screenPublicCandidate(
          async (input) => ({
            ...(await syntheticScreeningObservation(input, {
              decision: "allow-with-warning",
              coarse_category: "dual-use-boundary",
              provider_status: "ok",
            })),
            ...(mismatch ? { evaluated_body_digest: `sha256:${"f".repeat(64)}` } : {}),
          }),
          { DB: f.db } as Env,
          { ...f.input(OBLIGATION), kind },
          { sponsorId: SPONSOR, route },
        );
        if (admitted) {
          expect(result instanceof Response).toBe(false);
          if (result instanceof Response) throw new Error("Expected exact publication provenance");
          expect(result.provenance.public_action).toEqual(WARNING);
        } else expect(result instanceof Response && result.status).toBe(202);
      }
      expect(f.state().events).toEqual([]);
    }));

  test("filing and replay retain one receipt on faces, claim obligations and formal packs", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const result = GapFiledResponseSchema.parse(
        await route.post(`${route.path}/gaps`, route.body, "gap-warning-publish"),
      );
      const screens = route.screens();
      expect(
        await route.post(`${route.path}/gaps`, route.body, "gap-warning-publish", 200),
      ).toEqual(result);
      expect(route.screens()).toBe(screens);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type='gap.filed'").get()).toEqual({
        n: 1,
      });
      expect(
        f.sql
          .query(
            "SELECT COUNT(*) AS n FROM screening_publications s JOIN events e ON e.id=s.event_id WHERE e.type='gap.filed'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 0 });
      const publicPath = `/p/${PROBLEM}/gaps`;
      const face = ProofGapsResponseSchema.parse(
        await (await route.request(`${publicPath}.json?target=${result.gap_id}`)).json(),
      );
      expect(face.gaps[0]?.screening_notice).toEqual(WARNING);
      expect(face.gaps[0]?.content).toEqual(route.body);
      expect(JSON.stringify(face)).not.toContain("PRIVATE_WORKSHOP_CANARY");
      const stored = f.sql
        .query(
          "SELECT c.payload_json FROM event_content c JOIN events e ON e.id=c.event_id WHERE e.type='gap.filed'",
        )
        .get() as { payload_json: string };
      expect(JSON.parse(stored.payload_json)).toEqual(route.body);
      for (const suffix of ["md", "html"]) {
        const response = await route.request(
          `${publicPath}.${suffix}?through=${result.seq}&target=${result.gap_id}`,
        );
        expect(response.status).toBe(200);
        const bytes = await response.text();
        expect(bytes).toContain(OBLIGATION);
        expect(bytes.indexOf("Published with a screening context notice:")).toBeGreaterThan(-1);
        expect(bytes.indexOf("Published with a screening context notice:")).toBeLessThan(
          bytes.indexOf(OBLIGATION),
        );
      }
      for (const profile of ["claim", "formal"]) {
        const target = profile === "claim" ? `&target=${route.claim.claim_id}@1` : "";
        const response = await route.request(
          `${route.path}/pack?profile=${profile}${target}&max_tokens=8000`,
          {},
          true,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const pack = PackResponseSchema.parse(await response.json());
        const item = pack.items.find((candidate) => candidate.id === result.gap_id);
        if (item === undefined || !("screening_notice" in item)) {
          throw new Error(`The ${profile} pack is missing the gap's screening notice.`);
        }
        expect(item.screening_notice).toEqual(WARNING);
        expect(item.body).toContain(OBLIGATION);
        expect(item.body).not.toContain("screening_notice");
      }
      const calls = route.screens();
      await route.post(
        `${route.path}/gaps`,
        { ...route.body, screening_notice: WARNING },
        "gap-forged-notice",
        422,
      );
      expect(route.screens()).toBe(calls);
    }));

  test("off-scope obligations stay directly readable and leave global gap recommendations", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const body = { ...route.body, obligation: "OFF-SCOPE-GAP: bound a finite graph spectrum." };
      const result = GapFiledResponseSchema.parse(await route.post(`${route.path}/gaps`, body));
      const page = await loadProofGaps(f.db, PROBLEM, { target: result.gap_id });
      expect(page.face.gaps[0]?.screening_notice).toEqual(OFF_SCOPE);
      expect(
        (await formalAt(f, result.seq)).candidates.find((item) => item.id === result.gap_id)
          ?.screening_notice,
      ).toEqual(OFF_SCOPE);
      expect((await loadProofGapMove(f.db, PROBLEM, result.seq, Date.now())).move?.refs).toContain(
        result.gap_id,
      );
      expect(
        (await loadProofGapMove(f.db, PROBLEM, result.seq, Date.now(), { excludeOffScope: true }))
          .move,
      ).toBeNull();
    }));

  test("filing notices survive ordinary settlements without borrowing the settlement's screening result", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const result = GapFiledResponseSchema.parse(
        await route.post(`${route.path}/gaps`, route.body),
      );
      await route.post(`${route.path}/gaps/close`, { gap_id: result.gap_id, outcome: "withdrawn" });
      const current = (await loadProofGaps(f.db, PROBLEM)).face.gaps[0];
      expect(current?.status).toBe("withdrawn");
      expect(current?.screening_notice).toEqual(WARNING);
      expect(
        (await loadProofGaps(f.db, PROBLEM, { through: result.seq })).face.gaps[0]?.status,
      ).toBe("open");
    }));

  test("current controls remove notice and prose from every old face and pack before conditional responses", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const result = GapFiledResponseSchema.parse(
        await route.post(`${route.path}/gaps`, route.body),
      );
      const paths = ["json", "md", "html"].flatMap((suffix) => [
        `/p/${PROBLEM}/gaps.${suffix}?through=${result.seq}&target=${result.gap_id}`,
        `/p/${PROBLEM}/claims/${route.claim.claim_id}@1.${suffix}?through=${result.seq}`,
      ]);
      const original = await Promise.all(
        paths.map(async (path) => ({
          path,
          etag: (await route.request(path)).headers.get("etag")!,
        })),
      );
      for (const target of [
        result.gap_id,
        `${result.gap_id}@1`,
        `#${result.seq}`,
        "problem",
        PROBLEM,
      ]) {
        f.visible(target, "hidden", 1);
        for (const before of original) {
          const hidden = await route.request(before.path, {
            headers: { "if-none-match": before.etag },
          });
          expect(hidden.status, target).not.toBe(304);
          const text = await hidden.text();
          expect(text).not.toContain(OBLIGATION);
          expect(text).not.toContain("screening-warning");
          expect(text).not.toContain("Published with a screening context notice:");
        }
        const pack = await formalAt(f, result.seq);
        expect(JSON.stringify(pack)).not.toContain(OBLIGATION);
        expect(JSON.stringify(pack)).not.toContain("screening-warning");
        const claim = await route.request(
          `/p/${PROBLEM}/claims/${route.claim.claim_id}@1.json?through=${result.seq}`,
        );
        expect(claim.status, target).toBe(
          target === PROBLEM ? 404 : target === "problem" ? 403 : 200,
        );
        expect(await claim.text()).not.toContain(OBLIGATION);
        f.visible(target, "visible", 2);
        for (const before of original)
          expect(
            (await route.request(before.path, { headers: { "if-none-match": before.etag } }))
              .status,
            target,
          ).toBe(304);
      }
    }));

  test("a whole-problem control between claim head and snapshot reads returns an opaque absence", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const result = GapFiledResponseSchema.parse(
        await route.post(`${route.path}/gaps`, route.body),
      );
      const path = `/p/${PROBLEM}/claims/${route.claim.claim_id}@1.json?through=${result.seq}`;
      const original = await route.request(path);
      expect(original.status).toBe(200);
      const etag = original.headers.get("etag")!;
      const originalBatch = f.db.batch.bind(f.db);
      let pendingHide = true;
      f.db.batch = (async (statements) => {
        if (pendingHide) {
          pendingHide = false;
          f.visible(PROBLEM, "hidden", 1);
        }
        return originalBatch(statements);
      }) as typeof f.db.batch;
      const hidden = await route.request(path, { headers: { "if-none-match": etag } });
      expect(pendingHide).toBe(false);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toMatchObject({ code: "CLAIM_NOT_FOUND" });
      const head = await route.request(path, {
        method: "HEAD",
        headers: { "if-none-match": etag },
      });
      expect(head.status).toBe(404);
      expect(await head.text()).toBe("");
      f.visible(PROBLEM, "visible", 2);
      expect((await route.request(path, { headers: { "if-none-match": etag } })).status).toBe(304);
    }));
});
