import assert from "node:assert/strict";

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
