import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProblemFaceResponseSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "../../src/ledger/citation-read-integrity.ts";
import { readPublishedProblemResolution } from "../../src/ledger/problem-resolution-read.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import { readFullPack } from "../../src/sessions/full-pack.ts";

const AT = "2026-10-27T00:00:00.000Z";
const PROBLEM = "P-RESOLUTION";
const SUMMARY = "The exact finite result is independently supported within its stated scope.";
const boundary = {
  verified: ["The finite statement at the cited version."],
  mechanisms: ["Independent argument review."],
  independence_tiers: ["T2"],
  remaining_external_validation: ["No external expert certification is asserted."],
};
const declaration = {
  result_claim: { claim_id: "C-1", version: 1 },
  direction: "affirmed",
  no_claim_boundary: boundary,
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Production SQL and decoders run against SQLite. This fixture is not a
// real-binding or scientific admission proof; it tests immutable read authority.
function fixture(synthesisChange: Record<string, unknown> = {}) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT,
      unlisted INTEGER DEFAULT 0, current_statement_version INTEGER DEFAULT 1,
      resolution_direction TEXT, resolution_summary TEXT, resolution_no_claim_boundary TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,payload_sha256 TEXT,created_at TEXT,
      actor_fellow_id TEXT,actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT,
      UNIQUE(problem_id,seq));
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    INSERT INTO problems(id,public_seq,status,resolution_direction,resolution_summary,resolution_no_claim_boundary)
      VALUES ('P-RESOLUTION',0,'resolved','refuted-as-stated','FORGED-PROJECTION','{}');
  `);
  const queries: string[] = [];
  let queryHook: ((query: string) => void) | undefined;
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async all() {
              queries.push(query);
              queryHook?.(query);
              return { results: sql.query(query).all(...values), success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  let seq = 0;
  function append(
    type: string,
    kind: string,
    id: string,
    payload: object,
    change: Record<string, unknown> = {},
  ) {
    seq += 1;
    const event = {
      id: `E-${seq}`,
      kind,
      objectId: id,
      version: 1,
      fellow: type === "problem.resolved" ? null : "F-AUTHOR",
      sponsor: "usr_sponsor",
      session: type === "problem.resolved" ? null : "S-SESSION",
      createdAt: AT,
      ...change,
    };
    const body = JSON.stringify(payload);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event.id,
        PROBLEM,
        seq,
        type,
        event.kind as string,
        event.objectId as string,
        event.version as number,
        digest(body),
        event.createdAt as string,
        event.fellow as string | null,
        event.sponsor as string,
        event.session as string | null,
        "declared-model",
        "declared-harness",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(event.id, digest(body), body);
    sql.query("UPDATE problems SET public_seq=? WHERE id=?").run(seq, PROBLEM);
    return { eventId: event.id, seq, payloadDigest: digest(body), body };
  }
  const claim = append("claim.created", "claim", "C-1", {
    claim_id: "C-1",
    kind: "conjecture",
    statement: "The finite statement.",
    falsifier: "An integer counterexample within the declared range.",
  });
  const synthesis = append("synthesis.created", "synthesis", "SYNTH-CLOSE", {
    covers_through: 1,
    body_md: SUMMARY,
    anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1, target_seq: 1 }],
    omitted: ["External certification is outside this work product."],
    selection_policy: "Retain the exact result and disclose its limits.",
    dropped_single_author_count: 0,
    closing_resolution: declaration,
    ...synthesisChange,
  });
  const resultClaim = {
    claim_id: "C-1",
    version: 1,
    content_digest: `sha256:${"a".repeat(64)}`,
    event_id: claim.eventId,
    payload_digest: claim.payloadDigest,
  };
  const closing = {
    synthesis_id: "SYNTH-CLOSE",
    event_id: synthesis.eventId,
    seq: synthesis.seq,
    payload_digest: synthesis.payloadDigest,
    covers_through: 1,
  };
  const problem = {
    id: PROBLEM,
    title: "Finite result",
    status: "resolved",
    current_statement_version: 1,
    statement: "Every element in the stated finite set has the declared property.",
    falsifier: "An element in the set lacking that property.",
    motivation: "Establish the finite boundary without claiming more.",
    updated_at: AT,
    result_claim: resultClaim,
    resolution_direction: "affirmed",
    resolution_summary: SUMMARY,
    resolution_no_claim_boundary: boundary,
    closing_synthesis: closing,
  };
  function resolve(
    problemChange: Record<string, unknown> = {},
    envelopeChange: Record<string, unknown> = {},
    payloadChange: Record<string, unknown> = {},
  ) {
    return append(
      "problem.resolved",
      "problem",
      PROBLEM,
      {
        action: "resolve",
        acting_principal: { type: "sponsor", id: "usr_sponsor" },
        source_fellow_id: "F-AUTHOR",
        previous_status: "under-result-review",
        previous_statement_version: 1,
        problem: { ...problem, ...problemChange },
        ...payloadChange,
      },
      envelopeChange,
    );
  }
  function control(target: string, visibility: "hidden" | "visible", scope = PROBLEM) {
    sql
      .query(`INSERT INTO content_controls SELECT ?,?,COALESCE(MAX(version),0)+1,?
      FROM content_controls WHERE problem_id=? AND target_ref=?`)
      .run(scope, target, visibility, scope, target);
  }
  const expected = {
    direction: "affirmed" as const,
    summary: SUMMARY,
    no_claim_boundary: boundary,
    result_claim: resultClaim,
    closing_synthesis: closing,
  };
  return {
    sql,
    db,
    queries,
    claim,
    synthesis,
    resultClaim,
    closing,
    resolve,
    control,
    expected,
    onQuery: (hook: (query: string) => void) => {
      queryHook = hook;
    },
    read: (through = seq) => readPublishedProblemResolution(db, PROBLEM, through),
  };
}

describe("immutable published problem resolution", () => {
  test("returns the canonical resolution and both source pins without trusting mutable columns", async () => {
    const f = fixture();
    try {
      expect(await f.read()).toBeUndefined();
      f.resolve();
      expect(await f.read()).toEqual(f.expected);
      expect(JSON.stringify(await f.read())).not.toContain("FORGED-PROJECTION");
      f.sql.exec(
        "UPDATE problems SET resolution_summary='ANOTHER-FORGED-VALUE', resolution_no_claim_boundary=NULL",
      );
      expect(await f.read()).toEqual(f.expected);
      expect(await f.read(2)).toBeUndefined();
      expect(await f.read(4)).toBeUndefined();
    } finally {
      f.sql.close();
    }
  });

  for (const target of [
    "problem",
    PROBLEM,
    `${PROBLEM}@1`,
    "#3",
    "SYNTH-CLOSE",
    "SYNTH-CLOSE@1",
    "#2",
  ]) {
    test(`current ${target} controls override the historical resolution and restore exactly`, async () => {
      const f = fixture();
      try {
        f.resolve();
        const original = await f.read(3);
        f.control(target, "hidden");
        expect(await f.read(3)).toBeUndefined();
        f.control(target, "visible");
        expect(await f.read(3)).toEqual(original);
      } finally {
        f.sql.close();
      }
    });
  }

  test("unrelated version and problem controls cannot suppress the exact publications", async () => {
    const f = fixture();
    try {
      f.resolve();
      f.control("SYNTH-CLOSE@2", "hidden");
      f.control("#3", "hidden", "P-OTHER");
      expect(await f.read()).toEqual(f.expected);
      f.sql.exec("UPDATE problems SET status='private-draft'");
      expect(await f.read()).toBeUndefined();
    } finally {
      f.sql.close();
    }
  });

  for (const eventId of ["E-2", "E-3"]) {
    for (const mutation of [
      "redacted_at='2026-10-27T01:00:00.000Z'",
      "payload_sha256='detached'",
      "payload_json=replace(payload_json,'finite','fabricated')",
    ]) {
      test(`${eventId} ${mutation} withholds resolution instead of trusting retained prose`, async () => {
        const f = fixture();
        try {
          f.resolve();
          f.sql.exec(`UPDATE event_content SET ${mutation} WHERE event_id='${eventId}'`);
          expect(await f.read()).toBeUndefined();
        } finally {
          f.sql.close();
        }
      });
    }
  }

  test("an unavailable latest resolution never falls back to an older valid resolution", async () => {
    const f = fixture();
    try {
      f.resolve();
      f.resolve();
      f.control("#4", "hidden");
      expect(await f.read(4)).toBeUndefined();
      expect(await f.read(3)).toEqual(f.expected);
      f.control("#4", "visible");
      f.sql.exec("UPDATE events SET object_kind='claim' WHERE seq=4");
      expect(await f.read(4)).toBeUndefined();
    } finally {
      f.sql.close();
    }
  });

  test("final source snapshot rejects resolution hides and redactions during closing-work hydration", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => f.control("#3", "hidden"),
      (f: ReturnType<typeof fixture>) =>
        f.sql.exec("UPDATE event_content SET redacted_at='now' WHERE event_id='E-3'"),
    ]) {
      const f = fixture();
      try {
        f.resolve();
        let raced = false;
        f.onQuery((query) => {
          if (!raced && query.includes("WITH scope AS")) {
            raced = true;
            mutate(f);
          }
        });
        expect(await f.read()).toBeUndefined();
        expect(raced).toBe(true);
      } finally {
        f.sql.close();
      }
    }
  });

  test("final source snapshot rejects closing-work bytes changed after their digest was verified", async () => {
    const f = fixture();
    try {
      f.resolve();
      let raced = false;
      f.onQuery((query) => {
        if (!raced && query.includes("SELECT 1 AS available FROM problems")) {
          raced = true;
          f.sql.exec(
            "UPDATE event_content SET payload_json=replace(payload_json,'finite','fabricated') WHERE event_id='E-2'",
          );
        }
      });
      expect(await f.read()).toBeUndefined();
      expect(raced).toBe(true);
    } finally {
      f.sql.close();
    }
  });

  for (const change of [
    { summary: "A different scientific conclusion." },
    { result: { claim_id: "C-2", version: 1 } },
    { result: { claim_id: "C-1", version: 2 } },
    { direction: "refuted-as-stated" },
    { boundary: { ...boundary, verified: ["An unrecorded assertion."] } },
    { synthesis: { event_id: "E-OTHER" } },
    { synthesis: { payload_digest: "b".repeat(64) } },
    { synthesis: { seq: 3 } },
    { synthesis: { covers_through: 0 } },
    { synthesis: { synthesis_id: "SYNTH-MISSING" } },
  ]) {
    test(`hash-valid resolution must agree with the exact closing work: ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      try {
        f.resolve({
          ...(change.summary === undefined ? {} : { resolution_summary: change.summary }),
          ...(change.result === undefined
            ? {}
            : { result_claim: { ...f.resultClaim, ...change.result } }),
          ...(change.direction === undefined ? {} : { resolution_direction: change.direction }),
          ...(change.boundary === undefined
            ? {}
            : { resolution_no_claim_boundary: change.boundary }),
          ...(change.synthesis === undefined
            ? {}
            : { closing_synthesis: { ...f.closing, ...change.synthesis } }),
        });
        expect(await f.read()).toBeUndefined();
      } finally {
        f.sql.close();
      }
    });
  }

  for (const change of [
    { closing_resolution: undefined },
    { closing_resolution: { ...declaration, direction: "refuted-as-stated" } },
    { closing_resolution: { ...declaration, private_context: "PRIVATE-CANARY" } },
    { anchors: [{ target_kind: "claim", target_id: "C-2", target_version: 1, target_seq: 1 }] },
    { anchors: [{ target_kind: "claim", target_id: "C-1", target_version: 1 }] },
  ]) {
    test(`the referenced synthesis must contain its matching declared result: ${JSON.stringify(change)}`, async () => {
      const f = fixture(change);
      try {
        f.resolve();
        expect(await f.read()).toBeUndefined();
      } finally {
        f.sql.close();
      }
    });
  }

  test("malformed latest identity, attribution and source scope never become public resolution", async () => {
    for (const envelope of [
      { objectId: "P-OTHER" },
      { version: 2 },
      { sponsor: "usr_other" },
      { fellow: "F-IMPERSONATOR" },
      { session: "S-IMPERSONATOR" },
      { createdAt: "2026-10-27T00:01:00.000Z" },
    ]) {
      const f = fixture();
      try {
        f.resolve({}, envelope);
        expect(await f.read()).toBeUndefined();
      } finally {
        f.sql.close();
      }
    }
    const f = fixture();
    try {
      f.resolve({ id: "P-OTHER" });
      expect(await f.read()).toBeUndefined();
    } finally {
      f.sql.close();
    }
  });

  test("oversized and malformed latest records cannot bypass canonical decoding", async () => {
    for (const change of [
      { action: "retire" },
      { previous_status: "active" },
      { source_fellow_id: "F-IMPERSONATOR" },
      { private_context: "x".repeat(PUBLIC_EVENT_CONTENT_MAX_BYTES + 1) },
    ]) {
      const f = fixture();
      try {
        f.resolve({}, {}, change);
        expect(await f.read()).toBeUndefined();
      } finally {
        f.sql.close();
      }
    }
  });

  test("full packs retain admitted resolution fields while withholding hidden copied closing work", async () => {
    const f = fixture();
    try {
      f.resolve();
      const read = async () => {
        const pack = await readFullPack(f.db, {
          session: `S-${"0".repeat(26)}`,
          problem: PROBLEM,
          after: 2,
          through: 3,
          requestedMaxTokens: 8000,
          membership: "contributor",
        });
        return JSON.parse(pack.items.find((item) => item.kind === "full-event")?.body ?? "null");
      };
      const original = await read();
      expect(original.content_omitted).toBeNull();
      expect(original.content).toEqual(f.expected);
      expect(JSON.stringify(original)).not.toContain("Every element in the stated finite set");
      f.control("SYNTH-CLOSE@1", "hidden");
      const hidden = await read();
      expect(hidden.publication.type).toBe("problem.resolved");
      expect(hidden.content).toBeNull();
      expect(hidden.content_omitted).toBe("content_unavailable");
      expect(JSON.stringify(hidden)).not.toContain(SUMMARY);
      f.control("SYNTH-CLOSE@1", "visible");
      expect(await read()).toEqual(original);
    } finally {
      f.sql.close();
    }
  });
});

function digestRoutes(f: ReturnType<typeof fixture>) {
  f.sql.exec(`
    CREATE TABLE claims(problem_id TEXT,id TEXT,statement TEXT,source_seq INTEGER,payload_sha256 TEXT);
    CREATE TABLE claim_versions(problem_id TEXT,claim_id TEXT,version INTEGER,content_digest TEXT);
    CREATE TABLE projection_health(problem_id TEXT,status TEXT,source_cursor INTEGER);
    CREATE TABLE problem_statement_reviews(problem_id TEXT,version INTEGER,reviewer_fellow_id TEXT,
      verdict TEXT,basis TEXT,created_at TEXT);
  `);
  const app = createLedgerFaceRoutes();
  return (suffix: string, etag?: string) =>
    app.request(
      `https://a.asimposium.org/p/${PROBLEM}${suffix === "full.md" ? "/full.md" : `.${suffix}`}`,
      {
        headers: {
          "User-Agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      },
      { DB: f.db } as unknown as Env,
    );
}

test("primary digest and full Markdown expose only verified resolution and existing exact source links", async () => {
  const f = fixture();
  try {
    f.resolve();
    const get = digestRoutes(f);
    const initial = await get("json");
    expect(initial.status).toBe(200);
    const face = ProblemFaceResponseSchema.parse(await initial.json());
    const item = face.items.find((entry) => entry.kind === "problem-resolution");
    expect(item?.untrusted).toBe(true);
    expect(JSON.parse(item?.body ?? "null")).toEqual(f.expected);
    expect(face.next_actions).toContainEqual(
      expect.objectContaining({
        url: `/p/${PROBLEM}/syntheses/SYNTH-CLOSE.md`,
      }),
    );
    for (const suffix of ["md", "full.md"]) {
      const response = await get(suffix);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(SUMMARY);
      expect(body).toContain("remaining_external_validation");
      expect(body).not.toContain("FORGED-PROJECTION");
    }
    const etag = initial.headers.get("etag");
    expect(etag).toBeTruthy();
    f.control("#2", "hidden");
    const hidden = await get("json", etag ?? undefined);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("etag")).not.toBe(etag);
    const unavailable = ProblemFaceResponseSchema.parse(await hidden.json());
    expect(unavailable.items.some((entry) => entry.kind === "problem-resolution")).toBe(false);
    expect(unavailable.omitted).toContainEqual(
      expect.objectContaining({ reason: "resolution_unavailable" }),
    );
    expect(JSON.stringify(unavailable)).not.toContain(SUMMARY);
  } finally {
    f.sql.close();
  }
});

test("an oversized resolution is an explicit digest omission with full closing-work links", async () => {
  const expanded = {
    ...boundary,
    verified: Array.from({ length: 45 }, (_, index) => `${index}:${"x".repeat(450)}`),
  };
  const f = fixture({ closing_resolution: { ...declaration, no_claim_boundary: expanded } });
  try {
    f.resolve({ resolution_no_claim_boundary: expanded });
    const response = await digestRoutes(f)("json");
    expect(response.status).toBe(200);
    const face = ProblemFaceResponseSchema.parse(await response.json());
    expect(face.items.some((entry) => entry.kind === "problem-resolution")).toBe(false);
    expect(face.omitted).toContainEqual(
      expect.objectContaining({ reason: "resolution_body_limit" }),
    );
    expect(
      face.next_actions.some((action) =>
        action.url === `/p/${PROBLEM}/syntheses/SYNTH-CLOSE.md`,
      ),
    ).toBe(true);
  } finally {
    f.sql.close();
  }
});
