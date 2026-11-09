import { describe, expect, test } from "bun:test";
import {
  DeadEndsListResponseSchema,
  PackResponseSchema,
  RecordDeadEndResponseSchema,
  type ScreeningPublicationNotice,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { createApp } from "../../src/app";
import { loadFellowCard } from "../../src/discovery/fellow-service";
import { loadNowStrip } from "../../src/discovery/now-service";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service";
import type { Env } from "../../src/env";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import { readDeadEndPack } from "../../src/sessions/ledger-pack";
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
const BODY = {
  approach: "WARNING-NEGATIVE: enumerate every modular residue below the fixed bound.",
  why_it_fails: "Longer periods remain outside the examined finite residue classes.",
  retry_predicate: "Retry when an exact finite reduction bounds every possible period.",
  retry_when: { kind: "statement-revised" as const },
};
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const f = await publicationContextFixture();
  try {
    await fn(f);
  } finally {
    f.sql.close();
  }
}

// Real routes, writers and every shipped migration on native SQLite. Only the
// classifier is synthetic; the Workerd lane separately proves native bindings.
async function routeFixture(f: Fixture) {
  let screens = 0;
  const app = createApp({
    screenPromotion: async (input) => {
      screens++;
      return syntheticScreeningObservation(input, {
        decision: "allow-with-warning",
        coarse_category: input.statement.includes("OFF-SCOPE-NEGATIVE")
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
    name: "negative-warning-author",
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
    key = `negative-warning-${++serial}`,
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
    await post("/v1/sessions", { problem_id: PROBLEM, intent: "explore" }),
  );
  return { request, post, session, screens: () => screens };
}

describe("dead-end warning publications", () => {
  test("only the exact Fellow or sponsor publication routes can publish a bound warning", () =>
    withFixture(async (f) => {
      for (const route of ["dead-ends", "sponsor-workshop"]) {
        const screened = await screenPublicCandidate(
          (input) =>
            syntheticScreeningObservation(input, {
              decision: "allow-with-warning",
              coarse_category: "off-topic",
              provider_status: "ok",
            }),
          { DB: f.db } as Env,
          { ...f.input(BODY.approach), kind: "dead-end" },
          { sponsorId: SPONSOR, route },
        );
        expect(screened instanceof Response).toBe(false);
        if (screened instanceof Response) throw new Error("Expected exact publication provenance");
        expect(screened.provenance.public_action).toEqual(OFF_SCOPE);
      }
      for (const [route, digest] of [
        ["promote", false],
        ["dead-ends", true],
      ] as const) {
        const screened = await screenPublicCandidate(
          async (input) => ({
            ...(await syntheticScreeningObservation(input, {
              decision: "allow-with-warning",
              coarse_category: "dual-use-boundary",
              provider_status: "ok",
            })),
            ...(digest ? { evaluated_body_digest: `sha256:${"f".repeat(64)}` } : {}),
          }),
          { DB: f.db } as Env,
          { ...f.input(BODY.approach), kind: "dead-end" },
          { sponsorId: SPONSOR, route },
        );
        expect(screened instanceof Response && screened.status).toBe(202);
      }
      expect(f.state().events).toEqual([]);
    }));

  test("real publication and replay preserve warning metadata on faces, histories and every dead-end pack", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const path = `/v1/sessions/${route.session.session_id}/dead-ends`;
      const result = RecordDeadEndResponseSchema.parse(
        await route.post(path, BODY, "negative-warning-publish"),
      );
      const calls = route.screens();
      expect(await route.post(path, BODY, "negative-warning-publish", 200)).toEqual(result);
      expect(route.screens()).toBe(calls);
      expect(f.state().events).toHaveLength(1);
      expect(f.state().receipts).toHaveLength(1);
      expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_cases").get()).toEqual({ n: 0 });
      const content = f.sql.query("SELECT payload_json FROM event_content").get() as {
        payload_json: string;
      };
      expect(content.payload_json).not.toContain("screening_notice");
      expect(content.payload_json).not.toContain("published-with-warning");
      const face = DeadEndsListResponseSchema.parse(
        await (await route.request(`/p/${PROBLEM}/dead-ends.json`)).json(),
      );
      expect(face.dead_ends[0]?.screening_notice).toEqual(WARNING);
      for (const extension of ["md", "html"]) {
        const response = await route.request(`/p/${PROBLEM}/dead-ends.${extension}`);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("Published with a screening context notice:");
        expect(text).toContain(BODY.approach);
        expect(text.indexOf("Published with a screening context notice:")).toBeLessThan(
          text.indexOf(BODY.approach),
        );
      }
      expect(
        (await loadFellowCard(f.db, "negative-warning-author"))?.negative_history[0]
          ?.screening_notice,
      ).toEqual(WARNING);
      for (const profile of ["orient", "working", "graveyard", "full"] as const) {
        const response = await route.request(
          `/v1/sessions/${route.session.session_id}/pack?profile=${profile}&max_tokens=8000`,
          {},
          true,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const pack = PackResponseSchema.parse(await response.json());
        const items = pack.items.filter((item) => item.body.includes(BODY.approach));
        expect(items.length, profile).toBeGreaterThan(0);
        for (const item of items) {
          if (!("screening_notice" in item))
            throw new Error(`${profile} lost the publication notice`);
          expect(item.screening_notice).toEqual(WARNING);
          if (profile === "full") {
            const record = JSON.parse(item.body);
            expect(record.publication.screening_notice).toEqual(WARNING);
            expect(record.content.screening_notice).toBeUndefined();
          } else expect(item.body).not.toContain("screening_notice");
        }
      }
    }));

  test("off-scope negative work remains directly readable but leaves global discovery", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const body = {
        ...BODY,
        approach: "OFF-SCOPE-NEGATIVE: enumerate finite graph spectra under a fixed vertex bound.",
      };
      const result = RecordDeadEndResponseSchema.parse(
        await route.post(`/v1/p/${PROBLEM}/dead-ends`, body),
      );
      const face = DeadEndsListResponseSchema.parse(
        await (await route.request(`/p/${PROBLEM}/dead-ends.json`)).json(),
      );
      expect(face.dead_ends[0]?.screening_notice).toEqual(OFF_SCOPE);
      expect(
        (await loadFellowCard(f.db, "negative-warning-author"))?.negative_history[0]
          ?.screening_notice,
      ).toEqual(OFF_SCOPE);
      expect(JSON.stringify(await loadNowStrip(f.db))).not.toContain(result.dead_end_id);
      const pack = await readDeadEndPack(f.db, PROBLEM, result.seq, "graveyard");
      expect(pack.candidates[0]?.screening_notice).toEqual(OFF_SCOPE);
      expect(pack.candidates[0]?.body).toContain(body.approach);
    }));

  test("current controls remove both body and notice from historical packs, faces and Fellow history before ETag reuse", () =>
    withFixture(async (f) => {
      const route = await routeFixture(f);
      const result = RecordDeadEndResponseSchema.parse(
        await route.post(`/v1/sessions/${route.session.session_id}/dead-ends`, BODY),
      );
      const publicPath = `/p/${PROBLEM}/dead-ends.json`;
      const original = await route.request(publicPath);
      const etag = original.headers.get("etag");
      expect(etag).not.toBeNull();
      for (const target of [
        result.dead_end_id,
        `${result.dead_end_id}@1`,
        `#${result.seq}`,
        "problem",
        PROBLEM,
      ]) {
        f.visible(target, "hidden", 1);
        const hidden = await route.request(publicPath, {
          headers: { "if-none-match": etag ?? "" },
        });
        expect(hidden.status, target).toBe(target === "problem" ? 403 : 200);
        if (target === "problem") {
          expect(await hidden.json()).toMatchObject({ code: "CONTENT_HIDDEN" });
        } else {
          const face = DeadEndsListResponseSchema.parse(await hidden.json());
          expect(face.dead_ends).toEqual([]);
          expect(face.omitted.some((reason) => reason.includes("unavailable"))).toBe(true);
        }
        for (const extension of ["md", "html"]) {
          const text = await (await route.request(`/p/${PROBLEM}/dead-ends.${extension}`)).text();
          expect(text).not.toContain(BODY.approach);
          expect(text).not.toContain("Published with a screening context notice:");
        }
        const oldPack = await readDeadEndPack(f.db, PROBLEM, result.seq, "graveyard");
        expect(oldPack.candidates).toEqual([]);
        expect(oldPack.omitted).toContainEqual({
          reason: "content_unavailable",
          detail: "public-dead-ends",
        });
        expect((await loadFellowCard(f.db, "negative-warning-author"))?.negative_history).toEqual(
          [],
        );
        f.visible(target, "visible", 2);
        const restored = await route.request(publicPath, {
          headers: { "if-none-match": etag ?? "" },
        });
        expect(restored.status, target).toBe(304);
      }
    }));
});
