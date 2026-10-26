import { afterEach, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { recordDirectiveDisclosure } from "../../src/directives/disclosure-store.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import {
  DISCLOSURE_OTHER,
  DISCLOSURE_PROBLEM,
  DISCLOSURE_SPONSOR,
  directiveDisclosureFixture,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  f.sql.query(`UPDATE problems SET status = 'active', title = 'Disclosure review',
    sponsor_id = ?, created_by_fellow_id = ? WHERE id = ?`)
    .run(DISCLOSURE_SPONSOR, f.binding.fellowId, DISCLOSURE_PROBLEM);
  f.sql.query(`INSERT INTO problem_statement_versions
    (problem_id, version, statement, norm_hash, falsifier, motivation, created_at)
    VALUES (?, 1, 'Establish the finite bound.', 'sha256:fixture',
      'A member violating the bound.', 'An exact review target.', ?)`)
    .run(DISCLOSURE_PROBLEM, new Date().toISOString());
  return f;
}
const problem = (f: Fixture) => f.sql.query("SELECT * FROM problems WHERE id = ?")
  .get(DISCLOSURE_PROBLEM) as Problem;
const request = (key: string) => new Request(
  `https://a.asimposium.org/v1/sponsors/problems/${DISCLOSURE_PROBLEM}/lifecycle`,
  { method: "POST", headers: { "idempotency-key": key } },
);
const action = { action: "enter-result-review", result_claim: { claim_id: "C-1", version: 1 } } as const;
const govern = (f: Fixture, key: string, db = f.db) => applyPublicProblemGovernance(
  db, problem(f), DISCLOSURE_SPONSOR, action, request(key),
);
async function attest(f: Fixture, key: string, sponsorId = DISCLOSURE_SPONSOR) {
  const receipt = await recordDirectiveDisclosure(f.db, f.target, sponsorId,
    await f.command(sponsorId), key);
  expect(receipt).not.toBeInstanceOf(Response);
  return receipt;
}
function publicState(f: Fixture) {
  return {
    events: f.sql.query("SELECT id, seq, type FROM events ORDER BY seq").all(),
    head: f.sql.query("SELECT public_seq, chain_digest, status FROM problems WHERE id = ?")
      .get(DISCLOSURE_PROBLEM),
    cursor: f.sql.query("SELECT cursor FROM public_cursor").get(),
  };
}

test("result review requires actual exact-lineage disclosure and replays its accepted transition", async () => {
  const f = await fixture();
  const before = publicState(f);
  const missing = await govern(f, "missing-coverage");
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ code: "OBJECT_VERSION_CONFLICT" });
  expect(publicState(f)).toEqual(before);
  await attest(f, "declared");
  const accepted = await govern(f, "enter-review");
  expect(accepted.status).toBe(200);
  const receipt = await accepted.json();
  expect(problem(f).status).toBe("under-result-review");
  await f.issueDirective("new-direction-after-review");
  const replay = await govern(f, "enter-review");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type = 'problem.result-review-started'").get())
    .toEqual({ n: 1 });
});

test("a receiving sponsor's declaration cannot authorize result review for an unresolved prior interval", async () => {
  const f = await fixture();
  await attest(f, "before-transfer");
  await f.transfer();
  await attest(f, "receiving-interval", DISCLOSURE_OTHER);
  const before = publicState(f);
  expect((await govern(f, "prior-interval-missing")).status).toBe(409);
  expect(publicState(f)).toEqual(before);
  await attest(f, "original-final-interval");
  expect((await govern(f, "all-intervals-covered")).status).toBe(200);
});

test("new steering after the coverage read aborts the complete result-review transaction", async () => {
  const f = await fixture();
  await attest(f, "before-race");
  const before = publicState(f);
  let armed = false;
  let raced = false;
  const racingDb = {
    prepare(query: string) {
      const statement = f.db.prepare(query);
      if (query.includes("AS lineage_digest") && query.includes("selected.problem_id")) {
        const first = statement.first.bind(statement);
        statement.first = (async (...args: Parameters<typeof first>) => {
          const result = await first(...args);
          armed = true;
          return result;
        }) as typeof statement.first;
      }
      return statement;
    },
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      if (armed && !raced) {
        raced = true;
        await f.issueDirective("race-after-coverage-read");
      }
      return f.db.batch(statements);
    },
  } as D1Database;
  const refused = await govern(f, "racing-result-review", racingDb);
  expect(armed && raced).toBe(true);
  expect(refused.status).toBe(409);
  expect(publicState(f)).toEqual(before);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type = 'problem.result-review-started'").get())
    .toEqual({ n: 0 });
});
