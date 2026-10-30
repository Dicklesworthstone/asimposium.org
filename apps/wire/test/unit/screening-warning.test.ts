import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaimKindSchema,
  ProblemDetailSchema,
  ScreeningPublicationNoticeSchema,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import { parsePublicProblemExport, verifyPublicProblemExportChain } from "../../src/krater/export";
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
    { sponsorId: SPONSOR, route: "promote" },
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

  test("unsupported kinds still hold, and a warning cannot relax provider failure, incoherence or digest binding", () =>
    withFixture(async (f) => {
      for (const [kind, patch] of [
        ["hypotheses", {}],
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
      expect(response.headers.get("x-asimposium-export-format")).toBe(
        "asimposium.problem-export.v4",
      );
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
