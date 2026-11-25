import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  type HonorsResultRecord,
  type HonorsSourceWitness,
  prepareHonorsSourceCheck,
  readHonorsClaim,
} from "../../src/discovery/honors-provenance.ts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import { sha256Hex } from "../../src/krater/krater.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";

// Real SQLite predicates over modeled read tables. The Workerd journey covers
// actual publication, disclosure, correction admission and retained projections.
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function databaseFixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE problems(id TEXT,status TEXT,unlisted INTEGER,public_seq INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,payload_sha256 TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,object_id TEXT,object_version INTEGER,type TEXT,object_kind TEXT,
      actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT,created_at TEXT);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE screening_publications(event_id TEXT PRIMARY KEY,provenance_json TEXT NOT NULL);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,visibility TEXT,version INTEGER);
    CREATE TABLE directive_disclosure_targets(problem_id TEXT,claim_id TEXT,claim_version INTEGER,
      content_digest TEXT,source_event_id TEXT,lineage_json TEXT,scope_requirements_json TEXT,invalidated INTEGER);
    CREATE TABLE directive_disclosure_records(event_id TEXT,problem_id TEXT,claim_id TEXT,claim_version INTEGER,
      seq INTEGER,revision INTEGER,sponsor_id TEXT,scope_id TEXT,coverage_digest TEXT,content_digest TEXT,
      source_event_id TEXT,decision TEXT,public_payload_json TEXT,public_payload_sha256 TEXT);
    CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,content_digest TEXT);
    CREATE TABLE evidence(evidence_id TEXT,problem_id TEXT,source_event_id TEXT,source_seq INTEGER,
      bears_on_kind TEXT,bears_on_id TEXT,bears_on_version INTEGER,direction TEXT);
    CREATE TABLE reviews(review_id TEXT,problem_id TEXT,source_event_id TEXT,source_seq INTEGER,
      target_claim_id TEXT,target_version INTEGER,verdict TEXT,capable_of_failure TEXT,
      rubric_json TEXT,basis TEXT,body_md TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,target_object TEXT,seq INTEGER,author_fellow_id TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,event_sha256 TEXT,problem_id TEXT,
      retraction_id TEXT,target_object TEXT,fellow_id TEXT,seq INTEGER,source_event_id TEXT,
      claim_version INTEGER,claim_id TEXT,source_sha256 TEXT,target_kind TEXT);
    CREATE TABLE claim_concessions(event_id TEXT,event_sha256 TEXT,problem_id TEXT,claim_id TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT,name TEXT);
    INSERT INTO problems VALUES('P-TEST','resolved',0,3);`);
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...args: (string | number | null)[]) {
          return {
            async all() {
              return { success: true, results: db.query(sql).all(...args) };
            },
            async first() {
              return db.query(sql).get(...args);
            },
          };
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.all()));
    },
  } as unknown as D1Database;
  return { db, d1 };
}
function fixture() {
  const { db, d1 } = databaseFixture();
  const insert = (
    id: string,
    seq: number,
    body: string,
    object: string,
    kind: string,
    fellow: string | null,
  ): HonorsSourceWitness => {
    const digest = createHash("sha256").update(body).digest("hex");
    db.query(`INSERT INTO events(id,problem_id,seq,payload_sha256,actor_fellow_id,
      actor_sponsor_id,object_id,object_version,type,object_kind)
      VALUES(?,'P-TEST',?,?,?,?,?,1,?,?)`).run(
      id,
      seq,
      digest,
      fellow,
      "usr-owner",
      object,
      kind === "directive-disclosure" ? "directive.disclosure-recorded" : `${kind}.created`,
      kind,
    );
    db.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, digest, body);
    return { event: id, seq, digest, body, fellow, sponsor: "usr-owner" };
  };
  const science = insert("E-science", 1, '{"claim_id":"C-1"}', "C-1", "claim", "F-author");
  const context = insert("E-context", 2, '{"claim_id":"C-2"}', "C-2", "claim", "F-other");
  const disclosure = insert(
    "E-disclosure",
    3,
    '{"decision":"no-undisclosed"}',
    "E-disclosure",
    "directive-disclosure",
    null,
  );
  db.query(`INSERT INTO directive_disclosure_targets VALUES('P-TEST','C-1',1,'content','E-science',
    '{"pins":[]}','[{"scope_id":"scope","coverage_digest":"coverage"}]',0)`).run();
  db.query(`INSERT INTO directive_disclosure_records VALUES('E-disclosure','P-TEST','C-1',1,
    3,1,'usr-owner','scope','coverage','content','E-science','no-undisclosed',?,?)`).run(
    disclosure.body,
    disclosure.digest,
  );
  const record: HonorsResultRecord = {
    item: {
      kind: "claim",
      result_id: "C-1",
      version: 1,
      cursor: 3,
      problem_id: "P-TEST",
      settled_at: "2026-10-27T00:00:00.000Z",
      sequence: 3,
      status: "strongly-supported",
      title: "Exact result",
      contributing_fellows: [],
      carrying_reviewers: [],
      dag_context: { depends_on: [], unlocks: ["C-2@1"], closes_gaps: [] },
      evidence_trail: [],
    },
    scope: { problem: "P-TEST", through: 3, claim: "C-1", version: 1 },
    witnesses: [science, disclosure],
    contextWitnesses: [context],
  };
  const available = async () =>
    (await prepareHonorsSourceCheck(d1, record).all<{ available: number }>()).results[0]?.available;
  return { db, d1, record, available };
}

test("the final release check accepts matching science, disclosure and DAG witnesses", async () => {
  const f = fixture();
  expect(await f.available()).toBe(1);
});
test("a closing screening receipt is pinned through the final honors release", async () => {
  const f = fixture();
  // This helper verifies exact already-decoded witnesses, not schema admission.
  const receipt = '{"retained":"closing-publication-receipt"}';
  f.db.query("INSERT INTO screening_publications VALUES('E-context',?)").run(receipt);
  const record: HonorsResultRecord = {
    ...f.record,
    closingScreeningReceipt: { event: "E-context", provenance: receipt },
  };
  const available = async () =>
    (await prepareHonorsSourceCheck(f.d1, record).all<{ available: number }>()).results[0]
      ?.available;
  expect(await available()).toBe(1);
  f.db.exec(
    "UPDATE screening_publications SET provenance_json='changed' WHERE event_id='E-context'",
  );
  expect(await available()).toBe(0);
  f.db
    .query("UPDATE screening_publications SET provenance_json=? WHERE event_id='E-context'")
    .run(receipt);
  expect(await available()).toBe(1);
});
test("legacy notice absence is also a pinned source fact, and unrelated receipts do not qualify it", async () => {
  const f = fixture();
  const record: HonorsResultRecord = {
    ...f.record,
    closingScreeningReceipt: { event: "E-context", provenance: null },
  };
  const available = async () =>
    (await prepareHonorsSourceCheck(f.d1, record).all<{ available: number }>()).results[0]
      ?.available;
  expect(await available()).toBe(1);
  f.db.exec("INSERT INTO screening_publications VALUES('E-science','unrelated')");
  expect(await available()).toBe(1);
  f.db.exec("INSERT INTO screening_publications VALUES('E-context','changed')");
  expect(await available()).toBe(0);
});
test("a closing notice cannot name a source outside the retained publication witnesses", () => {
  const f = fixture();
  expect(() =>
    prepareHonorsSourceCheck(f.d1, {
      ...f.record,
      closingScreeningReceipt: { event: "E-foreign", provenance: null },
    }),
  ).toThrow("exact source witness");
});
for (const [label, change] of [
  ["later science event", "UPDATE problems SET public_seq=4"],
  ["unlisted problem", "UPDATE problems SET unlisted=1"],
  ["private problem", "UPDATE problems SET status='private-draft'"],
  [
    "redacted carrying source",
    "UPDATE event_content SET redacted_at='now' WHERE event_id='E-science'",
  ],
  [
    "substituted bytes under the old digest",
    "UPDATE event_content SET payload_json='{}' WHERE event_id='E-science'",
  ],
  [
    "changed historical actor",
    "UPDATE events SET actor_sponsor_id='usr-other' WHERE id='E-science'",
  ],
  [
    "hidden exact science version",
    "INSERT INTO content_controls VALUES('P-TEST','C-1@1','hidden',1)",
  ],
  ["hidden downstream context", "INSERT INTO content_controls VALUES('P-TEST','C-2','hidden',1)"],
  [
    "hidden context publication event",
    "INSERT INTO content_controls VALUES('P-TEST','#2','hidden',1)",
  ],
  [
    "hidden sponsor disclosure",
    "INSERT INTO content_controls VALUES('P-TEST','E-disclosure','hidden',1)",
  ],
  ["withdrawn disclosure", "UPDATE directive_disclosure_records SET decision='withdraw'"],
] as const) {
  test(`an intervening ${label} fails the final release check`, async () => {
    const f = fixture();
    expect(await f.available()).toBe(1);
    f.db.exec(change);
    expect(await f.available()).toBe(0);
  });
}
test("conflicting retained source pins and oversized documents fail closed before D1", () => {
  const f = fixture();
  const original = f.record.witnesses[0];
  if (!original) throw new Error("Missing source witness in fixture");
  f.record.contextWitnesses.push({ ...original, body: "changed" });
  expect(() => prepareHonorsSourceCheck(f.d1, f.record)).toThrow("witnesses disagree");
  f.record.contextWitnesses.splice(1);
  f.record.contextWitnesses.push({
    event: "oversized",
    seq: 2,
    digest: "0".repeat(64),
    body: "x".repeat(1024 * 1024),
    fellow: null,
    sponsor: null,
  });
  expect(() => prepareHonorsSourceCheck(f.d1, f.record)).toThrow("read budget");
});

const formalArtifact = {
  language: "lean",
  declaration: "two_eq_two",
  source: "theorem two_eq_two : (2 : Nat) = 2 := rfl",
  toolchain: "leanprover/lean4:v4.19.0",
  axiom_report: "'two_eq_two' depends on axioms: []",
};

/** Exercise the production reader, including its real SQLite source queries,
 * canonical scientific folds, disclosure and final source recheck. These are
 * retained source fixtures, not a test of write admission or Lean compilation. */
async function claimFixture(
  options: {
    proofKind?: "argument" | "construction" | "certificate";
    extraAttempt?: Record<string, unknown>;
  } = {},
) {
  const { db, d1 } = databaseFixture();
  let sequence = 0;
  const statement = "Two equals two.";
  const contentDigest = await claimContentDigest(
    { kind: "lemma", statement, falsifier: null },
    sha256Hex,
  );
  const add = async (
    kind: string,
    object: string,
    payload: Record<string, unknown>,
    fellow: string | null = "F-author",
    sponsor = "S-author",
  ) => {
    const seq = ++sequence;
    const event = kind === "directive-disclosure" ? object : `EVENT-${seq}`;
    const body = JSON.stringify(payload);
    const digest = await sha256Hex(body);
    db.query(`INSERT INTO events VALUES(?, 'P-TEST', ?, ?, ?, ?, ?, 1, ?, ?,
      'SESSION', 'declared-model', 'declared-harness', ?)`).run(
      event,
      seq,
      digest,
      fellow,
      sponsor,
      object,
      kind === "directive-disclosure" ? "directive.disclosure-recorded" : `${kind}.created`,
      kind,
      new Date(Date.UTC(2026, 9, 27, 0, seq)).toISOString(),
    );
    db.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(event, digest, body);
    if (kind === "evidence")
      db.query("INSERT INTO evidence VALUES(?,'P-TEST',?,?,'claim','C-1',1,?)").run(
        object,
        event,
        seq,
        String(payload.direction),
      );
    if (kind === "review")
      db.query("INSERT INTO reviews VALUES(?,'P-TEST',?,?,'C-1',1,'confirm',?,'[]',?,?)").run(
        object,
        event,
        seq,
        String(payload.capable_of_failure),
        String(payload.basis),
        String(payload.body_md),
      );
    return { event, seq, digest, body, fellow, sponsor };
  };
  const publication = await add("claim", "C-1", {
    claim_id: "C-1",
    kind: "lemma",
    statement,
    falsifier: null,
    dependency_pins: [],
    scientific_provenance: { model_family_self_declared: "gpt" },
  });
  db.query("INSERT INTO claim_versions VALUES('P-TEST','C-1',1,?)").run(contentDigest);
  const evidence = (object: string, fields: Record<string, unknown>) =>
    add("evidence", object, {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "computation",
      direction: "supports",
      mode: "confirmatory",
      computed_class: "computation",
      body_md: "An exact comparison of the integer with itself returns equality.",
      ...fields,
    });
  const basis = await evidence("E-basis", {});
  const check = {
    target_digest: contentDigest,
    attempted_falsifier: "Compare two with itself.",
    capable_of_failure: "An unequal result.",
    result: "survived",
    evidence: [{ evidence_id: "E-basis", digest: `sha256:${basis.digest}` }],
  };
  await evidence("E-check", { direction: "informs", falsification_check: check });
  if (options.extraAttempt)
    await evidence("E-unearned", {
      direction: "informs",
      falsification_check: check,
      ...options.extraAttempt,
    });
  const proofKind = options.proofKind ?? "argument";
  const proof = await evidence("E-proof", {
    kind: proofKind,
    computed_class: proofKind === "certificate" ? "computation" : "assertion",
    body_md: "Equality is reflexive, so two equals two.",
    ...(proofKind === "certificate"
      ? { formal_artifact: formalArtifact }
      : { source: { kind: "model_memory" } }),
  });
  for (const family of ["claude", "gemini"]) {
    const target = {
      target_digest: contentDigest,
      evidence: { evidence_id: "E-proof", digest: `sha256:${proof.digest}` },
    };
    const verification =
      proofKind === "certificate"
        ? {
            ...target,
            kind: "formal-artifact",
            artifact_digest: `sha256:${await sha256Hex(formalArtifact.source)}`,
            compilation: {
              command: "lean Proof.lean",
              toolchain: formalArtifact.toolchain,
              result: "success",
              output: "The declaration compiled successfully.",
            },
            statement_comparison: {
              declaration: formalArtifact.declaration,
              statement,
              result: "equivalent",
              explanation: "The formal declaration states the same reflexive equality.",
            },
          }
        : {
            ...target,
            kind: "full-write-up",
            coverage: ["The full argument for the exact integer equality."],
            result: "verified",
          };
    await add(
      "review",
      `R-${family}`,
      {
        target_claim_id: "C-1",
        target_version: 1,
        verdict: "confirm",
        tier: "T2",
        basis: "Checked that reflexivity applies to the exact integer in the statement.",
        body_md: "The statement follows from reflexivity of equality.",
        capable_of_failure: "An unequal result or a mismatch with the target statement.",
        independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
        scientific_provenance: { model_family_self_declared: family },
        verification,
      },
      `F-${family}`,
      `S-${family}`,
    );
  }
  const disclosure = await add(
    "directive-disclosure",
    "DISCLOSURE",
    {
      decision: "no-undisclosed",
    },
    null,
  );
  db.query(`INSERT INTO directive_disclosure_targets VALUES('P-TEST','C-1',1,?,?,'{"pins":[]}',
    '[{"scope_id":"scope","coverage_digest":"coverage"}]',0)`).run(
    contentDigest,
    publication.event,
  );
  db.query(`INSERT INTO directive_disclosure_records VALUES(?,'P-TEST','C-1',1,
    ?,1,'S-author','scope','coverage',?,?,'no-undisclosed',?,?)`).run(
    disclosure.event,
    disclosure.seq,
    contentDigest,
    publication.event,
    disclosure.body,
    disclosure.digest,
  );
  db.query("UPDATE problems SET public_seq=?").run(sequence);
  return readHonorsClaim(d1, "P-TEST", sequence, "C-1@1");
}

for (const proofKind of ["argument", "construction", "certificate"] as const) {
  test(`the honors reader preserves a qualifying ${proofKind} and its grounded check`, async () => {
    const result = await claimFixture({ proofKind });
    // The independent computation remains the chain's ceiling even when a
    // qualifying formal artifact supplies the reviewed proof.
    expect(result?.item.status).toBe("strongly-supported");
    expect(new Set(result?.item.evidence_trail)).toEqual(
      new Set(["E-proof", "E-check", "E-basis"]),
    );
  });
}

for (const computed_class of ["computation", "certified"] as const) {
  for (const [label, artifact] of [
    ["missing formal source", undefined],
    ["proof hole", { ...formalArtifact, source: "theorem two_eq_two : (2 : Nat) = 2 := by sorry" }],
    ["unrelated declaration", { ...formalArtifact, declaration: "another_theorem" }],
  ] as const) {
    test(`honors does not credit a legacy ${computed_class} attempt with ${label}`, async () => {
      const result = await claimFixture({
        extraAttempt: {
          kind: "certificate",
          computed_class,
          ...(artifact === undefined ? {} : { formal_artifact: artifact }),
        },
      });
      expect(result?.item.status).toBe("strongly-supported");
      expect(new Set(result?.item.evidence_trail)).toEqual(
        new Set(["E-proof", "E-check", "E-basis"]),
      );
    });
  }
}
