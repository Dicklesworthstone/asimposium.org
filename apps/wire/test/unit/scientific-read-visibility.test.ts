import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../../src/ledger/claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../../src/ledger/claim-dependency-closure.ts";
import {
  foldScientificRows,
  prepareScientificDispositions,
  readScientificDispositions,
  type ScientificRow,
} from "../../src/ledger/scientific-disposition.ts";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { iso, SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

type Fixture = ReturnType<typeof withdrawalFixture>;
type Source = ReturnType<Fixture["source"]>;

/** SQL-backed unit proof of the production readers and folds, not Workerd/D1
 * integration. Source bytes and moderation records use the existing fixture. */
async function using(body: (fixture: Fixture) => Promise<void>) {
  const fixture = withdrawalFixture();
  try {
    await body(fixture);
  } finally {
    fixture.close();
  }
}

function control(
  f: Fixture,
  target: string,
  visibility: "hidden" | "visible" = "hidden",
  problem = "P-DEMO",
) {
  const previous = f.sql
    .query(
      "SELECT COALESCE(MAX(version),0) AS version FROM content_controls WHERE problem_id=? AND target_ref=?",
    )
    .get(problem, target) as { version: number };
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'ledger-object',?,?,'operator','privacy','operator-test','Visibility test',?,?)`)
    .run(`CC-${crypto.randomUUID()}`, problem, target, visibility, previous.version + 1, iso());
}

function support(f: Fixture) {
  const base = f.source("evidence", "E-1", { kind: "argument", computed_class: "computation" });
  const check = f.source("evidence", "E-2", {
    computed_class: "computation",
    falsification_check: {
      target_digest: `sha256:${sha("statement")}`,
      attempted_falsifier: "Search for n=0 violating the bound.",
      capable_of_failure: "The observed output could exceed it.",
      result: "survived",
      evidence: [{ evidence_id: base.id, digest: base.request.source_digest }],
    },
  });
  const review = f.source("review", "R-1");
  return { base, check, review };
}

const rows = async (f: Fixture, through = 1000) =>
  (await prepareScientificDispositions(f.db, "P-DEMO", through, 100).all<ScientificRow>()).results;
const fold = async (f: Fixture, through = 1000) => foldScientificRows(await rows(f, through));
const targetRef = (source: Source, target: "object" | "version" | "event") =>
  target === "object"
    ? source.id
    : target === "version"
      ? `${source.id}@1`
      : `#${source.event.seq}`;

for (const input of ["base", "check", "review"] as const) {
  for (const target of ["object", "version", "event"] as const) {
    test(`hidden ${input} ${target} removes positive standing; exact restore recovers it`, () =>
      using(async (f) => {
        const sources = support(f);
        const before = await fold(f);
        assert.equal(before.disposition, "corroborated");
        assert.equal(before.stale, false);
        const source = sources[input];
        const reference = targetRef(source, target);
        control(f, reference);
        const hiddenRows = await rows(f);
        assert.equal(
          hiddenRows.find((row) => row.event_id === source.event.id)?.payload_json,
          null,
        );
        const after = await foldScientificRows(hiddenRows);
        assert.equal(after.disposition, "open");
        assert.equal(after.stale, true);
        if (input === "review") assert.deepEqual(after.context.verified_reviews, []);
        else assert.equal(after.context.recorded_refutation_attempts, 0);
        control(f, reference, "visible");
        assert.deepEqual(await fold(f), before);
      }));
  }
}

test("present-day controls apply at an old cursor and cannot be overridden by another control scope", () =>
  using(async (f) => {
    const { review } = support(f);
    const cut = review.event.seq;
    const before = await fold(f, cut);
    f.source("evidence", "E-3", { mode: "exploratory" });
    control(f, review.id, "hidden", "P-OTHER");
    assert.deepEqual(await fold(f, cut), before);
    control(f, `${review.id}@1`);
    control(f, review.id, "visible");
    assert.equal((await fold(f, cut)).disposition, "open");
    control(f, `#${review.event.seq}`);
    control(f, `${review.id}@1`, "visible");
    assert.equal((await fold(f, cut)).disposition, "open");
    control(f, `#${review.event.seq}`, "visible");
    assert.deepEqual(await fold(f, cut), before);
  }));

for (const target of ["C-1", "C-1@1", "#1", "problem"]) {
  test(`hidden ${target} cannot retain positive scientific standing`, () =>
    using(async (f) => {
      support(f);
      assert.equal((await fold(f)).disposition, "corroborated");
      control(f, target);
      const result = await fold(f);
      assert.equal(result.disposition, "open");
      assert.equal(result.stale, true);
      assert.deepEqual(result.context.verified_reviews, []);
      control(f, target, "visible");
      assert.equal((await fold(f)).disposition, "corroborated");
    }));
}

for (const kind of ["evidence", "review"] as const) {
  test(`hiding refuting ${kind} does not fabricate a resolved dispute`, () =>
    using(async (f) => {
      support(f);
      const source = f.source(
        kind,
        kind === "evidence" ? "E-3" : "R-2",
        kind === "evidence" ? { direction: "refutes" } : { verdict: "refute" },
      );
      assert.equal((await fold(f)).disposition, "disputed");
      control(f, `#${source.event.seq}`);
      const after = await fold(f);
      assert.equal(after.disposition, "disputed");
      assert.equal(after.stale, true);
      assert.equal(
        (await rows(f)).find((row) => row.event_id === source.event.id)?.payload_json,
        null,
      );
    }));
}

test("a hidden withdrawal explanation never resurrects its withdrawn positive review", () =>
  using(async (f) => {
    const { review } = support(f);
    const result = await withdrawScientificInput(
      f.options,
      f.actor,
      SESSION,
      "review",
      review.id,
      review.request,
      "visibility-withdrawal",
    );
    control(f, result.retraction_id);
    const after = await fold(f);
    assert.equal(after.disposition, "open");
    assert.equal(after.stale, true);
    assert.deepEqual(after.context.verified_reviews, []);
  }));

test("a hidden old version stays stale on its own read without contaminating a fresh version", () =>
  using(async (f) => {
    support(f);
    f.append(
      "E-revision",
      "claim.revised",
      "claim",
      "C-1",
      {
        claim_id: "C-1",
        base_version: 1,
        statement: "The revised precise bound.",
      },
      "fellow-b",
      "P-DEMO",
      2,
    );
    f.sql
      .query("INSERT INTO claim_versions VALUES('P-DEMO','C-1',2,?,?,'conjecture')")
      .run(`sha256:${sha("revision")}`, "The revised precise bound.");
    control(f, "C-1@1");
    const current = await fold(f);
    assert.equal(current.currentVersion, 2);
    assert.equal(current.disposition, "open");
    assert.equal(current.stale, false);
    const historical = (
      await readScientificDispositions(f.db, "P-DEMO", 1000, 1, {
        claimId: "C-1",
        version: 1,
      })
    ).get("C-1");
    assert.equal(historical?.disposition, "open");
    assert.equal(historical?.stale, true);
  }));

function addDependencyRoot(f: Fixture) {
  // Add the read-only dependency columns to this modeled parent fixture.
  f.sql.exec(`ALTER TABLE events ADD COLUMN model_string_self_declared TEXT DEFAULT 'declared-model';
    ALTER TABLE events ADD COLUMN harness TEXT DEFAULT 'declared-harness';`);
  const statement = "Every n has the stated bound.";
  const source = JSON.stringify({
    claim_id: "C-1",
    statement,
    kind: "conjecture",
    dependency_pins: [],
  });
  const digest = sha(source);
  f.sql
    .query("UPDATE event_content SET payload_json=?,payload_sha256=? WHERE event_id='E-claim'")
    .run(source, digest);
  f.sql.query("UPDATE events SET payload_sha256=? WHERE id='E-claim'").run(digest);
  const root = f.append(
    "E-root",
    "claim.created",
    "claim",
    "C-2",
    {
      claim_id: "C-2",
      statement: "The conclusion depends on the original bound.",
      kind: "lemma",
      dependency_pins: [
        {
          claim_id: "C-1",
          version: 1,
          event_id: "E-claim",
          payload_digest: digest,
          content_digest: `sha256:${sha("statement")}`,
        },
      ],
    },
    "fellow-b",
  );
  f.sql.query("INSERT INTO claims VALUES('P-DEMO','C-2',?)").run(root.seq);
  f.sql
    .query("INSERT INTO claim_versions VALUES('P-DEMO','C-2',1,?,?,'lemma')")
    .run(`sha256:${sha("root")}`, "The conclusion depends on the original bound.");
}

async function dependencyStanding(f: Fixture) {
  const results = await f.db.batch([
    prepareDependencyClosure(f.db, "P-DEMO", 1000, "C-2@1"),
    prepareDependencyAssessment(f.db, "P-DEMO", 1000, "C-2@1"),
  ]);
  const [publicationResult, sourceResult] = results;
  assert.ok(publicationResult);
  assert.ok(sourceResult);
  const publications = publicationResult.results as DependencyClosureRow[];
  const sources = sourceResult.results as DependencyScientificRow[];
  const closure = await composeDependencyClosure(publications, "P-DEMO", "C-2@1");
  return {
    sources,
    assessments: await composeDependencyAssessment(
      publications,
      closure,
      sources,
      "P-DEMO",
      "C-2@1",
      1000,
    ),
  };
}

for (const input of ["base", "check", "review"] as const) {
  for (const target of ["object", "version", "event"] as const) {
    test(`dependency standing fails closed when a premise's ${input} ${target} is hidden`, () =>
      using(async (f) => {
        addDependencyRoot(f);
        const source = support(f)[input];
        const before = await dependencyStanding(f);
        assert.equal(before.assessments.get("C-1@1")?.standing.disposition, "corroborated");
        assert.equal(before.assessments.get("C-1@1")?.standing.own_ceiling, "computation");
        assert.equal(before.assessments.get("C-2@1")?.chain.complete, true);
        const reference = targetRef(source, target);
        control(f, reference);
        const after = await dependencyStanding(f);
        assert.equal(
          after.sources.find((row) => row.event_id === source.event.id)?.payload_json,
          null,
        );
        assert.equal(after.assessments.get("C-1@1")?.standing.complete, false);
        assert.equal(after.assessments.get("C-1@1")?.standing.disposition, null);
        assert.equal(after.assessments.get("C-1@1")?.standing.own_ceiling, null);
        assert.equal(after.assessments.get("C-2@1")?.chain.complete, false);
        assert.equal(after.assessments.get("C-2@1")?.chain.ceiling, null);
        control(f, reference, "visible");
        assert.deepEqual((await dependencyStanding(f)).assessments, before.assessments);
      }));
  }
}
