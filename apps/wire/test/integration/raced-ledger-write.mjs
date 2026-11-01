import assert from "node:assert/strict";
import { ContractProblemSchema } from "@asimposium/contracts";

/** Two concurrent direct-append journeys use the actual publication protocol.
 * Launch the entire first wave before finish(): a stale context permits one
 * fresh public read and the exact same candidate/key, never a blind retry or
 * a quota reset. Every refusal and success is checked against real D1 rows.
 */
export function directAppendProbe(context, problemId) {
  const { worker, origin, userAgent, env, call } = context;
  const eventCount = async (request) => {
    const claim = request.path.endsWith("/claims");
    const field = claim ? "statement" : "approach";
    return (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM events e JOIN event_content c ON c.event_id = e.id
         WHERE e.problem_id = ? AND e.type = ? AND json_extract(c.payload_json, ?) = ?`,
      )
        .bind(
          problemId,
          claim ? "claim.created" : "dead_end.recorded",
          `$.${field}`,
          request.body[field],
        )
        .first()
    ).n;
  };
  const replayCount = async (request) =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM session_write_replays WHERE idempotency_key = ?",
      )
        .bind(request.key)
        .first()
    ).n;
  const absent = async (request) => {
    assert.equal(await eventCount(request), 0, "a refusal did not publish the candidate");
    assert.equal(await replayCount(request), 0, "a refusal did not bind a successful replay");
  };
  const send = async (request) => {
    assert.equal(JSON.stringify(request.body), request.raw, "candidate bytes remain unchanged");
    const response = await worker.fetch(`${origin}${request.path}`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${request.token}`,
        "content-type": "application/json",
        "Idempotency-Key": request.key,
      },
      body: request.raw,
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const refusal = (result, status, code) => {
    ContractProblemSchema.parse(result.data);
    assert.equal(result.status, status);
    assert.equal(result.data.status, status);
    assert.equal(result.data.code, code);
    assert.equal(result.data.rule, "A5");
    assert.ok(result.data.fix_hint);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  };
  const finish = async (request, first, allowRateLimit = false) => {
    let result = first;
    let recovered = false;
    if (result.data.code === "SCREENING_CONTEXT_STALE") {
      refusal(result, 409, "SCREENING_CONTEXT_STALE");
      await absent(request);
      await call(`/p/${problemId}.json`);
      result = await send(request);
      recovered = true;
    }
    if (allowRateLimit && result.data.code === "PROMOTION_RATE_LIMITED") {
      refusal(result, 429, "PROMOTION_RATE_LIMITED");
      assert.equal(result.data.limit, 20);
      assert.equal(result.data.remaining, 0);
      assert.ok(result.data.retry_after_seconds > 0);
      assert.equal(Number(result.headers.get("retry-after")), result.data.retry_after_seconds);
      const fellow = (await call("/v1/hello", undefined, request.token)).fellow.fellow_id;
      const attempts = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM public_write_attempt_reservations WHERE fellow_id = ? AND problem_id = ? AND reserved_at > ?",
      )
        .bind(fellow, problemId, Date.now() - 3_600_000)
        .first();
      assert.ok(attempts.n >= 20, "the actual Fellow/problem attempt allowance is exhausted");
      await absent(request);
      return { ...result, recovered };
    }
    assert.equal(result.data.code, undefined, "the exact candidate eventually published");
    assert.equal(result.status, 201);
    assert.equal(await eventCount(request), 1, "the candidate has exactly one publication");
    assert.equal(await replayCount(request), 1, "the candidate has exactly one successful replay");
    return { ...result, recovered };
  };
  return { send, finish };
}

/**
 * uwr8: a ledger write whose problem head moved after the route read it
 * writes no event (writeLedgerEvent's event INSERT selects nothing) and must
 * leave no projection change behind either. A competing write is stood in for
 * by advancing public_seq just before the ledger batch (the fixture fires on
 * the batch that inserts the event) and restoring it afterwards, so the rest
 * of the lane sees an unchanged chain.
 */
export async function assertRacedWriteLeavesNoTrace({
  env,
  fixtures,
  problemId,
  label,
  attempt,
  observe,
}) {
  const events = async () =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
        .bind(problemId)
        .first()
    ).n;
  const before = await observe();
  const eventsBefore = await events();
  await fixtures.armRaceBeforeNextBatch(
    "UPDATE problems SET public_seq = public_seq + 1 WHERE id = ?",
    [problemId],
    "INSERT INTO events",
  );
  const outcome = await attempt();
  const ran = !(await fixtures.raceStillArmed());
  if (ran) {
    await env.DB.prepare("UPDATE problems SET public_seq = public_seq - 1 WHERE id = ?")
      .bind(problemId)
      .run();
  } else {
    await fixtures.disarmRace();
  }
  assert.ok(ran, `${label}: the race reached the ledger batch`);
  assert.ok(outcome?.code !== undefined, `${label}: the raced write was refused`);
  assert.equal(await events(), eventsBefore, `${label}: no event was written`);
  assert.deepEqual(await observe(), before, `${label}: the projection is unchanged`);
}
