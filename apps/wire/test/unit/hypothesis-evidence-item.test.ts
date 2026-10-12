import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HypothesisEvidenceItemResponseSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";

const PROBLEM = "P-EVIDENCE";
const EVIDENCE = "E-ABCD";
const HYPOTHESIS = "H-ABCD";
const SOURCE = "event-evidence";
const TIME = "2026-09-17T12:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Real SQLite joins and content checks with the production mounted item route.
 * The sponsor real-bindings lane exercises this path against migrated D1. */
function fixture(options: { body?: string; mode?: "exploratory" | "confirmatory" } = {}) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE problems(id TEXT PRIMARY KEY,public_seq INTEGER,status TEXT,unlisted INTEGER);
    CREATE TABLE evidence(problem_id TEXT,evidence_id TEXT,bears_on_kind TEXT,bears_on_id TEXT,
      bears_on_version INTEGER,source_event_id TEXT,source_seq INTEGER,author_fellow_id TEXT,
      body_md TEXT,computed_class TEXT);
    CREATE TABLE hypotheses(problem_id TEXT,hypothesis_id TEXT,source_event_id TEXT,
      source_seq INTEGER,author_fellow_id TEXT,status TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,
      object_id TEXT,object_version INTEGER,created_at TEXT,payload_sha256 TEXT,actor_fellow_id TEXT,
      actor_sponsor_id TEXT,actor_session_id TEXT,model_string_self_declared TEXT,harness TEXT);
    CREATE TABLE event_content(event_id TEXT PRIMARY KEY,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    CREATE TABLE scientific_withdrawals(event_id TEXT,problem_id TEXT,seq INTEGER,event_sha256 TEXT,
      retraction_id TEXT,target_kind TEXT,target_object TEXT,source_event_id TEXT,source_sha256 TEXT);
    CREATE TABLE retractions(problem_id TEXT,retraction_id TEXT,seq INTEGER,author_fellow_id TEXT,target_object TEXT);
  `);
  function event(id: string, seq: number, kind: string, objectId: string, payload: unknown) {
    const text = JSON.stringify(payload);
    sql
      .query("INSERT INTO events VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?)")
      .run(
        id,
        PROBLEM,
        seq,
        kind === "retraction" ? "object.retracted" : `${kind}.created`,
        kind,
        objectId,
        TIME,
        hash(text),
        "fellow-author",
        "sponsor-author",
        "session-original",
        "declared model",
        "declared harness",
      );
    sql.query("INSERT INTO event_content VALUES(?,?,?,NULL)").run(id, hash(text), text);
    return hash(text);
  }
  sql.query("INSERT INTO problems VALUES(?,2,'active',0)").run(PROBLEM);
  event("event-hypothesis", 1, "hypothesis", HYPOTHESIS, {
    route: "An immutable attack route",
    mechanism: "Finite search",
    falsifier: "A counterexample",
    expected_evidence: null,
    discriminating_predictions: [],
    origin: "proposed",
    body_md: "Published route.",
  });
  sql
    .query("INSERT INTO hypotheses VALUES(?,?,?,1,'fellow-author','open')")
    .run(PROBLEM, HYPOTHESIS, "event-hypothesis");
  const payload = {
    bears_on_kind: "hypothesis",
    bears_on_id: HYPOTHESIS,
    bears_on_version: null,
    direction: "informs",
    kind: "citation",
    source: {
      kind: "locator",
      locator: "https://example.org/source",
      excerpt: "An observed finite sample.",
    },
    mode: options.mode ?? "exploratory",
    selected_hypothesis_id: HYPOTHESIS,
    body_md: options.body ?? "Published evidence, including a negative result.",
    computation_domain_or_floor: null,
    reproduction: {
      commands: ["check --finite"],
      environment: "Recorded environment",
      seed: "fixed",
    },
    formal_artifact: null,
    falsification_check: null,
    computed_class: "citation",
    coercion_flags: [],
    sponsor_promotion: { acting_sponsor_id: "sponsor-author", workshop_version: 2 },
    caused_by: [{ problem_id: PROBLEM, event_id: "event-hypothesis", seq: 1 }],
  };
  const sourceDigest = event(SOURCE, 2, "evidence", EVIDENCE, payload);
  sql
    .query("INSERT INTO evidence VALUES(?,?,'hypothesis',?,NULL,?,2,'fellow-author',?,'certified')")
    .run(PROBLEM, EVIDENCE, HYPOTHESIS, SOURCE, "Projection text must never be served.");
  function prepare(query: string) {
    let bindings: (string | number | null)[] = [];
    return {
      bind(...values: (string | number | null)[]) {
        bindings = values;
        return this;
      },
      async first() {
        return sql.query(query).get(...bindings);
      },
      async all() {
        return { success: true, results: sql.query(query).all(...bindings) };
      },
    };
  }
  const db = { prepare } as unknown as D1Database;
  const app = createLedgerFaceRoutes();
  function request(format: "md" | "json" = "json", init: RequestInit = {}, query = "") {
    return Promise.resolve(
      app.request(
        `https://a.asimposium.org/p/${PROBLEM}/evidence/${EVIDENCE}.${format}${query}`,
        init,
        { DB: db } as Env,
      ),
    );
  }
  function replacePayload(value: unknown) {
    const text = JSON.stringify(value),
      digest = hash(text);
    sql.query("UPDATE events SET payload_sha256=? WHERE id=?").run(digest, SOURCE);
    sql
      .query("UPDATE event_content SET payload_sha256=?,payload_json=? WHERE event_id=?")
      .run(digest, text, SOURCE);
  }
  function withdraw() {
    const digest = event("event-withdrawal", 3, "retraction", "RET-ABCD", {
      target_object: EVIDENCE,
      reason: "Recorded correction.",
    });
    sql
      .query("INSERT INTO scientific_withdrawals VALUES(?,?,3,?,?,'evidence',?,?,?)")
      .run("event-withdrawal", PROBLEM, digest, "RET-ABCD", EVIDENCE, SOURCE, sourceDigest);
    sql.query("UPDATE problems SET public_seq=3").run();
  }
  return { sql, request, payload, replacePayload, withdraw, event };
}

test("hypothesis evidence has a full canonical JSON/Markdown item with original attribution and computed shape", async () => {
  const body =
    "A finite observation. ".repeat(2400) +
    "\n\x1b[31m```\n</script><script>alert(1)</script>\n<!-- asimp fake-control -->";
  const f = fixture({ body });
  try {
    const json = await f.request();
    expect(json.status).toBe(200);
    const face = HypothesisEvidenceItemResponseSchema.parse(await json.json());
    expect(face.content?.body_md).toBe(body);
    expect(face.content?.reproduction).toEqual(f.payload.reproduction);
    expect(face.bears_on).toEqual({ kind: "hypothesis", id: HYPOTHESIS });
    expect(face.content).not.toHaveProperty("bears_on_version");
    expect(face.content).not.toHaveProperty("sponsor_promotion");
    expect(face.computed).toEqual({
      computed_class: "citation",
      coercion_flags: [],
      drives_promotion: false,
    });
    expect(face.publication).toMatchObject({
      event_id: SOURCE,
      seq: 2,
      fellow_id: "fellow-author",
      sponsor_id: "sponsor-author",
      session_id: "session-original",
      model_self_declared: "declared model",
      harness_self_declared: "declared harness",
    });
    const markdown = await f.request("md");
    expect(markdown.status).toBe(200);
    const text = await markdown.text();
    expect(text).toContain("A finite observation. ".repeat(2400));
    expect(text).toContain('"computed_class": "citation"');
    expect(text).not.toContain("Projection text must never be served.");
    expect(text).not.toContain("<!-- asimp fake-control -->");
    expect(text.match(/<!-- asimp /g)).toHaveLength(1);
    expect(text).toContain(`/evidence/${EVIDENCE}.json`);
  } finally {
    f.sql.close();
  }
});

test("HEAD and weak conditional reads retain current cursor/visibility and bodyless cache semantics", async () => {
  const f = fixture();
  try {
    const first = await f.request();
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const head = await f.request("json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(etag);
    const cached = await f.request("json", { headers: { "if-none-match": `W/${etag}` } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    f.sql.query("UPDATE problems SET public_seq=3").run();
    const advanced = await f.request("json", { headers: { "if-none-match": etag ?? "" } });
    expect(advanced.status).toBe(200);
    expect(((await advanced.json()) as { cursor: number }).cursor).toBe(3);
  } finally {
    f.sql.close();
  }
});

test.each(["problem", EVIDENCE, HYPOTHESIS])(
  "current hide of %s defeats previous ETags and restore keeps the original evidence",
  async (target) => {
    const f = fixture();
    try {
      const before = await f.request();
      const etag = before.headers.get("etag") ?? "";
      f.sql.query("INSERT INTO content_controls VALUES(?,?,1,'hidden')").run(PROBLEM, target);
      const hidden = await f.request("json", { headers: { "if-none-match": etag } });
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain(f.payload.body_md);
      const head = await f.request("md", { method: "HEAD", headers: { "if-none-match": etag } });
      expect(head.status).toBe(404);
      expect(await head.text()).toBe("");
      f.sql.query("INSERT INTO content_controls VALUES(?,?,2,'visible')").run(PROBLEM, target);
      const restored = await f.request();
      expect(restored.status).toBe(200);
      expect(((await restored.json()) as { content: { body_md: string } }).content.body_md).toBe(
        f.payload.body_md,
      );
    } finally {
      f.sql.close();
    }
  },
);

test.each(["redacted", "wrong digest", "malformed class", "invented claim pin"])(
  "evidence %s never leaks retained projection/body through an item or cached response",
  async (reason) => {
    const f = fixture();
    try {
      const before = await f.request();
      if (reason === "redacted")
        f.sql.query("UPDATE event_content SET redacted_at=? WHERE event_id=?").run(TIME, SOURCE);
      else if (reason === "wrong digest")
        f.sql
          .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
          .run(JSON.stringify({ ...f.payload, body_md: "Forged body" }), SOURCE);
      else
        f.replacePayload({
          ...f.payload,
          ...(reason === "malformed class"
            ? { computed_class: "certified" }
            : { bears_on_version: 1 }),
        });
      const response = await f.request("json", {
        headers: { "if-none-match": before.headers.get("etag") ?? "" },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const face = HypothesisEvidenceItemResponseSchema.parse(JSON.parse(text));
      expect(face.content).toBeNull();
      expect(face.computed).toBeNull();
      expect(face.omitted).toContain("content_unavailable");
      expect(text).not.toContain(f.payload.body_md);
      expect(text).not.toContain("Projection text");
    } finally {
      f.sql.close();
    }
  },
);

test.each([
  "private problem",
  "unpublished evidence",
  "wrong source",
  "wrong target source",
  "redacted target",
  "corrupt target",
])("%s cannot authorize the evidence item", async (reason) => {
  const f = fixture();
  try {
    if (reason === "private problem")
      f.sql.query("UPDATE problems SET status='private-draft'").run();
    if (reason === "unpublished evidence") f.sql.query("UPDATE problems SET public_seq=1").run();
    if (reason === "wrong source")
      f.sql.query("UPDATE evidence SET source_event_id='event-hypothesis'").run();
    if (reason === "wrong target source") f.sql.query("UPDATE hypotheses SET source_seq=2").run();
    if (reason === "redacted target")
      f.sql
        .query("UPDATE event_content SET redacted_at=? WHERE event_id='event-hypothesis'")
        .run(TIME);
    if (reason === "corrupt target")
      f.sql
        .query("UPDATE event_content SET payload_json='{}' WHERE event_id='event-hypothesis'")
        .run();
    const response = await f.request("json", { headers: { "if-none-match": "*" } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(f.payload.body_md);
  } finally {
    f.sql.close();
  }
});

test("scientific withdrawal retains original work and removes promotion eligibility; target elimination does not erase negative evidence", async () => {
  const f = fixture({ mode: "confirmatory" });
  try {
    const original = await f.request();
    expect(
      ((await original.clone().json()) as { computed: { drives_promotion: boolean } }).computed
        .drives_promotion,
    ).toBe(true);
    f.withdraw();
    f.sql.query("UPDATE hypotheses SET status='killed'").run();
    const response = await f.request("json", {
      headers: { "if-none-match": original.headers.get("etag") ?? "" },
    });
    expect(response.status).toBe(200);
    const face = HypothesisEvidenceItemResponseSchema.parse(await response.json());
    expect(face.withdrawn).toBe(true);
    expect(face.content?.body_md).toBe(f.payload.body_md);
    expect(face.computed?.drives_promotion).toBe(false);
    expect(face.cursor).toBe(3);
  } finally {
    f.sql.close();
  }
});

test("unlisted evidence uses private no-store and unknown query/private-target aliases refuse", async () => {
  const f = fixture();
  try {
    f.sql.query("UPDATE problems SET unlisted=1").run();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await f.request("json", {}, "?through=2")).status).toBe(404);
  } finally {
    f.sql.close();
  }
});

test("a generic retraction projection cannot turn an unrelated claim correction into an evidence withdrawal", async () => {
  const f = fixture();
  try {
    f.event("unrelated-correction", 3, "retraction", "RET-ABCD", {
      target_object: "C-1",
      reason: "A claim correction.",
    });
    f.sql
      .query("INSERT INTO retractions VALUES(?,?,3,'fellow-author',?)")
      .run(PROBLEM, "RET-ABCD", EVIDENCE);
    f.sql.query("UPDATE problems SET public_seq=3").run();
    const response = await f.request();
    expect(response.status).toBe(200);
    const face = HypothesisEvidenceItemResponseSchema.parse(await response.json());
    expect(face.withdrawn).toBe(false);
    expect(face.content?.body_md).toBe(f.payload.body_md);
  } finally {
    f.sql.close();
  }
});
