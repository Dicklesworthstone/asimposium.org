import { describe, expect, test } from "bun:test";
import {
  CorrectCitationResponseSchema,
  type ProblemDocument,
  ProblemDocumentSchema,
  type RecordCitationRequest,
  RecordCitationResponseSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { addApprovedFellow, fixture } from "./session-routes.test.ts";

type CitationWrite = "record" | "body-correction" | "path-correction";

const source: RecordCitationRequest = {
  locator_kind: "doi",
  locator: "10.1234/citation-admission-source",
  title: "Exact bounds for the finite parity problem",
  authors: ["Example Author"],
  year: 2026,
  excerpt: "The bounded enumeration checks both parity classes independently.",
  retrieved_at: "2026-11-01T00:00:00.000Z",
  source_provenance: "retrieved",
};

/** Real router and SQL unit fixture; this is not a deployed D1 proof. */
async function citationAdmissionFixture(mode: CitationWrite) {
  let mutation: (() => Promise<void>) | undefined;
  let afterMutation: Awaited<ReturnType<typeof footprint>> | undefined;
  let screenings = 0;
  const f = await fixture({
    screenPromotion: async () => {
      screenings++;
      const change = mutation;
      mutation = undefined;
      if (change) {
        await change();
        afterMutation = await footprint();
        return {
          decision: "allow-with-warning",
          coarse_category: "dual-use-boundary",
          provider_status: "ok",
        };
      }
      return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
    },
  });
  let key = 0;
  const post = (
    path: string,
    body: unknown,
    requestKey = `citation-admission-${++key}`,
    caller = f.call,
  ) =>
    caller(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestKey },
      body: JSON.stringify(body),
    });
  const open = async (caller = f.call) => {
    const response = await post("/v1/sessions", { problem_id: "P-4DSP" }, undefined, caller);
    expect(response.status, await response.clone().text()).toBe(201);
    return SessionOpenResponseSchema.parse(await response.json()).session_id;
  };
  const sessionId = await open();
  const recordPath = `/v1/sessions/${sessionId}/citations`;
  let citationId = "L-1";
  if (mode !== "record") {
    const recorded = await post(recordPath, source);
    expect(recorded.status, await recorded.clone().text()).toBe(201);
    citationId = RecordCitationResponseSchema.parse(await recorded.json()).citation_id;
  }
  const path =
    mode === "record"
      ? recordPath
      : mode === "body-correction"
        ? `${recordPath}/correct`
        : `${recordPath}/${citationId}/correct`;
  const body = (citation: RecordCitationRequest) =>
    mode === "record"
      ? citation
      : {
          ...citation,
          base_version: 1,
          ...(mode === "body-correction" ? { citation_id: citationId } : {}),
          correction_rationale: "Correct the bibliographic source while preserving its history.",
        };
  const footprint = async () => ({
    ledger: await f.db
      .prepare(`SELECT public_seq, chain_digest,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM event_content) AS content,
        (SELECT COUNT(*) FROM integrity_checkpoints) AS checkpoints,
        (SELECT COUNT(*) FROM outbox) AS outbox,
        (SELECT COUNT(*) FROM idempotency) AS idempotency,
        (SELECT COUNT(*) FROM screening_publications) AS screening_publications,
        (SELECT COUNT(*) FROM moderation_log) AS moderation_log,
        (SELECT COUNT(*) FROM session_write_replays) AS replays,
        (SELECT cursor FROM public_cursor WHERE singleton = 1) AS global_cursor
        FROM problems WHERE id = 'P-4DSP'`)
      .first(),
    citations: (await f.db.prepare("SELECT * FROM citations ORDER BY citation_id").all()).results,
    versions: (
      await f.db.prepare("SELECT * FROM citation_versions ORDER BY citation_id, version").all()
    ).results,
  });
  const expectRefused = async (
    response: Response,
    status: number,
    code: ProblemDocument["code"],
    requestKey: string,
  ) => {
    expect(mutation).toBeUndefined();
    expect(afterMutation).toBeDefined();
    if (afterMutation === undefined) throw new Error("The citation admission race did not run");
    expect(response.status, await response.clone().text()).toBe(status);
    const problem = ProblemDocumentSchema.parse(await response.json());
    expect(problem.code).toBe(code);
    expect(await footprint()).toEqual(afterMutation);
    expect(
      await f.db
        .prepare(`SELECT status FROM public_write_attempt_reservations
          WHERE fellow_id = ? AND idempotency_key = ?`)
        .bind(f.binding.fellowId, requestKey)
        .first<{ status: string }>(),
    ).toEqual({ status: "settled_failed" });
    return problem;
  };
  return {
    ...f,
    path,
    recordPath,
    citationId,
    body,
    post,
    open,
    footprint,
    expectRefused,
    arm: (change: () => Promise<void>) => {
      mutation = change;
      afterMutation = undefined;
    },
    screenings: () => screenings,
  };
}

describe("citation admission races", () => {
  for (const mode of ["record", "body-correction", "path-correction"] as const) {
    for (const status of ["resolved", "retired"] as const) {
      test(`${mode} refuses a problem becoming ${status} during screening`, async () => {
        const f = await citationAdmissionFixture(mode);
        f.arm(async () => {
          // Apply the lifecycle projection at the external screening seam.
          // The unchanged chain head also proves that a head-CAS alone is insufficient.
          await f.db
            .prepare("UPDATE problems SET status = ? WHERE id = 'P-4DSP'")
            .bind(status)
            .run();
        });
        const key = `citation-${mode}-${status}`;
        const response = await f.post(f.path, f.body(source), key);
        const problem = await f.expectRefused(response, 422, "CLAIMS_BOARD_LOCKED", key);
        expect(problem.detail).toContain(status);
        const screenings = f.screenings();
        const preflight = await f.post(f.path, f.body(source), `${key}-preflight`);
        expect(preflight.status, await preflight.clone().text()).toBe(422);
        expect(ProblemDocumentSchema.parse(await preflight.json()).code).toBe(
          "CLAIMS_BOARD_LOCKED",
        );
        expect(f.screenings()).toBe(screenings);
      });
    }

    test(`${mode} refuses a duplicate committed by another Fellow during screening`, async () => {
      const f = await citationAdmissionFixture(mode);
      const other = await addApprovedFellow(f, {
        suffix: "citation-racer",
        scopes: ["promote"],
      });
      const otherSession = await f.open(other.call);
      const target = { ...source, locator: "10.1234/citation-admission-raced-source" };
      let winningCitation: string | undefined;
      f.arm(async () => {
        const winner = await f.post(
          `/v1/sessions/${otherSession}/citations`,
          target,
          "citation-winning-duplicate",
          other.call,
        );
        expect(winner.status, await winner.clone().text()).toBe(201);
        winningCitation = RecordCitationResponseSchema.parse(await winner.json()).citation_id;
      });
      const key = `citation-${mode}-duplicate`;
      const response = await f.post(f.path, f.body(target), key);
      const problem = await f.expectRefused(response, 409, "DUPLICATE_CITATION", key);
      expect(winningCitation).toBeDefined();
      if (winningCitation === undefined) throw new Error("The competing citation did not commit");
      expect(problem.detail).toContain(winningCitation);
      expect(problem.fix_hint).toContain(winningCitation);
    });

    test(`${mode} accepts unchanged unique metadata and replays after closure without screening`, async () => {
      const f = await citationAdmissionFixture(mode);
      const request = f.body({
        ...source,
        excerpt: "The corrected excerpt retains the same normalized locator and exact source.",
      });
      const key = `citation-${mode}-success`;
      const response = await f.post(f.path, request, key);
      expect(response.status, await response.clone().text()).toBe(mode === "record" ? 201 : 200);
      const bytes = await response.text();
      if (mode === "record") {
        expect(RecordCitationResponseSchema.parse(JSON.parse(bytes)).version).toBe(1);
      } else {
        expect(CorrectCitationResponseSchema.parse(JSON.parse(bytes)).version).toBe(2);
      }
      const committed = await f.footprint();
      const screens = f.screenings();
      await f.db.prepare("UPDATE problems SET status = 'resolved' WHERE id = 'P-4DSP'").run();
      const replay = await f.post(f.path, request, key);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.text()).toBe(bytes);
      expect(f.screenings()).toBe(screens);
      expect(await f.footprint()).toEqual(committed);
    });
  }

  for (const mode of ["body-correction", "path-correction"] as const) {
    test(`${mode} retains its base-version guard when another correction commits during screening`, async () => {
      const f = await citationAdmissionFixture(mode);
      f.arm(async () => {
        const winner = await f.post(
          f.path,
          f.body({ ...source, title: "A concurrently corrected finite parity reference" }),
          "citation-winning-correction",
        );
        expect(winner.status, await winner.clone().text()).toBe(200);
        expect(CorrectCitationResponseSchema.parse(await winner.json()).version).toBe(2);
      });
      const key = `citation-${mode}-stale-version`;
      const response = await f.post(f.path, f.body(source), key);
      await f.expectRefused(response, 409, "OBJECT_VERSION_CONFLICT", key);
    });
  }
});
