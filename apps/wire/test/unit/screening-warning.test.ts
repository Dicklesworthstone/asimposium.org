import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaimKindSchema,
  ProblemDetailSchema,
  ScreeningPublicationNoticeSchema,
  ScreeningPublicationProvenanceSchema,
  SynthesizeRequestSchema,
} from "@asimposium/contracts";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import {
  PUBLIC_EXPORT_FORMAT,
  parsePublicProblemExport,
  verifyPublicProblemExportChain,
} from "../../src/krater/export";
import { writeLedgerEvent } from "../../src/krater/krater";
import { eventTailExportResponse } from "../../src/ledger/event-tail-feeds";
import { isScreeningPostureChangedError, recordRefusal } from "../../src/moderation/posture";
import { listModerationLog } from "../../src/moderation/store";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview";
import type { ScreenedPublication } from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import { readPublicationNotices } from "../../src/screening/publication-notice";
import type {
  PublicationScreeningObservation,
  WorkersAIPromotionInput,
} from "../../src/screening/workers-ai";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

// Native SQLite unit proof with shipped migrations and the production writer.
// The classifier is synthetic; this does not establish live-provider accuracy.
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const fixture = await publicationContextFixture();
  try {
    await fn(fixture);
  } finally {
    fixture.sql.close();
  }
}
function candidate(f: Fixture, kind = "conjecture"): WorkersAIPromotionInput {
  return { ...f.input("A bounded theoretical statement with an explicit falsifier."), kind };
}
async function screen(
  f: Fixture,
  input = candidate(f),
  patch: Partial<PublicationScreeningObservation> = {},
  route = "promote",
) {
  return screenPublicCandidate(
    async (value) => ({
      ...(await syntheticScreeningObservation(value, {
        decision: "allow-with-warning",
        coarse_category: "dual-use-boundary",
        provider_status: "ok",
      })),
      ...patch,
    }),
    { DB: f.db } as Env,
    input,
    { sponsorId: SPONSOR, route },
  );
}
function published(result: Response | ScreenedPublication): ScreenedPublication {
  if (result instanceof Response)
    throw new Error(`Expected a publication, received ${result.status}`);
  return result;
}
function count(
  f: Fixture,
  table: "screening_cases" | "screening_refusals" | "moderation_log",
): number {
  return (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function claimCommand(
  f: Fixture,
  input: WorkersAIPromotionInput,
  receipt: ScreenedPublication,
  eventId?: string,
) {
  const member = f.command(input, receipt, eventId);
  return {
    ...member,
    input: { ...member.input, eventType: "claim.created", objectKind: "claim", objectId: "C-1" },
  };
}

describe("published screening warnings", () => {
  test("off-scope science publishes with its exact relevance notice without policy refusals or review holds", () =>
    withFixture(async (f) => {
      for (const kind of [
        ...ClaimKindSchema.options,
        "revise",
        "problem-proposal",
        "problem-statement-revision",
      ]) {
        const receipt = published(
          await screen(f, candidate(f, kind), { coarse_category: "off-topic" }),
        );
        expect(receipt.provenance.public_action).toEqual({
          category: "off-topic",
          action: "published-with-warning",
          notice: "off-scope",
        });
        expect(ScreeningPublicationProvenanceSchema.safeParse(receipt.provenance).success).toBe(
          true,
        );
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      const input = candidate(f);
      const receipt = published(await screen(f, input, { coarse_category: "off-topic" }));
      const member = claimCommand(f, input, receipt);
      const committed = await writeLedgerEvent(f.db, member.input, member.projection);
      const stored = (await readPublicationNotices(f.db, PROBLEM, [committed.seq])).get(
        committed.seq,
      );
      expect(stored).toEqual(
        ScreeningPublicationNoticeSchema.parse(receipt.provenance.public_action),
      );
      expect((await listModerationLog(f.db, 0, 100))[0]).toMatchObject({
        action: "published-with-warning",
        category: "off-topic",
        subject: "ledger-object",
      });
      const before = f.state();
      const retry = claimCommand(f, input, receipt, "E-OFFSCOPE-RETRY");
      const replay = await writeLedgerEvent(
        f.db,
        {
          ...retry.input,
          idempotencyKey: member.input.idempotencyKey,
        },
        retry.projection,
      );
      expect(replay.idempotent).toBe(true);
      expect(f.state()).toEqual(before);
      expect(count(f, "moderation_log")).toBe(1);
    }));

  test("incoherent off-topic verdicts fail as provider faults and cannot manufacture a policy strike", () =>
    withFixture(async (f) => {
      for (const decision of ["pass", "quarantine", "reject"] as const) {
        const response = await screen(f, candidate(f), { coarse_category: "off-topic", decision });
        if (!(response instanceof Response))
          throw new Error("Expected a private provider-fault hold");
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
          code: "SCREENING_HOLD",
          coarse_category: "provider-unavailable",
        });
      }
      expect(count(f, "screening_refusals")).toBe(0);
      expect(f.state().events).toEqual([]);
    }));

  test("supported claim and formulation kinds return exact-byte warning evidence without opening review cases", () =>
    withFixture(async (f) => {
      for (const kind of [
        ...ClaimKindSchema.options,
        "revise",
        "problem-proposal",
        "problem-statement-revision",
      ]) {
        const receipt = published(await screen(f, candidate(f, kind)));
        expect(ScreeningPublicationProvenanceSchema.safeParse(receipt.provenance).success).toBe(
          true,
        );
        expect(receipt.provenance.scope).toBe("candidate-and-public-context");
        expect(receipt.provenance.public_action).toEqual({
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        });
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      expect(count(f, "moderation_log")).toBe(0);
    }));

  test("claim and statement review warnings require their server-selected writers and exact candidate and context binding", () =>
    withFixture(async (f) => {
      for (const route of ["review", "statement-review"]) {
        for (const category of ["dual-use-boundary", "off-topic"] as const) {
          const receipt = published(
            await screen(f, candidate(f, "review"), { coarse_category: category }, route),
          );
          expect(receipt.provenance.public_action).toEqual(
            category === "off-topic"
              ? { category, action: "published-with-warning", notice: "off-scope" }
              : { category, action: "published-with-warning", notice: "screening-warning" },
          );
        }
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      for (const route of ["promote", "evidence", "unrecognized-review-writer"]) {
        const held = await screen(f, candidate(f, "review"), {}, route);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const route of ["review", "statement-review"]) {
        for (const patch of [
          { evaluated_body_digest: `sha256:${"f".repeat(64)}` },
          { evaluated_context_digest: `sha256:${"f".repeat(64)}` },
          { provider_status: "timeout" },
          { coarse_category: "provider-unavailable" },
        ] as const) {
          const held = await screen(f, candidate(f, "review"), patch, route);
          expect(held instanceof Response && held.status).toBe(202);
        }
      }
      expect(f.state().events).toEqual([]);
    }));

  test("citation warnings publish only through record and correction writers with exact binding", () =>
    withFixture(async (f) => {
      for (const route of ["citations", "citations/correct"]) {
        for (const notice of [
          {
            category: "dual-use-boundary",
            action: "published-with-warning",
            notice: "screening-warning",
          },
          { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
        ] as const) {
          const receipt = published(
            await screen(f, candidate(f, "citation"), { coarse_category: notice.category }, route),
          );
          expect(receipt.provenance.public_action).toEqual(notice);
        }
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      for (const route of ["promote", "review", "evidence", "statement-review"]) {
        const held = await screen(f, candidate(f, "citation"), {}, route);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const patch of [
        { evaluated_body_digest: `sha256:${"f".repeat(64)}` },
        { evaluated_context_digest: `sha256:${"f".repeat(64)}` },
        { provider_status: "timeout" },
        { coarse_category: "provider-unavailable" },
      ] as const) {
        const held = await screen(f, candidate(f, "citation"), patch, "citations/correct");
        expect(held instanceof Response && held.status).toBe(202);
      }
      expect(f.state().events).toEqual([]);
    }));

  test("evidence warnings publish only through the evidence writer with exact candidate and context binding", () =>
    withFixture(async (f) => {
      for (const notice of [
        {
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        },
        { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
      ] as const) {
        const receipt = published(
          await screen(
            f,
            candidate(f, "evidence"),
            { coarse_category: notice.category },
            "evidence",
          ),
        );
        expect(receipt.provenance.public_action).toEqual(notice);
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      for (const route of ["promote", "review", "statement-review"]) {
        const held = await screen(f, candidate(f, "evidence"), {}, route);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const patch of [
        { evaluated_body_digest: `sha256:${"f".repeat(64)}` },
        { evaluated_context_digest: `sha256:${"f".repeat(64)}` },
        { provider_status: "timeout" },
        { coarse_category: "provider-unavailable" },
      ] as const) {
        const held = await screen(f, candidate(f, "evidence"), patch, "evidence");
        expect(held instanceof Response && held.status).toBe(202);
      }
      expect(f.state().events).toEqual([]);
    }));

  test("hypothesis creation warnings are route-bound, while lifecycle and kill warnings remain held", () =>
    withFixture(async (f) => {
      for (const notice of [
        {
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        },
        { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
      ] as const) {
        const receipt = published(
          await screen(
            f,
            candidate(f, "hypotheses"),
            { coarse_category: notice.category },
            "hypotheses",
          ),
        );
        expect(receipt.provenance.public_action).toEqual(notice);
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      for (const route of ["promote", "evidence", "review", "sponsor-workshop"]) {
        const held = await screen(f, candidate(f, "hypotheses"), {}, route);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const kind of ["hypothesis-lifecycle", "hypothesis-kill"]) {
        const held = await screen(f, candidate(f, kind), {}, kind);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const patch of [
        { evaluated_body_digest: `sha256:${"f".repeat(64)}` },
        { evaluated_context_digest: `sha256:${"f".repeat(64)}` },
        { provider_status: "timeout" },
        { coarse_category: "provider-unavailable" },
      ] as const) {
        const held = await screen(f, candidate(f, "hypotheses"), patch, "hypotheses");
        expect(held instanceof Response && held.status).toBe(202);
      }
      expect(f.state().events).toEqual([]);
    }));

  test("ordinary synthesis warnings publish only through the exact writer; closing declarations stay held", () =>
    withFixture(async (f) => {
      const ordinary = SynthesizeRequestSchema.parse({
        covers_through: 2,
        body_md: "The finite parity result remains limited to the recorded cases.",
        anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1, target_seq: 2 }],
        omitted: [],
        selection_policy: "Include the exact bounded result and disclose its limits.",
      });
      const closing = SynthesizeRequestSchema.parse({
        ...ordinary,
        closing_resolution: {
          result_claim: { claim_id: "C-1", version: 1 },
          direction: "affirmed",
          no_claim_boundary: {
            verified: ["Exact finite case."],
            mechanisms: ["Independent check."],
            independence_tiers: ["T2"],
            remaining_external_validation: ["External review remains."],
          },
        },
      });
      const input = (publication: unknown): WorkersAIPromotionInput => ({
        ...candidate(f, "synthesis"),
        statement: JSON.stringify(publication),
      });
      for (const notice of [
        {
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        },
        { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
      ] as const) {
        const receipt = published(
          await screen(f, input(ordinary), { coarse_category: notice.category }, "synthesize"),
        );
        expect(receipt.provenance.public_action).toEqual(notice);
        expect(ScreeningPublicationProvenanceSchema.safeParse(receipt.provenance).success).toBe(
          true,
        );
      }
      expect(count(f, "screening_cases")).toBe(0);
      expect(count(f, "screening_refusals")).toBe(0);
      for (const publication of [ordinary, closing]) {
        const receipt = published(
          await screen(
            f,
            input(publication),
            {
              decision: "pass",
              coarse_category: "benign-context",
            },
            "synthesize",
          ),
        );
        expect(receipt.provenance.public_action).toEqual({
          category: "benign-context",
          action: "published",
          notice: "none",
        });
      }
      // A closing declaration also feeds problem-resolution and honors derivatives.
      // Those surfaces do not yet carry its notice, so only ordinary warnings open.
      for (const category of ["dual-use-boundary", "off-topic"] as const) {
        const held = await screen(f, input(closing), { coarse_category: category }, "synthesize");
        expect(held instanceof Response && held.status).toBe(202);
        if (!(held instanceof Response))
          throw new Error("Expected a private closing-synthesis hold");
        expect(held.headers.get("cache-control")).toContain("no-store");
        expect(await held.json()).toMatchObject({ code: "SCREENING_HOLD" });
      }
      for (const route of ["promote", "review", "unrecognized-synthesis-writer"]) {
        const held = await screen(f, input(ordinary), {}, route);
        expect(held instanceof Response && held.status).toBe(202);
      }
      for (const publication of [
        null,
        [],
        {},
        { ...ordinary, closing_resolution: null },
        { ...ordinary, screening_notice: { notice: "screening-warning" } },
      ]) {
        const held = await screen(f, input(publication), {}, "synthesize");
        expect(held instanceof Response && held.status).toBe(202);
      }
      const malformed = await screen(
        f,
        { ...input(ordinary), statement: "{not-json" },
        {},
        "synthesize",
      );
      expect(malformed instanceof Response && malformed.status).toBe(202);
      for (const patch of [
        { evaluated_body_digest: `sha256:${"f".repeat(64)}` },
        { evaluated_context_digest: `sha256:${"f".repeat(64)}` },
        { provider_status: "timeout" },
        { coarse_category: "provider-unavailable" },
      ] as const) {
        const held = await screen(f, input(ordinary), patch, "synthesize");
        expect(held instanceof Response && held.status).toBe(202);
      }
      expect(count(f, "screening_refusals")).toBe(0);
      expect(f.state().events).toEqual([]);
    }));

  test("unsupported kinds still hold, and a warning cannot relax provider failure, incoherence or digest binding", () =>
    withFixture(async (f) => {
      for (const [kind, patch] of [
        ["hypotheses", {}],
        ["review", {}],
        ["unimplemented-kind", {}],
        ["conjecture", { provider_status: "timeout" }],
        ["conjecture", { coarse_category: "benign-context" }],
        ["conjecture", { coarse_category: "provider-unavailable" }],
        ["conjecture", { evaluated_body_digest: `sha256:${"f".repeat(64)}` }],
        ["conjecture", { evaluated_context_digest: `sha256:${"f".repeat(64)}` }],
        ["conjecture", { decision_path: "provider-error-fail-closed" }],
      ] as const) {
        const result = await screen(f, candidate(f, kind), patch);
        expect(result instanceof Response).toBe(true);
        if (!(result instanceof Response)) throw new Error("Expected a private hold");
        expect(result.status).toBe(202);
        expect((await result.json()) as { code: string }).toMatchObject({ code: "SCREENING_HOLD" });
      }
      expect(f.state().events).toEqual([]);
      expect(count(f, "screening_refusals")).toBe(0);
    }));

  test("the warning, public-safe log and receipt commit once and replay together", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const member = claimCommand(f, input, receipt);
      const committed = await writeLedgerEvent(f.db, member.input, member.projection);
      const before = f.state();
      const log = await listModerationLog(f.db, 0, 100);
      expect(log).toEqual([
        {
          seq: 1,
          action: "published-with-warning",
          category: "dual-use-boundary",
          subject: "ledger-object",
          problem_id: PROBLEM,
          created_at: member.input.createdAt,
        },
      ]);
      const serialized = JSON.stringify(log);
      for (const privateValue of [
        input.statement,
        input.falsifier,
        FELLOW,
        SPONSOR,
        receipt.provenance.input_digest,
        receipt.provenance.model_version,
        committed.eventId,
      ]) {
        if (privateValue !== null) expect(serialized).not.toContain(privateValue);
      }
      const retry = claimCommand(f, input, receipt, "E-WARNING-RETRY");
      const replay = await writeLedgerEvent(
        f.db,
        {
          ...retry.input,
          idempotencyKey: member.input.idempotencyKey,
        },
        retry.projection,
      );
      expect(replay.idempotent).toBe(true);
      expect(replay.eventId).toBe(committed.eventId);
      expect(f.state()).toEqual(before);
      expect(await listModerationLog(f.db, 0, 100)).toEqual(log);
    }));

  test("log failure rolls back the event, provenance and replay receipt", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const member = claimCommand(f, input, receipt),
        before = f.state();
      f.sql.exec(`CREATE TRIGGER warning_log_failure BEFORE INSERT ON moderation_log
        WHEN NEW.action = 'published-with-warning' BEGIN SELECT RAISE(ABORT, 'WARNING_LOG_UNAVAILABLE'); END;`);
      await expect(writeLedgerEvent(f.db, member.input, member.projection)).rejects.toThrow(
        "WARNING_LOG_UNAVAILABLE",
      );
      expect(f.state()).toEqual(before);
      expect(count(f, "moderation_log")).toBe(0);
    }));

  test("the public v4 download retains exact warnings and honors late hides before conditional GET and HEAD", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const member = claimCommand(f, input, receipt);
      const committed = await writeLedgerEvent(f.db, member.input, member.projection);
      const download = (method = "GET", validator?: string) =>
        eventTailExportResponse(
          new Request(`https://a.asimposium.org/p/${PROBLEM}/export.jsonl.gz`, {
            method,
            ...(validator === undefined ? {} : { headers: { "if-none-match": validator } }),
          }),
          PROBLEM,
          "Context problem",
          f.db,
          false,
        );
      const response = await download();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-asimposium-export-format")).toBe(PUBLIC_EXPORT_FORMAT);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const etag = response.headers.get("etag")!;
      const ndjson = await new Response(
        response.body!.pipeThrough(new DecompressionStream("gzip")),
      ).text();
      expect((await verifyPublicProblemExportChain(ndjson)).intact).toBe(true);
      const parsed = parsePublicProblemExport(ndjson);
      if (!parsed.ok) throw new Error(parsed.detail);
      expect(parsed.publicationContext.notices).toEqual([
        {
          event_id: committed.eventId,
          seq: committed.seq,
          payload_sha256: parsed.events[0]!.payloadSha256,
          screening_notice: ScreeningPublicationNoticeSchema.parse(
            receipt.provenance.public_action,
          ),
        },
      ]);
      expect(parsed.events[0]!.payloadJson).toBe(member.input.payloadJson);
      expect(ndjson).not.toContain("evaluated_context_digest");
      for (const method of ["GET", "HEAD"]) {
        const unchanged = await download(method, "*");
        expect(unchanged.status).toBe(304);
        expect(await unchanged.text()).toBe("");
      }
      f.visible("C-1@1", "hidden");
      for (const method of ["GET", "HEAD"]) {
        const hidden = await download(method, etag);
        expect(hidden.status).toBe(409);
        expect(hidden.headers.get("etag")).toBeNull();
        if (method === "HEAD") expect(await hidden.text()).toBe("");
        else {
          const body = (await hidden.json()) as {
            code: string;
            detail: string;
            fix_hint: string;
          };
          expect(body.code).toBe("PUBLIC_EXPORT_CONTENT_WITHHELD");
          expect(body.detail).toContain("withheld");
          expect(body.fix_hint).toContain("events.ndjson");
          expect(JSON.stringify(body)).not.toContain(input.statement);
        }
      }
      f.visible("C-1@1", "visible", 2);
      expect((await download("HEAD")).status).toBe(200);
    }));

  test("a hide committed during archive assembly defeats a wildcard conditional response", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const member = claimCommand(f, input, receipt);
      await writeLedgerEvent(f.db, member.input, member.projection);
      const prepare = f.db.prepare.bind(f.db);
      let hidden = false;
      f.db.prepare = (query) => {
        if (!hidden && query.includes("AS publication_receipt_count")) {
          hidden = true;
          f.visible("C-1", "hidden");
        }
        return prepare(query);
      };
      try {
        const response = await eventTailExportResponse(
          new Request(`https://a.asimposium.org/p/${PROBLEM}/export.jsonl.gz`, {
            headers: { "if-none-match": "*" },
          }),
          PROBLEM,
          "Context problem",
          f.db,
          false,
        );
        expect(hidden).toBe(true);
        expect(response.status).toBe(409);
        expect(response.headers.get("etag")).toBeNull();
        expect(await response.text()).not.toContain(input.statement);
      } finally {
        f.db.prepare = prepare;
      }
    }));

  test("a newly engaged posture fences a warning in the actual publication transaction", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      for (let i = 1; i <= 3; i++)
        await recordRefusal(f.db, {
          fellowId: FELLOW,
          sponsorId: SPONSOR,
          problemId: PROBLEM,
          outcome: "reject",
          coarseCategory: "injection",
          inputDigest: i.toString(16).padStart(64, "0"),
        });
      const before = f.state(),
        member = claimCommand(f, input, receipt);
      try {
        await writeLedgerEvent(f.db, member.input, member.projection);
        throw new Error("A warning bypassed the quarantine-first posture");
      } catch (error) {
        expect(isScreeningPostureChangedError(error)).toBe(true);
      }
      expect(f.state()).toEqual(before);
      expect(count(f, "moderation_log")).toBe(0);
      const held = await screen(f, input);
      expect(held instanceof Response).toBe(true);
      if (!(held instanceof Response)) throw new Error("Expected posture hold");
      expect(await held.json()).toMatchObject({
        code: "SCREENING_HOLD",
        posture: "quarantine-first",
      });
    }));

  test("the database refuses warning receipts with a missing public notice", () =>
    withFixture(async (f) => {
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const forged = {
        ...receipt,
        provenance: {
          ...receipt.provenance,
          public_action: { category: "benign-context", action: "published", notice: "none" },
        },
      } as ScreenedPublication;
      const member = claimCommand(f, input, forged),
        before = f.state();
      await expect(writeLedgerEvent(f.db, member.input, member.projection)).rejects.toThrow(
        "SCREENING_WARNING_INVALID",
      );
      expect(f.state()).toEqual(before);
    }));

  test("warning log publication does not advertise an unlisted problem", () =>
    withFixture(async (f) => {
      f.sql.query("UPDATE problems SET unlisted = 1 WHERE id = ?").run(PROBLEM);
      const input = candidate(f),
        receipt = published(await screen(f, input));
      const member = claimCommand(f, input, receipt);
      await writeLedgerEvent(f.db, member.input, member.projection);
      expect((await listModerationLog(f.db, 0, 100))[0]?.problem_id).toBeNull();
    }));

  test("warned problem publication exposes its exact source notice on the mounted recovery read", () =>
    withFixture(async (f) => {
      f.sql
        .query("UPDATE problems SET status='private-draft', created_by_fellow_id=? WHERE id=?")
        .run(FELLOW, PROBLEM);
      const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
      if (preview === undefined) throw new Error("Expected publication preview");
      const snapshot = f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Parameters<
        typeof applyPublicProblemGovernance
      >[1];
      const input = {
        ...f.input(
          "Context problem\n\nExact public problem statement.\n\nExact public motivation.",
        ),
        kind: "problem-proposal",
        falsifier: "Exact public falsifier.",
      };
      const response = await applyPublicProblemGovernance(
        f.db,
        snapshot,
        SPONSOR,
        {
          action: "publish",
          reviewed_statement_version: preview.problem.current_statement_version,
          reviewed_digest: preview.review_digest,
        },
        new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
          method: "POST",
          headers: { "idempotency-key": "warned-formulation" },
        }),
        { sponsorLimit: 100, screen: () => screen(f, input) },
      );
      expect(response.status).toBe(200);
      const read = await createApp().request(
        `https://a.asimposium.org/v1/problems/${PROBLEM}`,
        {},
        {
          DB: f.db,
          STOA_ORIGIN: "https://a.asimposium.org",
          AGORA_ORIGIN: "https://asimposium.org",
          ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as Env,
      );
      expect(read.status).toBe(200);
      const body = (await read.json()) as { problem: unknown };
      const detail = ProblemDetailSchema.parse(body.problem);
      expect(detail.statement).toBe("Exact public problem statement.");
      expect(detail.screening_notice).toEqual({
        category: "dual-use-boundary",
        action: "published-with-warning",
        notice: "screening-warning",
      });
      expect((await listModerationLog(f.db, 0, 100))[0]).toMatchObject({
        action: "published-with-warning",
        subject: "problem",
        problem_id: PROBLEM,
      });
    }));

  test("migration preserves every earlier log row and the exact suspension cascade trigger", () => {
    const sql = new Database(":memory:");
    const directory = new URL("../../../../db/migrations/", import.meta.url).pathname;
    try {
      for (const name of readdirSync(directory)
        .filter((name) => name.endsWith(".sql") && name < "0125_")
        .sort())
        sql.exec(readFileSync(join(directory, name), "utf8"));
      sql.exec(
        `INSERT INTO moderation_log VALUES('ML-PRESERVED',1,'released','injection','candidate',NULL,'2026-10-30T00:00:00.000Z')`,
      );
      const previous = sql.query("SELECT * FROM moderation_log").all();
      const trigger = sql
        .query("SELECT sql FROM sqlite_schema WHERE name = 'sponsor_suspension_apply'")
        .get();
      sql.exec(readFileSync(join(directory, "0125_published_screening_warnings.sql"), "utf8"));
      expect(sql.query("SELECT * FROM moderation_log").all()).toEqual(previous);
      expect(
        sql.query("SELECT sql FROM sqlite_schema WHERE name = 'sponsor_suspension_apply'").get(),
      ).toEqual(trigger);
      expect(() => sql.exec("UPDATE moderation_log SET category='changed'")).toThrow(
        "MODERATION_LOG_APPEND_ONLY",
      );
      expect(() => sql.exec("DELETE FROM moderation_log")).toThrow("MODERATION_LOG_APPEND_ONLY");
    } finally {
      sql.close();
    }
  });
});
