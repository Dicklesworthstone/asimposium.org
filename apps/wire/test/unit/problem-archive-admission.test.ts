import { afterEach, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { writeLedgerBatch, writeLedgerEvent } from "../../src/krater/krater.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import {
  archivedProblemWriteProblem,
  isArchivedProblemWriteError,
} from "../../src/sessions/problem-archive-admission.ts";
import { checkAndReserveQuota, checkAndReserveQuotaBatch } from "../../src/sessions/quota.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SESSION,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  return f;
}
function archive(f: Fixture) {
  f.sql.query("UPDATE problems SET admission_mode='archived-read-only' WHERE id=?").run(PROBLEM);
}
function state(f: Fixture) {
  return {
    ...f.state(),
    outbox: f.sql.query("SELECT event_id FROM outbox ORDER BY event_id").all(),
    checkpoints: f.sql
      .query("SELECT checkpoint_seq FROM integrity_checkpoints ORDER BY checkpoint_seq")
      .all(),
  };
}
const quota = {
  fellowId: FELLOW,
  problemId: PROBLEM,
  sponsorId: SPONSOR,
  sessionId: SESSION,
  route: "hypotheses",
  idempotencyKey: "archive-attempt",
  requestDigest: "a".repeat(64),
};

test("archived problems refuse a prepared scientific write without ledger side effects", async () => {
  const f = await fixture(),
    member = f.command(f.input());
  archive(f);
  const before = state(f);
  await expect(writeLedgerEvent(f.db, member.input, member.projection)).rejects.toThrow(
    "PROBLEM_ARCHIVED_READ_ONLY",
  );
  expect(state(f)).toEqual(before);
});

test("archiving after the writer reads its head rolls back the entire write", async () => {
  const f = await fixture(),
    member = f.command(f.input());
  const before = state(f);
  await expect(
    writeLedgerEvent(f.db, member.input, member.projection, {
      afterReadHead: async () => {
        archive(f);
      },
    }),
  ).rejects.toThrow("PROBLEM_ARCHIVED_READ_ONLY");
  expect(state(f)).toEqual(before);
});

test("archived problems refuse a scientific batch without a prefix or replay settlement", async () => {
  const f = await fixture();
  const members = [f.command(f.input("First candidate.")), f.command(f.input("Second candidate."))];
  archive(f);
  const before = state(f);
  await expect(writeLedgerBatch(f.db, members, () => [])).rejects.toThrow(
    "PROBLEM_ARCHIVED_READ_ONLY",
  );
  expect(state(f)).toEqual(before);
});

test("an accepted scientific receipt still replays after archival", async () => {
  const f = await fixture(),
    member = f.command(f.input());
  const accepted = await writeLedgerEvent(f.db, member.input, member.projection);
  archive(f);
  const before = state(f);
  const replay = await writeLedgerEvent(
    f.db,
    {
      ...member.input,
      eventId: `retry-${member.input.eventId}`,
    },
    member.projection,
  );
  expect(replay.eventId).toBe(accepted.eventId);
  expect(replay.seq).toBe(accepted.seq);
  expect(replay.idempotent).toBe(true);
  expect(state(f)).toEqual(before);
});

test("archived scientific attempts cannot reserve screening capacity singly or in a batch", async () => {
  const f = await fixture();
  archive(f);
  await expect(checkAndReserveQuota(f.db, quota)).rejects.toThrow("PROBLEM_ARCHIVED_READ_ONLY");
  await expect(
    checkAndReserveQuotaBatch(f.db, {
      ...quota,
      members: [1, 2].map((n) => ({
        route: "hypotheses" as const,
        idempotencyKey: `archive-${n}`,
        requestDigest: quota.requestDigest,
      })),
    }),
  ).rejects.toThrow("PROBLEM_ARCHIVED_READ_ONLY");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM public_write_attempt_reservations").get()).toEqual({
    n: 0,
  });
  // A route name alone cannot claim the separate governance accounting lane.
  await expect(checkAndReserveQuota(f.db, { ...quota, route: "problem-retire" })).rejects.toThrow(
    "PROBLEM_ARCHIVED_READ_ONLY",
  );
  const governance = await checkAndReserveQuota(f.db, {
    ...quota,
    route: "problem-retire",
    sessionId: `problem-governance:${PROBLEM}`,
  });
  expect(governance.allowed).toBe(true);
});

test("current sponsor governance can archive and reopen without borrowing Fellow authorship", async () => {
  const f = await fixture();
  f.sql.query("UPDATE problems SET created_by_fellow_id=? WHERE id=?").run(FELLOW, PROBLEM);
  const govern = (mode: "open" | "archived-read-only", key: string) =>
    applyPublicProblemGovernance(
      f.db,
      f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Parameters<
        typeof applyPublicProblemGovernance
      >[1],
      SPONSOR,
      { action: "set-admission-mode", mode },
      new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
        method: "POST",
        headers: { "idempotency-key": key },
      }),
    );
  expect((await govern("archived-read-only", "archive-governance")).status).toBe(200);
  const member = f.command(f.input());
  await expect(writeLedgerEvent(f.db, member.input, member.projection)).rejects.toThrow(
    "PROBLEM_ARCHIVED_READ_ONLY",
  );
  expect((await govern("open", "reopen-governance")).status).toBe(200);
  await writeLedgerEvent(f.db, member.input, member.projection);
  const events = f.sql.query("SELECT actor_fellow_id FROM events ORDER BY seq").all();
  expect(events).toEqual([
    { actor_fellow_id: null },
    { actor_fellow_id: null },
    { actor_fellow_id: FELLOW },
  ]);
});

test("archive refusal classification is bounded and does not disclose database diagnostics", async () => {
  expect(isArchivedProblemWriteError(new Error("D1_ERROR: PROBLEM_ARCHIVED_READ_ONLY"))).toBe(true);
  expect(
    isArchivedProblemWriteError(
      new Error("batch failed", { cause: new Error("PROBLEM_ARCHIVED_READ_ONLY") }),
    ),
  ).toBe(true);
  for (const message of [
    "UNRELATED",
    "NOT_PROBLEM_ARCHIVED_READ_ONLY",
    "PROBLEM_ARCHIVED_READ_ONLY_SUFFIX",
    "x".repeat(4097),
  ])
    expect(isArchivedProblemWriteError(new Error(message))).toBe(false);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  expect(isArchivedProblemWriteError(circular)).toBe(false);
  expect(
    isArchivedProblemWriteError({
      get message() {
        throw new Error("private SQL");
      },
    }),
  ).toBe(false);
  const response = archivedProblemWriteProblem();
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = ProblemDocumentSchema.parse(await response.json());
  expect(body.code).toBe("WRITE_REFUSED");
  expect(JSON.stringify(body)).not.toContain("PROBLEM_ARCHIVED_READ_ONLY");
});
