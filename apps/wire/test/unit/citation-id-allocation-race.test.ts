import { expect, test } from "bun:test";
import {
  ProblemDocumentSchema,
  type RecordCitationRequest,
  type RecordCitationResponse,
  RecordCitationResponseSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { addApprovedFellow, fixture } from "./session-routes.test.ts";

/** The real router and SQLite unit adapter; this is not a deployed D1 proof. */
test("a raced citation ID returns a retryable conflict without orphaning publication state", async () => {
  let afterAllocation: (() => Promise<void>) | undefined;
  let allocationReads = 0;
  let screenings = 0;
  const f = await fixture({
    afterFirstRead: async (sql) => {
      if (!sql.includes("MAX(CAST(SUBSTR(citation_id, 3) AS INTEGER))")) return;
      allocationReads++;
      // The adapter has already captured the row. Commit a different source
      // before returning that stale ID, without interleaving a D1 transaction.
      const interleave = afterAllocation;
      afterAllocation = undefined;
      await interleave?.();
    },
    screenPromotion: async () => {
      screenings++;
      return {
        decision: "allow-with-warning",
        coarse_category: "dual-use-boundary",
        provider_status: "ok",
      };
    },
  });
  const other = await addApprovedFellow(f, {
    suffix: "citation-id-racer",
    scopes: ["promote"],
  });
  const post = (path: string, body: unknown, key: string, caller = f.call) =>
    caller(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
  const open = async (caller: typeof f.call, key: string) => {
    const response = await post("/v1/sessions", { problem_id: "P-4DSP" }, key, caller);
    expect(response.status, await response.clone().text()).toBe(201);
    return SessionOpenResponseSchema.parse(await response.json()).session_id;
  };
  const sessionId = await open(f.call, "citation-id-first-session");
  const otherSessionId = await open(other.call, "citation-id-other-session");
  const path = `/v1/sessions/${sessionId}/citations`;
  const key = "citation-id-retry";
  const source: RecordCitationRequest = {
    locator_kind: "doi",
    locator: "10.1234/citation-id-source-first",
    title: "Exact bounds for finite parity classifications",
    authors: ["Example Author"],
    year: 2026,
    excerpt: "Enumeration independently checks the two residue classes.",
    retrieved_at: "2026-11-01T00:00:00.000Z",
    source_provenance: "retrieved",
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
        (SELECT COUNT(*) FROM screening_cases) AS screening_cases,
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
  const reservations = async () =>
    (
      await f.db
        .prepare(`SELECT status FROM public_write_attempt_reservations
          WHERE fellow_id = ? AND idempotency_key = ? ORDER BY status`)
        .bind(f.binding.fellowId, key)
        .all()
    ).results;
  let winner: RecordCitationResponse | undefined;
  let afterWinner: Awaited<ReturnType<typeof footprint>> | undefined;
  afterAllocation = async () => {
    const response = await post(
      `/v1/sessions/${otherSessionId}/citations`,
      {
        ...source,
        locator: "10.1234/citation-id-source-other",
        title: "Independent enumeration of bounded residue classes",
      },
      "citation-id-winner",
      other.call,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    winner = RecordCitationResponseSchema.parse(await response.json());
    afterWinner = await footprint();
  };

  const refused = await post(path, source, key);
  expect(afterAllocation).toBeUndefined();
  expect(allocationReads).toBe(2);
  expect(winner).toBeDefined();
  expect(afterWinner).toBeDefined();
  if (winner === undefined || afterWinner === undefined)
    throw new Error("The competing citation did not commit at the ID-allocation seam");
  expect(refused.status, await refused.clone().text()).toBe(409);
  expect(ProblemDocumentSchema.parse(await refused.json()).code).toBe("OBJECT_VERSION_CONFLICT");
  expect(await footprint()).toEqual(afterWinner);
  expect(await reservations()).toEqual([{ status: "settled_failed" }]);
  expect(screenings).toBe(2);

  const retry = await post(path, source, key);
  expect(retry.status, await retry.clone().text()).toBe(201);
  const bytes = await retry.text();
  const recorded = RecordCitationResponseSchema.parse(JSON.parse(bytes));
  expect(recorded.citation_id).not.toBe(winner.citation_id);
  expect(recorded.norm_hash).not.toBe(winner.norm_hash);
  expect(recorded.seq).toBe(winner.seq + 1);
  expect(recorded.version).toBe(1);
  expect(screenings).toBe(3);
  expect(allocationReads).toBe(3);
  expect(await reservations()).toEqual([
    { status: "settled_failed" },
    { status: "settled_published" },
  ]);
  const committed = await footprint();
  expect(committed.citations).toHaveLength(2);
  expect(committed.versions).toHaveLength(2);
  const replay = await post(path, source, key);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.text()).toBe(bytes);
  expect(await footprint()).toEqual(committed);
  expect(await reservations()).toEqual([
    { status: "settled_failed" },
    { status: "settled_published" },
  ]);
  expect(screenings).toBe(3);
  expect(allocationReads).toBe(3);
});
