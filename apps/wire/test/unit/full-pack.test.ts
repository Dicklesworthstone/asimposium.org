import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { FullPackPageSchema, FullPackQuerySchema, PackResponseSchema } from "@asimposium/contracts";
import { composedPackToProjection, renderProjection } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type FullPackInput,
  FullPackSourceUnavailableError,
  readFullPack,
} from "../../src/sessions/full-pack.ts";

const AT = "2026-10-27T00:00:00.000Z";
const PRIVATE = "PRIVATE-WORKSHOP-CREDENTIAL-HANDBACK-CANARY";
const input: FullPackInput = {
  session: `S-${"0".repeat(26)}`,
  problem: "P-DEMO",
  after: 0,
  through: 0,
  requestedMaxTokens: 8000,
  membership: "contributor",
};
const claim = (id: string, statement: string) => ({
  claim_id: id,
  kind: "conjecture",
  statement,
  falsifier: "An integer violating the stated relation.",
  dependency_pins: [],
  workshop_id: PRIVATE,
  private_payload: PRIVATE,
});
const hypothesis = {
  route: "Compare parity classes",
  mechanism: "Examine the two residues modulo two.",
  falsifier: "A residue class violating the proposed relation.",
  origin: "proposed",
  body_md: "Public hypothesis body",
  discriminating_predictions: ["Both residues have equal parity."],
  expected_evidence: null,
};
const evidence = (body = "Public evidence body") => ({
  bears_on_kind: "claim",
  bears_on_id: "C-1",
  bears_on_version: 1,
  direction: "informs",
  kind: "argument",
  mode: "exploratory",
  source: { kind: "model_memory" },
  body_md: body,
  reproduction: null,
});
const review = (body = "Public review body") => ({
  target_claim_id: "C-1",
  target_version: 1,
  verdict: "inform",
  basis: "Checked parity classes.",
  body_md: body,
  rubric: [],
  capable_of_failure: null,
  scientific_provenance: null,
  verification: null,
});
const scientificWithdrawal = {
  target_object: "E-SCIENTIFIC",
  target_kind: "evidence",
  target_event_id: "E-SOURCE-PUBLICATION",
  target_digest: `sha256:${"a".repeat(64)}`,
  retraction_kind: "self-corrected",
  reason: "The original argument omitted a necessary boundary condition.",
};

// These are committed writer payloads, including their public generated
// fields. They deliberately differ from several of the request schemas.
const settlementPublications: readonly {
  type: string;
  kind: string;
  id: string;
  version?: number;
  payload: Record<string, unknown>;
  expected: Record<string, unknown>;
}[] = [
  {
    type: "claim.reanchored",
    kind: "claim",
    id: "C-1",
    payload: { claim_id: "C-1", base_version: 1, statement_version: 2 },
    expected: { claim_id: "C-1", base_version: 1, statement_version: 2 },
  },
  {
    type: "question.asked",
    kind: "question",
    id: "Q-ASK",
    payload: {
      question_id: "Q-ASK",
      problem_id: "P-DEMO",
      target_refs: ["C-1@1"],
      blocking: null,
      body_md: "Does the parity argument cover the zero residue?",
    },
    expected: {
      target_refs: ["C-1@1"],
      blocking: null,
      body_md: "Does the parity argument cover the zero residue?",
    },
  },
  {
    type: "question.leased",
    kind: "question",
    id: "Q-ASK",
    payload: {
      question_id: "Q-ASK",
      leased_by: "F-AUTHOR",
      leased_until: "2026-10-27T01:00:00.000Z",
      objective: "Check the zero residue",
      deliverable: "A public answer artifact",
    },
    expected: {
      leased_by: "F-AUTHOR",
      leased_until: "2026-10-27T01:00:00.000Z",
      objective: "Check the zero residue",
      deliverable: "A public answer artifact",
    },
  },
  {
    type: "question.answered",
    kind: "question",
    id: "Q-ASK",
    payload: { question_id: "Q-ASK", resolved_by_object: "C-1@1" },
    expected: { resolved_by_object: "C-1@1" },
  },
  {
    type: "question.leased",
    kind: "question",
    id: "Q-EXPIRED",
    // The lease interval is calculated before asynchronous screening; it can
    // expire before the publication timestamp and remains valid history.
    payload: {
      question_id: "Q-EXPIRED",
      leased_by: "F-AUTHOR",
      leased_until: "2026-10-26T23:59:00.000Z",
      objective: null,
      deliverable: null,
    },
    expected: { leased_by: "F-AUTHOR", leased_until: "2026-10-26T23:59:00.000Z" },
  },
  {
    type: "question.withdrawn",
    kind: "question",
    id: "Q-WITHDRAW",
    payload: {
      question_id: "Q-WITHDRAW",
      reason: "The question assumed an invalid parity condition.",
    },
    expected: { reason: "The question assumed an invalid parity condition." },
  },
  {
    type: "gap.filed",
    kind: "gap",
    id: "G-2",
    payload: {
      target_claim_id: "C-1",
      target_version: 1,
      obligation: "Check the zero residue explicitly.",
      closes_what: "The missing base case.",
    },
    expected: {
      target_claim_id: "C-1",
      target_version: 1,
      obligation: "Check the zero residue explicitly.",
      closes_what: "The missing base case.",
    },
  },
  {
    type: "gap.closed-by",
    kind: "gap",
    id: "G-1",
    payload: { gap_id: "G-1", outcome: "closed-by", closed_by: "E-PUBLIC" },
    expected: { gap_id: "G-1", outcome: "closed-by", closed_by: "E-PUBLIC" },
  },
  {
    type: "gap.withdrawn",
    kind: "gap",
    id: "G-1",
    payload: { gap_id: "G-1", outcome: "withdrawn", closed_by: null },
    expected: { gap_id: "G-1", outcome: "withdrawn" },
  },
  {
    type: "relation.asserted",
    kind: "relation",
    id: "C-1@1-implies-C-2@3",
    payload: { kind: "implies", source: "C-1@1", target: "C-2@3" },
    expected: { kind: "implies", source: "C-1@1", target: "C-2@3" },
  },
  {
    type: "relation.disputed",
    kind: "relation",
    id: "C-1@1-implies-C-2@3",
    payload: {
      kind: "implies",
      source: "C-1@1",
      target: "C-2@3",
      disputed_by: "F-AUTHOR",
      reason: "The implication fails at the zero residue.",
      refuting_evidence_id: "E-PUBLIC",
    },
    expected: {
      kind: "implies",
      source: "C-1@1",
      target: "C-2@3",
      reason: "The implication fails at the zero residue.",
      refuting_evidence_id: "E-PUBLIC",
    },
  },
  {
    type: "conflict.normalized",
    kind: "conflict",
    id: "CF-ALIGN",
    payload: {
      conflict_id: "CF-ALIGN",
      problem_id: "P-DEMO",
      status: "open",
      author_fellow_id: "F-AUTHOR",
      claims: [
        { claim_id: "C-1", version: 1 },
        { claim_id: "C-2", version: 3 },
      ],
      aligned_definitions: "Both claims use residues in the same integer ring.",
      aligned_scope: "Both claims quantify over every integer residue.",
      aligned_quantifiers: "Both claims use universal quantification over residues.",
      smallest_disagreement: "The claims disagree about the zero residue.",
      agreed_facts: ["Both claims cover nonzero residues."],
      discriminating_tests: ["Evaluate the zero residue under both definitions."],
    },
    expected: {
      status: "open",
      claims: [
        { claim_id: "C-1", version: 1 },
        { claim_id: "C-2", version: 3 },
      ],
      smallest_disagreement: "The claims disagree about the zero residue.",
    },
  },
  {
    type: "conflict.resolved",
    kind: "conflict",
    id: "CF-ALIGN",
    version: 2,
    payload: {
      conflict_id: "CF-ALIGN",
      problem_id: "P-DEMO",
      status: "persistent-uncertainty",
      resolution: "The zero residue remains undecided pending an independent check.",
      resolved_at: AT,
    },
    expected: {
      status: "persistent-uncertainty",
      resolved_at: AT,
      resolution: "The zero residue remains undecided pending an independent check.",
    },
  },
  {
    type: "object.retracted",
    kind: "retraction",
    id: "R-WITHDRAW",
    payload: {
      retraction_id: "R-WITHDRAW",
      target_object: "C-1@1",
      retraction_kind: "self-corrected",
      reason: "The parity argument omitted the zero residue.",
    },
    expected: {
      target_object: "C-1@1",
      retraction_kind: "self-corrected",
      reason: "The parity argument omitted the zero residue.",
    },
  },
  {
    type: "synthesis.created",
    kind: "synthesis",
    id: "SYNTH-HISTORY",
    payload: {
      covers_through: 1,
      body_md: "The original claim still needs a zero-residue check.",
      anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1, target_seq: 1 }],
      omitted: ["No later evidence is included."],
      selection_policy: "Retain the unresolved base case.",
      dropped_single_author_count: 2,
    },
    expected: {
      covers_through: 1,
      body_md: "The original claim still needs a zero-residue check.",
      anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1, target_seq: 1 }],
      omitted: ["No later evidence is included."],
      selection_policy: "Retain the unresolved base case.",
      dropped_single_author_count: 2,
    },
  },
  ...[
    { target_kind: "evidence", claim_id: "C-1", claim_version: 1 },
    { target_kind: "review", claim_id: "C-1", claim_version: 1 },
    { target_kind: "evidence", hypothesis_id: "H-1" },
  ].map((affinity, index) => ({
    type: "object.retracted",
    kind: "retraction",
    id: `R-SCIENTIFIC-${index}`,
    payload: {
      ...scientificWithdrawal,
      ...affinity,
      retraction_id: `R-SCIENTIFIC-${index}`,
    },
    expected: { ...scientificWithdrawal, ...affinity },
  })),
];

// Executes the production selectors against actual SQLite. This is a local
// unit fixture, not a Workerd/D1 or R2 claim.
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, writer_credential_id TEXT);
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE content_controls (problem_id TEXT, target_ref TEXT, visibility TEXT, version INTEGER);
    CREATE TABLE workshop_objects (body_md TEXT);
    CREATE TABLE sessions (handback TEXT);
    INSERT INTO problems VALUES ('P-DEMO',0,'active',0);
  `);
  sql.prepare("INSERT INTO workshop_objects VALUES (?)").run(PRIVATE);
  sql.prepare("INSERT INTO sessions VALUES (?)").run(PRIVATE);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: (string | number | null)[]) {
          return { all: async <T>() => ({ results: sql.prepare(query).all(...values) as T[] }) };
        },
      };
    },
  } as unknown as D1Database;
  let cursor = 0;
  async function append(type: string, kind: string, id: string, payload: object, version = 1) {
    const seq = ++cursor;
    const bytes = JSON.stringify(payload);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    sql
      .prepare(`INSERT INTO events VALUES (?, 'P-DEMO', ?, ?, ?, ?, ?, ?, ?,
      'F-AUTHOR','usr_author','SESSION-AUTHOR','declared-model','declared-harness',?)`)
      .run(`EVENT-${seq}`, seq, type, kind, id, version, AT, hash, PRIVATE);
    sql.prepare("INSERT INTO event_content VALUES (?,?,?,NULL)").run(`EVENT-${seq}`, hash, bytes);
    sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(cursor);
    return seq;
  }
  async function read(options: Partial<FullPackInput> = {}) {
    const pack = await readFullPack(db, { ...input, through: cursor, ...options });
    const body = renderProjection(composedPackToProjection(pack), "json").body;
    const face = PackResponseSchema.parse(JSON.parse(body));
    const pageItem = face.items.find((item) => item.kind === "full-page");
    if (pageItem === undefined) throw new Error("full pack omitted its continuation control");
    const control = FullPackPageSchema.parse(JSON.parse(pageItem.body));
    const records = face.items
      .filter((item) => item.kind === "full-event")
      .map((item) => JSON.parse(item.body));
    return { body, face, control, records };
  }
  function control(target: string, visibility: "hidden" | "visible") {
    sql
      .prepare(`INSERT INTO content_controls SELECT 'P-DEMO',?,?,
      COALESCE(MAX(version),0)+1 FROM content_controls WHERE problem_id='P-DEMO' AND target_ref=?`)
      .run(target, visibility, target);
  }
  return { sql, db, append, read, control, queries };
}

describe("full public ledger packs", () => {
  test("a hidden public scope is a typed absence and its frozen page returns after restore", async () => {
    const f = fixture();
    try {
      const through = await f.append("claim.created", "claim", "C-1", claim("C-1", "VISIBLE-FULL-PACK-CANARY"));
      const original = await f.read({ through });
      expect(original.body).toContain("VISIBLE-FULL-PACK-CANARY");
      f.control("problem", "hidden");
      await expect(f.read({ through })).rejects.toBeInstanceOf(FullPackSourceUnavailableError);
      f.control("problem", "visible");
      expect((await f.read({ through })).body).toBe(original.body);
      f.sql.exec("UPDATE problems SET status='private-draft'");
      await expect(f.read({ through })).rejects.toBeInstanceOf(FullPackSourceUnavailableError);
      await expect(f.read({ problem: "P-MISSING", through: 0 })).rejects.toBeInstanceOf(FullPackSourceUnavailableError);
    } finally {
      f.sql.close();
    }
  });

  test("storage failures remain distinct from a withheld public scope", async () => {
    const failure = new Error("FULL_PACK_STORAGE_FAILURE");
    const db = { prepare() { throw failure; } } as unknown as D1Database;
    await expect(readFullPack(db, input)).rejects.toBe(failure);
  });

  test("dormancy receipts retain the platform decision and its exact quiet interval", async () => {
    const f = fixture();
    try {
      const receipt = {
        problem_id: "P-DEMO", previous_status: "active", status: "dormant",
        observed_through: 0, last_material_event_id: null,
        quiet_since: "2026-09-12T00:00:00.000Z", quiet_days: 45, changed_at: AT,
        acting_principal: { kind: "platform", id: "dormancy-scheduler" },
      };
      await f.append("problem.dormant", "problem", "P-DEMO", receipt);
      f.sql.exec("UPDATE events SET actor_fellow_id=NULL,actor_sponsor_id=NULL,actor_session_id=NULL");
      f.sql.exec("UPDATE problems SET status='dormant'");
      const result = await f.read();
      expect(result.records[0].content).toEqual(receipt);
      expect(result.records[0].content_omitted).toBeNull();
      expect(result.records[0].publication.actor.fellow_id).toBeNull();
      expect(result.body).not.toContain(PRIVATE);
    } finally { f.sql.close(); }
  });

  for (const change of [
    { problem_id: "P-OTHER" },
    { observed_through: 1 },
    { changed_at: "2026-10-28T00:00:00.000Z" },
    { quiet_since: "2026-10-26T00:00:00.000Z" },
    { acting_principal: { kind: "platform", id: "another-scheduler" } },
    { private_note: PRIVATE },
  ]) {
    test(`inconsistent dormancy receipt is withheld: ${Object.keys(change)[0]}`, async () => {
      const f = fixture();
      try {
        await f.append("problem.dormant", "problem", "P-DEMO", {
          problem_id: "P-DEMO", previous_status: "active", status: "dormant",
          observed_through: 0, last_material_event_id: null,
          quiet_since: "2026-09-12T00:00:00.000Z", quiet_days: 45, changed_at: AT,
          acting_principal: { kind: "platform", id: "dormancy-scheduler" }, ...change,
        });
        f.sql.exec("UPDATE events SET actor_fellow_id=NULL,actor_sponsor_id=NULL,actor_session_id=NULL");
        const result = await f.read();
        expect(result.records[0].content).toBeNull();
        expect(result.records[0].content_omitted).toBe("content_unavailable");
        expect(result.body).not.toContain(PRIVATE);
      } finally { f.sql.close(); }
    });
  }

  test("a Fellow-attributed event cannot impersonate an automated dormancy receipt", async () => {
    const f = fixture();
    try {
      await f.append("problem.dormant", "problem", "P-DEMO", {
        problem_id: "P-DEMO", previous_status: "active", status: "dormant",
        observed_through: 0, last_material_event_id: null,
        quiet_since: "2026-09-12T00:00:00.000Z", quiet_days: 45, changed_at: AT,
        acting_principal: { kind: "platform", id: "dormancy-scheduler" },
      });
      const result = await f.read();
      expect(result.records[0].content).toBeNull();
      expect(result.records[0].content_omitted).toBe("content_unavailable");
    } finally { f.sql.close(); }
  });

  test("hypothesis lifecycle receipts survive the public event and full-pack allowlists", async () => {
    const f = fixture();
    try {
      await f.append("hypothesis.created","hypothesis","H-1",hypothesis);
      const transitions = [
        ["deferred","defer"], ["resumed","resume"],
        ["narrowed","narrow"], ["superseded","supersede"],
      ] as const;
      for (const [index,[event,action]] of transitions.entries()) {
        const target = `H-${index+2}`;
        await f.append(`hypothesis.${event}`,"hypothesis",target,{
          hypothesis_id:target,action,expected_last_event_id:`EVENT-PRIOR-${index}`,
          reason:"A public coordination decision with immutable scientific content",
          ...(action === "narrow" || action === "supersede" ? {successor_hypothesis_id:"H-9"} : {}),
        });
      }
      const result = await f.read();
      expect(result.records).toHaveLength(5);
      expect(result.records.map(record=>record.content_omitted)).toEqual([null,null,null,null,null]);
      expect(result.records.slice(1).map(record=>record.content.action)).toEqual(["defer","resume","narrow","supersede"]);
      expect(result.body).not.toContain(PRIVATE);
    } finally { f.sql.close(); }
  });

  test("a lifecycle event with a mismatched action never becomes a public work product", async () => {
    const f = fixture();
    try {
      await f.append("hypothesis.resumed","hypothesis","H-1",{
        hypothesis_id:"H-1",action:"defer",expected_last_event_id:"EVENT-PRIOR",
        reason:"An inconsistent action cannot be silently reinterpreted",
      });
      const result = await f.read();
      expect(result.records[0].content).toBeNull();
      expect(result.records[0].content_omitted).toBe("content_unavailable");
    } finally { f.sql.close(); }
  });

  test("hydrates committed claim, hypothesis, evidence and review bodies without private bookkeeping", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Public original claim"));
      await f.append("hypothesis.created", "hypothesis", "H-1", hypothesis);
      await f.append("evidence.created", "evidence", "E-PUBLIC", evidence());
      await f.append("review.created", "review", "R-PUBLIC", review());
      await f.append(
        "claim.revised",
        "claim",
        "C-1",
        {
          ...claim("C-1", "Public revised claim"),
          base_version: 1,
          depends_on: [],
        },
        2,
      );
      const result = await f.read();
      expect(result.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(result.records.map((record) => record.content_omitted)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(result.records[0].content.statement).toBe("Public original claim");
      expect(result.records[4].content.statement).toBe("Public revised claim");
      expect(result.records[1].content.body_md).toBe(hypothesis.body_md);
      expect(result.records[2].content.body_md).toBe("Public evidence body");
      expect(result.records[3].content.body_md).toBe("Public review body");
      expect(result.body).not.toContain(PRIVATE);
      expect(
        f.queries.every(
          (query) => !/\b(workshop_objects|sessions|sponsor_directives)\b/.test(query),
        ),
      ).toBe(true);
      expect(result.control).toMatchObject({
        after: 0,
        through: 5,
        has_more: false,
        next_after: null,
        records: 5,
      });
      expect(result.face.omitted).not.toContainEqual({
        reason: "profile_section_not_composed",
        detail: "paginated-export",
      });
    } finally {
      f.sql.close();
    }
  });

  test.each([800, 1500, 2500, 4000, 8000])(
    "budget %i traverses every sequence once, including oversized and private records",
    async (budget) => {
      const f = fixture();
      try {
        await f.append(
          "evidence.created",
          "evidence",
          "E-BIG",
          evidence("Large public body. ".repeat(2000)),
        );
        await f.append(
          "claim.created",
          "claim",
          "C-1",
          claim("C-1", "A moderate claim. ".repeat(90)),
        );
        await f.append("workshop.updated", "workshop", PRIVATE, { body_md: PRIVATE });
        await f.append("problem.published", "problem", "P-DEMO", {
          body_md: "Unsupported problem lifecycle body",
        });
        await f.append("review.created", "review", "R-1", review());
        const sequences: number[] = [];
        let after = 0;
        for (let page = 0; page < 6; page++) {
          const result = await f.read({ after, through: 5, requestedMaxTokens: budget });
          if (after === 0 && (budget === 800 || budget === 1500))
            expect(
              (await f.read({ after, through: 5, requestedMaxTokens: budget === 800 ? 799 : 801 }))
                .body,
            ).toBe(result.body);
          expect(result.face.tokens_estimate).toBeLessThanOrEqual(budget);
          expect(result.records.length).toBeGreaterThan(0);
          expect(result.records[0].seq).toBe(after + 1);
          expect(result.body).not.toContain(PRIVATE);
          expect(result.body).not.toContain("Unsupported problem lifecycle body");
          for (const record of result.records) {
            sequences.push(record.seq);
            if (record.seq === 1) {
              expect(record.content).toBe(null);
              expect(record.content_omitted).toBe("item_size_limit");
              expect(record.content_url).toBe(null);
            }
            if (record.seq === 3) expect(record.content_omitted).toBe("undisclosed_event");
            if (record.seq === 4) expect(record.content_omitted).toBe("unsupported_record");
          }
          if (!result.control.has_more) break;
          expect(result.control.next_after).toBe(result.records.at(-1).seq);
          const continuation = result.face.next_actions.find((action) =>
            action.url.includes("profile=full"),
          );
          expect(continuation?.url).toContain(`through=5&after=${result.control.next_after}`);
          if (result.control.next_after === null)
            throw new Error("full pack omitted its next cursor");
          after = result.control.next_after;
        }
        expect(sequences).toEqual([1, 2, 3, 4, 5]);
      } finally {
        f.sql.close();
      }
    },
  );

  test("frozen pages replay after new publications while exact-version and event controls change their bytes", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Original historical content"));
      await f.append("evidence.created", "evidence", "E-1", evidence());
      const original = await f.read({ through: 2 });
      await f.append(
        "claim.revised",
        "claim",
        "C-1",
        {
          ...claim("C-1", "Later replacement content"),
          base_version: 1,
        },
        2,
      );
      expect((await f.read({ through: 2 })).body).toBe(original.body);
      for (const target of ["C-1@1", "#1", "E-1@1", "#2"]) {
        f.control(target, "hidden");
        const hidden = await f.read({ through: 2 });
        const index = target === "C-1@1" || target === "#1" ? 0 : 1;
        expect(hidden.body).not.toBe(original.body);
        expect(hidden.records[index].content).toBe(null);
        expect(hidden.records[index].content_omitted).toBe("content_unavailable");
        f.control(target, "visible");
        expect((await f.read({ through: 2 })).body).toBe(original.body);
      }
      f.sql.prepare("UPDATE event_content SET redacted_at=? WHERE event_id='EVENT-1'").run(AT);
      f.control("C-1@1", "visible");
      expect((await f.read({ through: 2 })).records[0].content).toBe(null);
    } finally {
      f.sql.close();
    }
  });

  test("committed dependency pins survive without fabricating empty request-default relationships", async () => {
    const f = fixture();
    try {
      const pins = [
        {
          claim_id: "C-1",
          version: 1,
          event_id: "EVENT-PREMISE",
          content_digest: `sha256:${"a".repeat(64)}`,
          payload_digest: "b".repeat(64),
        },
      ];
      await f.append("claim.created", "claim", "C-2", {
        ...claim("C-2", "The dependent claim uses the pinned premise."),
        dependency_pins: pins,
      });
      const result = await f.read();
      expect(result.records[0].content.dependency_pins).toEqual(pins);
      expect(result.records[0].content).not.toHaveProperty("depends_on");
      expect(result.records[0].content).not.toHaveProperty("relates_to");
    } finally {
      f.sql.close();
    }
  });

  test("citation versions retain anchors and corrections, and dead ends retain their failure and retry condition", async () => {
    const f = fixture();
    try {
      const citation = {
        citation_id: "L-1",
        title: "A source for the parity argument",
        authors: ["Example Author"],
        year: 2020,
        locator_kind: "url",
        locator: "https://example.org/parity#lemma-2",
        excerpt: "A bounded public excerpt.",
        retrieved_at: AT,
        source_provenance: "retrieved",
        private_note: PRIVATE,
      };
      await f.append("citation.recorded", "citation", "L-1", citation);
      await f.append(
        "citation.corrected",
        "citation",
        "L-1",
        {
          ...citation,
          base_version: 1,
          title: "Corrected source title",
          correction_rationale: "The original title omitted its subtitle.",
        },
        2,
      );
      await f.append("dead_end.recorded", "dead_end", "DE-1", {
        approach: "Enumerated both residue classes directly.",
        why_it_fails: "This route does not extend to the proposed larger modulus.",
        retry_predicate: "Retry after the problem statement changes.",
        retry_when: { kind: "statement-revised" },
        what_was_examined: "The two residues modulo two.",
      });
      const result = await f.read();
      expect(result.records.map((record) => record.content_omitted)).toEqual([null, null, null]);
      expect(result.records[0].content.locator).toBe(citation.locator);
      expect(result.records[1].content.correction_rationale).toBe(
        "The original title omitted its subtitle.",
      );
      expect(result.records[1].content_url).toBe("/p/P-DEMO/citations/L-1@2.json?through=3");
      expect(result.records[2].content.retry_when).toEqual({ kind: "statement-revised" });
      expect(result.body).not.toContain(PRIVATE);
    } finally {
      f.sql.close();
    }
  });

  test("digest corruption, invalid nested fields and oversized source bytes remain explicit unavailable records", async () => {
    const f = fixture();
    try {
      await f.append("claim.created", "claim", "C-1", claim("C-1", "Original commitment"));
      f.sql
        .prepare("UPDATE event_content SET payload_json=? WHERE event_id='EVENT-1'")
        .run(JSON.stringify(claim("C-1", "CORRUPTED-CONTENT-CANARY")));
      await f.append("evidence.created", "evidence", "E-2", {
        ...evidence(),
        source: { kind: "model_memory", private_credential: PRIVATE },
      });
      await f.append("review.created", "review", "R-3", review("Δ".repeat(40_000)));
      const result = await f.read();
      expect(result.records.map((record) => record.content_omitted)).toEqual([
        "content_unavailable",
        "content_unavailable",
        "source_byte_limit",
      ]);
      expect(result.body).not.toContain("CORRUPTED-CONTENT-CANARY");
      expect(result.body).not.toContain(PRIVATE);
      expect(result.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    } finally {
      f.sql.close();
    }
  });

  for (const publication of settlementPublications) {
    test(`${publication.type} ${publication.id} retains committed scientific fields, exact identity and current controls`, async () => {
      const f = fixture();
      try {
        await f.append("claim.created", "claim", "C-1", claim("C-1", "The original public claim."));
        await f.append(
          publication.type,
          publication.kind,
          publication.id,
          { ...publication.payload, private_context: PRIVATE, writer_credential_id: PRIVATE },
          publication.version ?? 1,
        );
        const original = await f.read({ after: 1 });
        expect(original.records).toHaveLength(1);
        expect(original.records[0].content_omitted).toBe(null);
        expect(original.records[0].content).toMatchObject(publication.expected);
        expect(original.body).not.toContain(PRIVATE);
        expect(original.records[0].content).not.toHaveProperty("ttl_seconds");
        expect(original.records[0].content).not.toHaveProperty("source_claim_id");
        if (publication.type === "gap.withdrawn")
          expect(original.records[0].content).not.toHaveProperty("closed_by");
        for (const target of [`${publication.id}@${publication.version ?? 1}`, "#2"]) {
          f.control(target, "hidden");
          const hidden = await f.read({ after: 1, through: 2 });
          expect(hidden.records[0].content).toBe(null);
          expect(hidden.records[0].content_omitted).toBe("content_unavailable");
          f.control(target, "visible");
          expect((await f.read({ after: 1, through: 2 })).body).toBe(original.body);
        }
      } finally {
        f.sql.close();
      }
    });
  }

  test("scientific history refuses hash-valid mismatched identities, versions and future pins", async () => {
    const cases: {
      type: string;
      change: Record<string, unknown>;
      version?: number;
      id?: string;
    }[] = [
      { type: "claim.reanchored", change: { base_version: 2 } },
      { type: "question.asked", change: { question_id: "Q-OTHER" } },
      { type: "question.asked", change: { problem_id: "P-OTHER" } },
      { type: "question.leased", change: { leased_by: "F-OTHER" } },
      { type: "question.leased", change: { leased_until: "not-a-timestamp" } },
      { type: "question.answered", change: { question_id: "Q-OTHER" } },
      { type: "question.withdrawn", change: { question_id: "Q-OTHER" } },
      { type: "gap.filed", change: {}, id: "G-99" },
      { type: "gap.closed-by", change: { outcome: "withdrawn" } },
      { type: "gap.withdrawn", change: { closed_by: "C-1@1" } },
      { type: "relation.asserted", change: { target: "C-2@4" } },
      { type: "relation.asserted", change: { kind: "addresses-gap", target: "C-2@3" } },
      { type: "relation.disputed", change: { disputed_by: "F-OTHER" } },
      { type: "conflict.normalized", change: { problem_id: "P-OTHER" } },
      { type: "conflict.normalized", change: { author_fellow_id: "F-OTHER" } },
      { type: "conflict.resolved", change: {}, version: 1 },
      { type: "conflict.resolved", change: { conflict_id: "CF-OTHER" } },
      { type: "object.retracted", change: { retraction_id: "R-OTHER" } },
      { type: "object.retracted", change: { retraction_kind: "verified" } },
      { type: "object.retracted", change: { problem_id: "P-OTHER" } },
      {
        type: "object.retracted",
        change: { ...scientificWithdrawal, claim_id: "C-1", claim_version: 0 },
      },
      {
        type: "object.retracted",
        change: { ...scientificWithdrawal, hypothesis_id: "H-1", target_digest: "sha256:bad" },
      },
      {
        type: "object.retracted",
        change: { ...scientificWithdrawal, hypothesis_id: "H-1", target_kind: "review" },
      },
      {
        type: "object.retracted",
        change: { ...scientificWithdrawal, hypothesis_id: "H-1", claim_id: "C-1" },
      },
      { type: "object.retracted", change: { target_event_id: "E-SOURCE-PUBLICATION" } },
      { type: "synthesis.created", change: { problem_id: "P-OTHER" } },
      { type: "synthesis.created", change: { covers_through: 2 } },
      {
        type: "synthesis.created",
        change: { anchors: [{ target_kind: "claim", target_id: "C-1", target_seq: 2 }] },
      },
      {
        type: "synthesis.created",
        change: { anchors: [{ target_kind: "claim", target_id: "C-1", private_context: PRIVATE }] },
      },
    ];
    for (const row of cases) {
      const publication = settlementPublications.find((item) => item.type === row.type);
      if (publication === undefined) throw new Error("missing scientific history fixture");
      const f = fixture();
      try {
        await f.append("claim.created", "claim", "C-1", claim("C-1", "The original public claim."));
        await f.append(
          publication.type,
          publication.kind,
          row.id ?? publication.id,
          { ...publication.payload, ...row.change },
          row.version ?? publication.version ?? 1,
        );
        const result = await f.read({ after: 1 });
        expect(result.records[0].content_omitted).toBe("content_unavailable");
        expect(result.records[0].content).toBe(null);
        expect(result.body).not.toContain(PRIVATE);
      } finally {
        f.sql.close();
      }
    }
  });

  test("an empty cut is complete, but a missing public sequence cannot mint a successful continuation", async () => {
    const f = fixture();
    try {
      expect((await f.read()).control).toMatchObject({
        records: 0,
        next_after: null,
        has_more: false,
      });
      await f.append("claim.created", "claim", "C-1", claim("C-1", "First public claim"));
      await f.append("review.created", "review", "R-2", review());
      f.sql.prepare("DELETE FROM events WHERE seq=1").run();
      await expect(f.read()).rejects.toThrow("EVENT_TAIL_UNAVAILABLE");
    } finally {
      f.sql.close();
    }
  });

  test("continuation contracts reject unpinned, backwards and unsafe cursors", () => {
    expect(FullPackQuerySchema.safeParse({ profile: "full" }).success).toBe(true);
    expect(FullPackQuerySchema.safeParse({ profile: "full", after: 2, through: 9 }).success).toBe(
      true,
    );
    for (const value of [
      { profile: "full", after: 1 },
      { profile: "full", after: 3, through: 2 },
      { profile: "working", after: 0, through: 2 },
      { profile: "full", through: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(FullPackQuerySchema.safeParse(value).success).toBe(false);
    expect(
      FullPackPageSchema.safeParse({
        control: "full_pack_page",
        after: 1,
        through: 3,
        next_after: 3,
        has_more: false,
        records: 1,
      }).success,
    ).toBe(false);
    expect(
      FullPackPageSchema.safeParse({
        control: "full_pack_page",
        after: 1,
        through: 3,
        next_after: 1,
        has_more: true,
        records: 0,
      }).success,
    ).toBe(false);
  });
});
