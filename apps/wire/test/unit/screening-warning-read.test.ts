import { describe, expect, test } from "bun:test";
import {
  ClaimFaceResponseSchema,
  type PackResponse,
  PackResponseSchema,
  ProblemFaceResponseSchema,
  PromoteResponseSchema,
  ReviseResponseSchema,
  type ScreeningPublicationNotice,
  SearchResponseSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { createApp } from "../../src/app";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service";
import type { Env } from "../../src/env";
import { parseEventTailToon } from "../../src/ledger/event-tail-http";
import { findScientificClaim } from "../../src/ledger/scientific-checks";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import { rebuildSearchIndex } from "../../src/search/index-health";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

const ORIGIN = "https://a.asimposium.org";
const REPLAY_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ORIGINAL = "WarningReadOriginal: every member of this finite set has even parity.";
const REVISED = "WarningReadRevised: every nonempty member of this finite set has even parity.";
const DEPENDENT = "WarningReadDependent: the original finite set has an even total.";
const FALSIFIER = "An explicitly enumerated member with odd parity.";
const ORIGINAL_NOTICE: ScreeningPublicationNotice = {
  category: "dual-use-boundary",
  action: "published-with-warning",
  notice: "screening-warning",
};
const REVISED_NOTICE: ScreeningPublicationNotice = {
  ...ORIGINAL_NOTICE,
  category: "injection",
};

type DatabaseFixture = Awaited<ReturnType<typeof publicationContextFixture>>;

// Native SQLite with every shipped migration, durable enrollment, real mounted
// production routes and writers. Only the classifier is synthetic. This is not
// a Workerd, deployed cache, browser or live-provider acceptance test.
async function readFixture(f: DatabaseFixture) {
  const env = {
    DB: f.db,
    STOA_ORIGIN: ORIGIN,
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
  } as Env;
  const screener = async (input: Parameters<typeof syntheticScreeningObservation>[0]) =>
    syntheticScreeningObservation(
      input,
      input.statement.includes(ORIGINAL) || input.statement.includes(REVISED)
        ? {
            decision: "allow-with-warning",
            coarse_category: input.statement.includes(ORIGINAL) ? "dual-use-boundary" : "injection",
            provider_status: "ok",
          }
        : { decision: "pass", coarse_category: "benign-context", provider_status: "ok" },
    );
  const app = createApp({ screenPromotion: screener });
  const request = (path: string, init: RequestInit = {}, token?: string) => {
    const headers = new Headers(init.headers);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, env);
  };
  let serial = 0;
  const post = async (path: string, body: unknown, token: string, status = 201) => {
    const response = await request(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `warning-read-${++serial}`,
        },
        body: JSON.stringify(body),
      },
      token,
    );
    const bytes = await response.text();
    expect(response.status, `${path}: ${bytes}`).toBe(status);
    return JSON.parse(bytes) as unknown;
  };
  const service = new EnrollmentService({
    stoaOrigin: ORIGIN,
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(f.db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(REPLAY_KEY),
  });
  const enroll = async (name: string) => {
    const principal = { type: "sponsor" as const, sponsorId: `usr_warning_${name}` };
    await service.bootstrapSponsor(principal);
    const grant = await service.mint(principal, { requested_scopes: ["promote", "review"] });
    const proposal = await service.claim({
      enrollment_id: grant.enrollmentId,
      secret: grant.secret,
      name: `warning-${name}`,
      model: "test/model",
      harness: "curl",
    });
    await service.decide(principal, grant.enrollmentId, {
      enrollment_id: grant.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await service.poll({ flow_handle: proposal.flowHandle });
    if (!("token" in issued)) throw new Error("The warning fixture needs an issued credential.");
    return issued.token;
  };
  const author = await enroll("author");
  const reviewer = await enroll("reviewer");

  // Turn the seed's formulation into a genuine, digest-bound publication before
  // any claim is written. Its clean receipt must not inherit a claim's warning.
  f.sql
    .query("UPDATE problems SET status='private-draft',created_by_fellow_id=? WHERE id=?")
    .run(FELLOW, PROBLEM);
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (preview === undefined) throw new Error("The warning fixture needs a publication preview.");
  const snapshot = f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Parameters<
    typeof applyPublicProblemGovernance
  >[1];
  const publication = await applyPublicProblemGovernance(
    f.db,
    snapshot,
    SPONSOR,
    {
      action: "publish",
      reviewed_statement_version: preview.problem.current_statement_version,
      reviewed_digest: preview.review_digest,
    },
    new Request(`${ORIGIN}/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
      method: "POST",
      headers: { "idempotency-key": "warning-read-formulation" },
    }),
    {
      sponsorLimit: 100,
      screen: () =>
        screenPublicCandidate(
          screener,
          env,
          {
            ...f.input(
              "Context problem\n\nExact public problem statement.\n\nExact public motivation.",
            ),
            kind: "problem-proposal",
            falsifier: "Exact public falsifier.",
          },
          { sponsorId: SPONSOR, route: "problem-proposal" },
        ),
    },
  );
  expect(publication.status, await publication.text()).toBe(200);
  const reviewerSession = SessionOpenResponseSchema.parse(
    await post("/v1/sessions", { problem_id: PROBLEM, intent: "review" }, reviewer),
  ).session_id;
  await post(
    `/v1/problems/${PROBLEM}/statement-review`,
    {
      session_id: reviewerSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite set, parity predicate and explicit falsifier are separately stated.",
    },
    reviewer,
    200,
  );

  const provenance = {
    model_family_self_declared: "test",
    method: { category: "deductive", procedure: "Enumerate each finite member.", evidence: [] },
  };
  const original = PromoteResponseSchema.parse(
    await post(
      `/v1/p/${PROBLEM}/claims`,
      {
        kind: "conjecture",
        statement: ORIGINAL,
        falsifier: FALSIFIER,
        scientific_provenance: provenance,
      },
      author,
    ),
  );
  const dependent = PromoteResponseSchema.parse(
    await post(
      `/v1/p/${PROBLEM}/claims`,
      {
        kind: "conjecture",
        statement: DEPENDENT,
        falsifier: "An odd total from the specified finite set.",
        scientific_provenance: provenance,
        depends_on: [original.claim_id],
      },
      author,
    ),
  );
  const authorSession = SessionOpenResponseSchema.parse(
    await post("/v1/sessions", { problem_id: PROBLEM, intent: "explore" }, author),
  ).session_id;
  const revised = ReviseResponseSchema.parse(
    await post(
      `/v1/sessions/${authorSession}/revise`,
      {
        claim_id: original.claim_id,
        base_version: 1,
        kind: "conjecture",
        statement: REVISED,
        falsifier: FALSIFIER,
        scientific_provenance: provenance,
      },
      author,
    ),
  );
  // Exercise the production derived-index builder; an asynchronous outbox
  // delivery is intentionally outside this in-process SQLite fixture.
  await rebuildSearchIndex(f.db, PROBLEM);
  const pack = async (profile: string, target?: string) => {
    const params = new URLSearchParams({ profile, max_tokens: "8000" });
    if (target !== undefined) params.set("target", target);
    const response = await request(`/v1/sessions/${reviewerSession}/pack?${params}`, {}, reviewer);
    const bytes = await response.text();
    expect(response.status, bytes).toBe(200);
    return PackResponseSchema.parse(JSON.parse(bytes));
  };
  const visibility = (target: string, visible: boolean) => {
    const current = f.sql
      .query(
        "SELECT COALESCE(MAX(version),0) AS version FROM content_controls WHERE problem_id=? AND target_ref=?",
      )
      .get(PROBLEM, target) as { version: number };
    f.sql
      .query(`INSERT INTO content_controls
        (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
        VALUES (?,?,'ledger-object',?,?,'operator','privacy','operator-warning',
          'Synthetic late-hide boundary.',?,?)`)
      .run(
        `CC-WARNING-READ-${++serial}`,
        PROBLEM,
        target,
        visible ? "visible" : "hidden",
        current.version + 1,
        new Date().toISOString(),
      );
  };
  const hide = () => visibility(original.claim_id, false);
  return { ...f, request, pack, original, dependent, revised, hide, visibility };
}

type Fixture = Awaited<ReturnType<typeof readFixture>>;
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const f = await publicationContextFixture();
  try {
    await run(await readFixture(f));
  } finally {
    f.sql.close();
  }
}

function ledgerItem(pack: PackResponse, kind: string, id: string) {
  const item = pack.items.find((value) => value.kind === kind && value.id === id);
  expect(item, `${pack.profile} must include ${kind} ${id}`).toBeDefined();
  if (item?.scope !== "ledger") throw new Error("Expected an untrusted public ledger item.");
  expect(item.untrusted).toBe(true);
  return item;
}

async function publicBytes(f: Fixture, path: string) {
  const response = await f.request(path);
  const bytes = await response.text();
  expect(response.status, `${path}: ${bytes}`).toBe(200);
  return { response, bytes };
}

function requiredEtag(response: { headers: Headers }) {
  const etag = response.headers.get("etag");
  expect(etag).toBeTruthy();
  if (etag === null) throw new Error("The visible fixture response needs an ETag.");
  return etag;
}

describe("mounted reads of published screening warnings", () => {
  test("claim boards derive premise staleness from the same scientific cut as exact faces", () =>
    withFixture(async (f) => {
      // Deliberately lag the derived flag after the real writer revised the
      // premise. A board must retain the dependent's immutable statement and
      // report its broken pin even before any projection repair runs.
      f.sql.query("UPDATE claim_projections SET stale=0 WHERE problem_id=? AND claim_id=?")
        .run(PROBLEM, f.dependent.claim_id);
      // The inverse cache error must not manufacture staleness for a clean
      // current root either: scientific standing is read from its events.
      f.sql.query("UPDATE claim_projections SET stale=1 WHERE problem_id=? AND claim_id=?")
        .run(PROBLEM, f.original.claim_id);

      const board = JSON.parse((await publicBytes(f, `/p/${PROBLEM}/claims.json`)).bytes) as {
        claims: { id: string; statement: string; stale: boolean }[];
      };
      expect(board.claims.find((claim) => claim.id === f.dependent.claim_id)).toMatchObject({
        statement: DEPENDENT,
        stale: true,
      });
      expect(board.claims.find((claim) => claim.id === f.original.claim_id)).toMatchObject({
        statement: REVISED,
        stale: false,
      });
      const detail = ClaimFaceResponseSchema.parse(JSON.parse((await publicBytes(
        f, `/p/${PROBLEM}/claims/${f.dependent.claim_id}@1.json`,
      )).bytes));
      expect(detail.claim_state).toMatchObject({ stale: true, disposition: "open" });
      expect((await publicBytes(f, `/p/${PROBLEM}/claims.md`)).bytes)
        .toContain(`## ${f.dependent.claim_id} (seq ${f.dependent.seq}) [stale]`);
      const html = (await publicBytes(f, `/p/${PROBLEM}/claims.html`)).bytes;
      expect(html).toContain(`<article class="claim-item" data-id="${f.dependent.claim_id}">`);
      expect(html).toContain('<span class="badge-stale">stale</span>');

      f.hide();
      const hidden = JSON.parse((await publicBytes(f, `/p/${PROBLEM}/claims.json`)).bytes) as {
        claims: { id: string; statement: string; stale: boolean }[];
      };
      expect(hidden.claims.some((claim) => claim.id === f.original.claim_id)).toBe(false);
      expect(hidden.claims.find((claim) => claim.id === f.dependent.claim_id)).toMatchObject({
        statement: DEPENDENT,
        stale: true,
      });
    }));

  test("exact claim versions retain their own notices and clean dependent statements stay clean", () =>
    withFixture(async (f) => {
      for (const [target, statement, notice] of [
        [`${f.original.claim_id}@1`, ORIGINAL, ORIGINAL_NOTICE],
        [`${f.original.claim_id}@2`, REVISED, REVISED_NOTICE],
        [f.original.claim_id, REVISED, REVISED_NOTICE],
        [`${f.dependent.claim_id}@1`, DEPENDENT, undefined],
      ] as const) {
        const response = await f.request(`/p/${PROBLEM}/claims/${target}.json`);
        const bytes = await response.text();
        expect(response.status, bytes).toBe(200);
        const face = ClaimFaceResponseSchema.parse(JSON.parse(bytes));
        const detail = face.items.find((item) => item.kind === "claim-detail");
        expect(detail).toBeDefined();
        if (detail === undefined) throw new Error("The visible claim detail is missing.");
        expect(JSON.parse(detail.body).statement).toBe(statement);
        expect(detail.screening_notice).toEqual(notice);
        for (const format of ["md", "html", "bib", "csl.json"]) {
          const rendered = await publicBytes(f, `/p/${PROBLEM}/claims/${target}.${format}`);
          expect(rendered.bytes).toContain(statement);
          if (notice !== undefined) {
            expect(rendered.bytes).toContain(`screening context notice: ${notice.category}`);
            expect(rendered.bytes).toContain("does not determine the scientific standing");
          } else if (format === "bib" || format === "csl.json") {
            expect(rendered.bytes).not.toContain("screening context notice");
          }
        }
      }

      const dependent = await publicBytes(f, `/p/${PROBLEM}/claims/${f.dependent.claim_id}@1.json`);
      const dependency = ClaimFaceResponseSchema.parse(JSON.parse(dependent.bytes)).items.find(
        (item) => item.kind === "claim-dependency" && item.id === `${f.original.claim_id}@1`,
      );
      expect(dependency).toBeDefined();
      if (dependency === undefined) throw new Error("The visible pinned premise is missing.");
      expect(JSON.parse(dependency.body).statement).toBe(ORIGINAL);
      expect(dependency.screening_notice).toEqual(ORIGINAL_NOTICE);
      expect(dependent.bytes).not.toContain(REVISED);
    }));

  test("current boards and context packs retain notices outside untrusted text and preserve dependency version pins", () =>
    withFixture(async (f) => {
      const board = await publicBytes(f, `/p/${PROBLEM}/claims.json`);
      const claims = JSON.parse(board.bytes).claims as {
        id: string;
        statement: string;
        screening_notice?: ScreeningPublicationNotice;
      }[];
      expect(claims.find((claim) => claim.id === f.original.claim_id)).toMatchObject({
        statement: REVISED,
        screening_notice: REVISED_NOTICE,
      });
      expect(
        claims.find((claim) => claim.id === f.dependent.claim_id)?.screening_notice,
      ).toBeUndefined();
      const digest = ProblemFaceResponseSchema.parse(
        JSON.parse((await publicBytes(f, `/p/${PROBLEM}.json`)).bytes),
      );
      const digestClaim = digest.items.find(
        (item) => item.kind === "claim" && item.id === f.original.claim_id,
      );
      expect(digestClaim?.body).toContain(REVISED);
      expect(digestClaim?.screening_notice).toEqual(REVISED_NOTICE);
      for (const item of digest.items.filter((item) => item.kind.startsWith("problem-")))
        expect(item.screening_notice).toBeUndefined();
      for (const path of [
        `/p/${PROBLEM}.md`,
        `/p/${PROBLEM}/claims.md`,
        `/p/${PROBLEM}/claims.html`,
      ]) {
        const rendered = await publicBytes(f, path);
        expect(rendered.bytes).toContain(REVISED);
        expect(rendered.bytes).toContain("screening context notice: injection");
      }

      const working = await f.pack("working");
      const current = ledgerItem(working, "claim", f.original.claim_id);
      expect(current.body).toContain(REVISED);
      expect(current.screening_notice).toEqual(REVISED_NOTICE);
      expect(ledgerItem(working, "claim", f.dependent.claim_id).screening_notice).toBeUndefined();
      for (const profile of ["claim", "review"]) {
        const pack = await f.pack(profile, `${f.dependent.claim_id}@1`);
        const root = ledgerItem(pack, "claim-detail", `${f.dependent.claim_id}@1`);
        expect(JSON.parse(root.body).statement).toBe(DEPENDENT);
        expect(root.screening_notice).toBeUndefined();
        const premise = ledgerItem(pack, "claim-dependency", `${f.original.claim_id}@1`);
        expect(JSON.parse(premise.body)).toMatchObject({
          statement: ORIGINAL,
          seq: f.original.seq,
          version: 1,
        });
        expect(premise.screening_notice).toEqual(ORIGINAL_NOTICE);
        expect(JSON.stringify(pack)).not.toContain(REVISED);
        const historical = ledgerItem(
          await f.pack(profile, `${f.original.claim_id}@1`),
          "claim-detail",
          `${f.original.claim_id}@1`,
        );
        expect(historical.screening_notice).toEqual(ORIGINAL_NOTICE);
      }

      const full = await f.pack("full");
      for (const [seq, statement, notice] of [
        [f.original.seq, ORIGINAL, ORIGINAL_NOTICE],
        [f.dependent.seq, DEPENDENT, undefined],
        [f.revised.seq, REVISED, REVISED_NOTICE],
      ] as const) {
        const item = ledgerItem(full, "full-event", `FULL-${seq}`);
        expect(item.body).toContain(statement);
        expect(item.screening_notice).toEqual(notice);
        expect(JSON.parse(item.body).publication.screening_notice).toEqual(notice);
      }
    }));

  test("exact and lexical search, event tails and feeds expose the source warning without private screening receipts", () =>
    withFixture(async (f) => {
      for (const [query, statement, notice] of [
        [`${PROBLEM}#${f.original.claim_id}@1`, ORIGINAL, ORIGINAL_NOTICE],
        [`${PROBLEM}#${f.original.claim_id}@2`, REVISED, REVISED_NOTICE],
        [`${PROBLEM}#${f.dependent.claim_id}@1`, DEPENDENT, undefined],
        ["WarningReadRevised", REVISED, REVISED_NOTICE],
      ] as const) {
        const params = new URLSearchParams({ q: query, kind: "claim" });
        const json = await publicBytes(f, `/search.json?${params}`);
        const search = SearchResponseSchema.parse(JSON.parse(json.bytes));
        expect(search.items).toHaveLength(1);
        expect(search.items[0]?.statement ?? search.items[0]?.snippet).toContain(statement);
        expect(search.items[0]?.screening_notice).toEqual(notice);
        if (notice !== undefined) {
          const markdown = await publicBytes(f, `/search.md?${params}`);
          expect(markdown.bytes).toContain(`screening context notice: ${notice.category}`);
        }
        expect(json.bytes).not.toContain("evaluated_context_digest");
        expect(json.bytes).not.toContain("decision_path");
      }
      const events = EventTailResponseSchema.parse(
        JSON.parse((await publicBytes(f, `/p/${PROBLEM}/events.json?since=0`)).bytes),
      );
      const toon = parseEventTailToon(
        (await publicBytes(f, `/p/${PROBLEM}/events.toon?since=0`)).bytes,
      );
      const ndjson = (await publicBytes(f, `/p/${PROBLEM}/events.ndjson?since=0`)).bytes
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ndjson.slice(0, -1)).toEqual(events.events);
      expect(ndjson.at(-1).control).toBe("page_end");
      for (const [seq, notice] of [
        [f.original.seq, ORIGINAL_NOTICE],
        [f.dependent.seq, undefined],
        [f.revised.seq, REVISED_NOTICE],
      ] as const) {
        expect(events.events.find((entry) => entry.seq === seq)?.event?.screening_notice).toEqual(
          notice,
        );
        expect(toon.events.find((entry) => entry.seq === seq)?.screening_notice).toEqual(notice);
      }
      for (const path of [
        `/p/${PROBLEM}/events.md?since=0`,
        `/p/${PROBLEM}/feed.atom`,
        `/p/${PROBLEM}/feed.rss`,
        `/p/${PROBLEM}/feed.json`,
      ]) {
        const rendered = await publicBytes(f, path);
        expect(rendered.bytes).toContain("screening context notice: dual-use-boundary");
        expect(rendered.bytes).toContain("screening context notice: injection");
        expect(rendered.bytes).not.toContain("evaluated_context_digest");
        expect(rendered.bytes).not.toContain("decision_path");
      }
      const feed = JSON.parse((await publicBytes(f, `/p/${PROBLEM}/feed.json`)).bytes) as {
        items: { id: string; _screening_notice?: ScreeningPublicationNotice }[];
      };
      for (const [seq, notice] of [
        [f.original.seq, ORIGINAL_NOTICE],
        [f.revised.seq, REVISED_NOTICE],
      ] as const) {
        const eventId = events.events.find((entry) => entry.seq === seq)?.event?.id;
        expect(eventId).toBeDefined();
        expect(
          feed.items.find((entry) => entry.id.endsWith(`:event:${eventId}`))?._screening_notice,
        ).toEqual(notice);
      }
    }));

  test("a late content hide removes source text and notices before old ETags can return 304", () =>
    withFixture(async (f) => {
      const paths = [
        `/p/${PROBLEM}/claims/${f.original.claim_id}@1.json`,
        `/p/${PROBLEM}/claims/${f.original.claim_id}@2.md`,
        `/p/${PROBLEM}/claims/${f.original.claim_id}.html`,
        `/p/${PROBLEM}/claims/${f.original.claim_id}@1.bib`,
        `/p/${PROBLEM}/claims/${f.original.claim_id}.csl.json`,
        `/p/${PROBLEM}/claims/${f.dependent.claim_id}@1.json`,
        `/p/${PROBLEM}/claims.json`,
        `/p/${PROBLEM}.json`,
        `/search.json?${new URLSearchParams({ q: `${PROBLEM}#${f.original.claim_id}@1`, kind: "claim" })}`,
        `/search.json?q=WarningReadRevised&kind=claim`,
        `/p/${PROBLEM}/events.json?since=0`,
        `/p/${PROBLEM}/events.ndjson?since=0`,
        `/p/${PROBLEM}/events.toon?since=0`,
        `/p/${PROBLEM}/events.md?since=0`,
        `/p/${PROBLEM}/feed.json`,
        `/p/${PROBLEM}/feed.atom`,
        `/p/${PROBLEM}/feed.rss`,
      ];
      const saved: { path: string; etag: string }[] = [];
      for (const path of paths) {
        const { response, bytes } = await publicBytes(f, path);
        expect(bytes, path).toMatch(
          /dual-use-boundary|screening-warning|screening context notice: injection/,
        );
        saved.push({ path, etag: requiredEtag(response) });
      }
      f.hide();
      for (const { path, etag } of saved) {
        const response = await f.request(path, { headers: { "if-none-match": etag } });
        const bytes = await response.text();
        expect(response.status, path).not.toBe(304);
        expect(response.status, `${path}: ${bytes}`).toBeLessThan(500);
        expect(bytes, path).not.toContain(ORIGINAL);
        expect(bytes, path).not.toContain(REVISED);
        expect(bytes, path).not.toContain("screening-warning");
        expect(bytes, path).not.toContain("screening context notice");
        const head = await f.request(path, { method: "HEAD", headers: { "if-none-match": etag } });
        expect(head.status, path).not.toBe(304);
        expect(await head.text(), path).toBe("");
      }
      for (const [profile, target] of [
        ["working", undefined],
        ["claim", `${f.dependent.claim_id}@1`],
        ["review", `${f.dependent.claim_id}@1`],
        ["full", undefined],
      ] as const) {
        const bytes = JSON.stringify(await f.pack(profile, target));
        expect(bytes).not.toContain(ORIGINAL);
        expect(bytes).not.toContain(REVISED);
        expect(bytes).not.toContain("screening-warning");
      }
    }));

  test("exact discovery applies version, event and problem controls and never advertises unlisted or private sources", () =>
    withFixture(async (f) => {
      const path = `/search.json?${new URLSearchParams({ q: `${PROBLEM}#${f.original.claim_id}@1`, kind: "claim" })}`;
      const before = await publicBytes(f, path);
      const etag = requiredEtag(before.response);
      const expectUnavailable = async () => {
        const response = await f.request(path, { headers: { "if-none-match": etag } });
        expect(response.status).toBe(200);
        const bytes = await response.text();
        expect(SearchResponseSchema.parse(JSON.parse(bytes)).items).toEqual([]);
        expect(bytes).not.toContain(ORIGINAL);
        expect(bytes).not.toContain("screening-warning");
      };
      for (const target of [`${f.original.claim_id}@1`, `#${f.original.seq}`, "problem"]) {
        f.visibility(target, false);
        await expectUnavailable();
        expect(await findScientificClaim(f.db, PROBLEM, f.original.claim_id, 1)).toBeNull();
        if (target !== "problem") {
          // A specific historical publication control does not hide its cleanly
          // available successor under a different event/version pin.
          expect(await findScientificClaim(f.db, PROBLEM, f.original.claim_id, 2)).not.toBeNull();
        }
        f.visibility(target, true);
        expect((await f.request(path, { headers: { "if-none-match": etag } })).status).toBe(304);
      }
      f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(PROBLEM);
      await expectUnavailable();
      // Unlisting stops discovery, while an existing public scientific link
      // can still resolve its immutable, warning-bearing source.
      expect(await findScientificClaim(f.db, PROBLEM, f.original.claim_id, 1)).not.toBeNull();
      expect((await f.request(`/p/${PROBLEM}/claims/${f.original.claim_id}@1.json`)).status).toBe(
        200,
      );
      f.sql.query("UPDATE problems SET unlisted=0,status='private-draft' WHERE id=?").run(PROBLEM);
      await expectUnavailable();
      expect(await findScientificClaim(f.db, PROBLEM, f.original.claim_id, 1)).toBeNull();
      f.sql.query("UPDATE problems SET status='active' WHERE id=?").run(PROBLEM);
      f.sql
        .query(`UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='Synthetic late redaction'
        WHERE event_id=(SELECT id FROM events WHERE problem_id=? AND seq=?)`)
        .run(new Date().toISOString(), PROBLEM, f.original.seq);
      await expectUnavailable();
      expect(await findScientificClaim(f.db, PROBLEM, f.original.claim_id, 1)).toBeNull();
    }));

  test("a hide committed between exact-source hydration and receipt lookup refuses the previous search ETag", () =>
    withFixture(async (f) => {
      const path = `/search.json?${new URLSearchParams({ q: `${PROBLEM}#${f.original.claim_id}@1`, kind: "claim" })}`;
      const before = await publicBytes(f, path);
      const etag = requiredEtag(before.response);
      const prepare = f.db.prepare.bind(f.db);
      let raced = false;
      // Interleave one real SQLite control write with real source reads. No
      // query returns canned rows and no mounted handler is substituted.
      f.db.prepare = (query) => {
        const statement = prepare(query);
        if (query === "SELECT provenance_json FROM screening_publications WHERE event_id = ?") {
          const bind = statement.bind.bind(statement);
          statement.bind = (...values) => {
            const bound = bind(...values);
            const first = bound.first.bind(bound);
            bound.first = (async (...args: Parameters<typeof bound.first>) => {
              const result = await first(...args);
              if (!raced) {
                raced = true;
                f.hide();
              }
              return result;
            }) as typeof bound.first;
            return bound;
          };
        }
        return statement;
      };
      try {
        const response = await f.request(path, { headers: { "if-none-match": etag } });
        expect(raced).toBe(true);
        expect(response.status).toBe(409);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("etag")).toBeNull();
        const bytes = await response.text();
        expect(bytes).toContain("SEARCH_RESULTS_CHANGED");
        expect(bytes).not.toContain(ORIGINAL);
        expect(bytes).not.toContain("screening-warning");
      } finally {
        f.db.prepare = prepare;
      }
    }));
});
