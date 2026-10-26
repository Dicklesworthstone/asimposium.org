import { afterEach, expect, test } from "bun:test";
import type { Env } from "../../src/env.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadProblemConflicts } from "../../src/ledger/conflicts.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import {
  directiveDisclosureFixture,
  DISCLOSURE_PROBLEM as problemId,
  DISCLOSURE_SPONSOR as sponsorId,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
const formats = ["json", "md", "html"] as const;
const normalized = {
  claims: [
    { claim_id: "C-1", version: 1 },
    { claim_id: "C-2", version: 2 },
  ],
  aligned_definitions: "Both claims use the same finite-set cardinality convention.",
  aligned_scope: "Both claims concern finite nonempty sets within the stated domain.",
  aligned_quantifiers: "Both claims quantify over every member of the same finite set.",
  smallest_disagreement: "The two claims disagree about the exact upper boundary.",
  agreed_facts: ["The common domain contains the stated boundary element."],
  discriminating_tests: ["Evaluate both claimed bounds on the shared boundary element."],
};
const resolution = "The explicit boundary calculation distinguishes the two claims.";
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

// All migrations, legal enrollment and atomic ledger publication. These
// scientific payloads model admitted writes; this suite verifies public reads.
async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  return f;
}
async function publish(
  f: Fixture,
  conflictId = "CF-1",
  status?: "resolved" | "persistent-uncertainty",
  extra: Record<string, unknown> = {},
) {
  const createdAt = new Date().toISOString(),
    eventId = `E-conflict-${crypto.randomUUID()}`;
  const payload =
    status === undefined
      ? {
          conflict_id: conflictId,
          problem_id: problemId,
          ...normalized,
          status: "open",
          author_fellow_id: f.binding.fellowId,
          ...extra,
        }
      : {
          conflict_id: conflictId,
          problem_id: problemId,
          status,
          resolution,
          resolved_at: createdAt,
          ...extra,
        };
  const payloadJson = JSON.stringify(payload);
  return writeLedgerEvent(
    f.db,
    {
      problemId,
      eventId,
      idempotencyKey: eventId,
      requestDigest: await sha256Hex(payloadJson),
      eventType: status === undefined ? "conflict.normalized" : "conflict.resolved",
      objectKind: "conflict",
      objectId: conflictId,
      objectVersion: status === undefined ? 1 : 2,
      payloadJson,
      createdAt,
      attribution: {
        fellowId: f.binding.fellowId,
        sponsorId,
        sessionId: "S-conflict",
        modelSelfDeclared: "test/model",
        harness: "curl",
      },
    },
    {
      statementsAfterEvent: ({ sequence }) =>
        status === undefined
          ? [
              f.db
                .prepare(
                  `INSERT INTO conflicts(conflict_id,problem_id,seq,claim_a_id,claim_a_version,claim_b_id,claim_b_version,
      aligned_definitions,aligned_scope,aligned_quantifiers,smallest_disagreement,agreed_facts_json,
      discriminating_tests_json,status,author_fellow_id,created_at)
    VALUES(?,?,?,'C-1',1,'C-2',2,?,?,?,?,?,?,'open',?,?)`,
                )
                .bind(
                  conflictId,
                  problemId,
                  sequence,
                  normalized.aligned_definitions,
                  normalized.aligned_scope,
                  normalized.aligned_quantifiers,
                  normalized.smallest_disagreement,
                  JSON.stringify(normalized.agreed_facts),
                  JSON.stringify(normalized.discriminating_tests),
                  f.binding.fellowId,
                  createdAt,
                ),
            ]
          : [],
    },
  );
}
function control(f: Fixture, ref: string, visibility: "hidden" | "visible", version: number) {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'conflict',?,?,'operator','privacy','usr_operator','Fixture control.',?,?)`)
    .run(
      `CC-${crypto.randomUUID()}`,
      problemId,
      ref,
      visibility,
      version,
      new Date().toISOString(),
    );
}
function face(f: Fixture, format: string, init?: RequestInit) {
  return createLedgerFaceRoutes().request(
    `https://a.asimposium.org/p/${problemId}/conflicts.${format}`,
    init,
    { DB: f.db } as Env,
  );
}

test("redacted conflict sources never expose retained projection prose", async () => {
  const f = await fixture(),
    admitted = await publish(f);
  f.sql
    .query(
      "UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='privacy' WHERE event_id=?",
    )
    .run(new Date().toISOString(), admitted.eventId);
  for (const format of formats) {
    const response = await face(f, format),
      text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(normalized.smallest_disagreement);
    expect(text).not.toContain(normalized.agreed_facts[0]);
    expect(text).not.toContain(normalized.discriminating_tests[0]);
    expect(text).toContain("unavailable");
    expect(text).not.toContain("No normalized conflicts recorded");
  }
});

test("mutable conflict projections cannot invent resolution, content or attribution", async () => {
  const f = await fixture(),
    admitted = await publish(f);
  // Deliberately plant projection corruption below its immutable-field guard.
  f.sql.exec("DROP TRIGGER conflicts_immutable_update");
  f.sql
    .query(`UPDATE conflicts SET seq=999, claim_a_id='C-999', aligned_definitions='FORGED-DEFINITIONS',
    aligned_scope='FORGED-SCOPE',aligned_quantifiers='FORGED-QUANTIFIERS',
    smallest_disagreement='FORGED-DISAGREEMENT',agreed_facts_json='["FORGED-FACT"]',
    discriminating_tests_json='["FORGED-TEST"]',status='resolved',resolution='FORGED-RESOLUTION',
    author_fellow_id='FORGED-AUTHOR',created_at='FORGED-TIME',resolved_at='FORGED-TIME'`)
    .run();
  const result = await loadProblemConflicts(f.db, problemId);
  expect(result.conflicts[0]).toMatchObject({
    ...normalized,
    status: "open",
    resolution: null,
    resolved_at: null,
    author_fellow_id: f.binding.fellowId,
    seq: admitted.seq,
  });
  for (const format of formats) {
    const response = await face(f, format),
      text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("FORGED-");
    expect(text).toContain(normalized.smallest_disagreement);
    expect(
      (await face(f, format, { headers: { "if-none-match": response.headers.get("etag") ?? "" } }))
        .status,
    ).toBe(304);
  }
});

test("normalization controls withhold every face before old ETags and HEAD", async () => {
  for (const kind of ["object", "version", "event"] as const) {
    const f = await fixture(),
      admitted = await publish(f);
    const etags = await Promise.all(
      formats.map(async (format) => (await face(f, format)).headers.get("etag") ?? ""),
    );
    const ref = kind === "object" ? "CF-1" : kind === "version" ? "CF-1@1" : `#${admitted.seq}`;
    control(f, ref, "hidden", 1);
    for (const [i, format] of formats.entries())
      for (const method of ["GET", "HEAD"]) {
        const response = await face(f, format, {
          method,
          headers: { "if-none-match": etags[i] ?? "" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).not.toBe(etags[i]);
        expect(await response.text()).not.toContain(normalized.smallest_disagreement);
      }
    control(f, ref, "visible", 2);
    expect((await loadProblemConflicts(f.db, problemId)).conflicts).toHaveLength(1);
  }
});

test("verified resolutions remain truthful and withheld lifecycle never reopens a conflict", async () => {
  for (const status of ["resolved", "persistent-uncertainty"] as const) {
    const f = await fixture();
    await publish(f);
    const settled = await publish(f, "CF-1", status);
    expect((await loadProblemConflicts(f.db, problemId)).conflicts[0]).toMatchObject({
      status,
      resolution,
    });
    expect(
      (await loadProblemConflicts(f.db, problemId, { status: "open" })).conflicts,
    ).toHaveLength(0);
    expect((await loadProblemConflicts(f.db, problemId, { status })).conflicts).toHaveLength(1);
    const etags = await Promise.all(
      formats.map(async (format) => {
        const response = await face(f, format);
        expect(await response.text()).toContain(resolution);
        return response.headers.get("etag") ?? "";
      }),
    );
    const ref = status === "resolved" ? "CF-1@2" : `#${settled.seq}`;
    control(f, ref, "hidden", 1);
    const hidden = await loadProblemConflicts(f.db, problemId);
    expect(hidden.conflicts).toHaveLength(0);
    expect(hidden.omitted).toContain("Some conflict content or lifecycle history is unavailable.");
    for (const [i, format] of formats.entries()) {
      const response = await face(f, format, { headers: { "if-none-match": etags[i] ?? "" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).not.toBe(etags[i]);
      expect(await response.text()).not.toContain(resolution);
    }
    control(f, ref, "visible", 2);
    expect((await loadProblemConflicts(f.db, problemId)).conflicts[0]?.status).toBe(status);
  }
});

test("whole-problem controls and private state precede conflict conditional responses", async () => {
  const f = await fixture();
  await publish(f);
  f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(problemId);
  const initial = await face(f, "json"),
    etag = initial.headers.get("etag") ?? "";
  expect(initial.headers.get("x-robots-tag")).toContain("noindex");
  control(f, "problem", "hidden", 1);
  for (const format of formats)
    for (const method of ["GET", "HEAD"]) {
      const response = await face(f, format, { method, headers: { "if-none-match": etag } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(normalized.smallest_disagreement);
    }
  control(f, "problem", "visible", 2);
  expect((await face(f, "json")).status).toBe(200);
  // A private scope must never publish retained historical rows either.
  f.sql.query("UPDATE problems SET status='private-draft' WHERE id=?").run(problemId);
  expect((await loadProblemConflicts(f.db, problemId)).problem).toBeNull();
  for (const format of formats)
    for (const method of ["GET", "HEAD"]) {
      expect((await face(f, format, { method, headers: { "if-none-match": etag } })).status).toBe(
        404,
      );
    }
});

test("unavailable or invalid resolution bytes never turn a settled conflict back into open", async () => {
  for (const mode of ["missing", "corrupt", "identity", "redacted"] as const) {
    const f = await fixture();
    await publish(f);
    const settled = await publish(
      f,
      "CF-1",
      "resolved",
      mode === "identity" ? { problem_id: "P-OTHER" } : {},
    );
    if (mode === "missing")
      f.sql.query("DELETE FROM event_content WHERE event_id=?").run(settled.eventId);
    if (mode === "corrupt") {
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      f.sql
        .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
        .run(settled.eventId);
    }
    if (mode === "redacted")
      f.sql
        .query(
          "UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='privacy' WHERE event_id=?",
        )
        .run(new Date().toISOString(), settled.eventId);
    const result = await loadProblemConflicts(f.db, problemId);
    expect(result.conflicts).toHaveLength(0);
    expect(result.omitted).toContain("Some conflict content or lifecycle history is unavailable.");
  }
});

test("large legal normalizations remain readable within a bounded source-byte window", async () => {
  const f = await fixture();
  const facts = Array.from({ length: 32 }, () => "界".repeat(1000));
  for (let n = 1; n <= 24; n++) {
    await publish(f, `CF-${n}`, undefined, { agreed_facts: facts, discriminating_tests: facts });
  }
  const result = await loadProblemConflicts(f.db, problemId, { limit: 30 });
  expect(result.conflicts[0]?.agreed_facts).toEqual(facts);
  expect(result.conflicts.length).toBeGreaterThan(0);
  expect(result.conflicts.length).toBeLessThan(24);
  expect(result.omitted).toContain("content_limit: conflict source bytes truncated");
  expect(result.omitted).toContain("Some conflict content or lifecycle history is unavailable.");
});

test("missing, corrupt and mismatched conflict sources remain omitted within their admission window", async () => {
  for (const mode of ["missing", "corrupt", "identity"] as const) {
    const f = await fixture(),
      admitted = await publish(
        f,
        "CF-1",
        undefined,
        mode === "identity" ? { conflict_id: "CF-FORGED" } : {},
      );
    await publish(f, "CF-2");
    if (mode === "missing")
      f.sql.query("DELETE FROM event_content WHERE event_id=?").run(admitted.eventId);
    if (mode === "corrupt") {
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      f.sql
        .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
        .run(admitted.eventId);
    }
    const result = await loadProblemConflicts(f.db, problemId, { limit: 1 });
    expect(result.conflicts).toHaveLength(0);
    expect(result.omitted).toContain("candidate_limit: results truncated to limit=1");
    expect(result.omitted).toContain("Some conflict content or lifecycle history is unavailable.");
  }
});
