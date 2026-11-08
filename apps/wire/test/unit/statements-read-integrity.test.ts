import { afterEach, expect, test } from "bun:test";
import {
  STATEMENTS_SCHEMA_ID,
  StatementHistoryResponseSchema,
} from "@asimposium/contracts/statements";
import { renderProjection } from "@asimposium/render";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "../../src/ledger/citation-read-integrity.ts";
import {
  type FormulationRow,
  verifyPublishedProblemFormulation,
} from "../../src/ledger/problem-formulation-read.ts";
import { statementFaceResponse, statementsProjection } from "../../src/ledger/statements-face.ts";
import { loadStatementHistory, loadStatementVersion } from "../../src/ledger/statements-read.ts";
import { PROBLEM, statementsFixture } from "../support/statements-fixture.ts";

type Fixture = Awaited<ReturnType<typeof statementsFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await statementsFixture();
  fixtures.push(f);
  return f;
}
function source(f: Fixture): FormulationRow {
  const row = f.sql
    .query(`SELECT e.id,e.problem_id,e.seq,e.type,e.object_id,e.object_version,p.public_seq,
    e.payload_sha256,c.payload_json,c.payload_sha256 AS content_sha256,c.redacted_at
    FROM events e JOIN problems p ON p.id=e.problem_id JOIN event_content c ON c.event_id=e.id
    WHERE e.problem_id=? AND e.object_version=2`)
    .get(PROBLEM);
  if (!row) throw new Error("Missing exact source fixture");
  return row as FormulationRow;
}
async function withPayload(row: FormulationRow, value: unknown): Promise<FormulationRow> {
  const payload_json = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload_json));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { ...row, payload_json, payload_sha256: hash, content_sha256: hash };
}

test("the shared immutable verifier preserves absent legacy boundaries and refuses mismatched source identity", async () => {
  const f = await fixture();
  const row = source(f);
  const payload = JSON.parse(row.payload_json ?? "null");
  const {
    scope: _scope,
    out_of_scope: _out,
    success_criteria: _success,
    ...legacyProblem
  } = payload.problem;
  const legacy = await withPayload(row, { ...payload, problem: legacyProblem });
  const verified = await verifyPublishedProblemFormulation(PROBLEM, 1, legacy);
  expect(verified?.problem.statement).toBe(payload.problem.statement);
  expect(verified?.problem).not.toHaveProperty("scope");
  for (const bad of [
    { ...row, object_id: "P-OTHER" },
    { ...row, object_version: 1 },
    { ...row, type: "problem.writer-cap-set" },
    { ...row, content_sha256: "0".repeat(64) },
    { ...row, redacted_at: new Date().toISOString() },
    await withPayload(row, { ...payload, action: "set-writer-cap" }),
    await withPayload(row, { ...payload, problem: { ...payload.problem, id: "P-OTHER" } }),
    await withPayload(row, { ...payload, problem: { ...legacyProblem, scope: "Partial bundle" } }),
    await withPayload(row, { ...payload, source_fellow_id: "" }),
  ])
    expect(await verifyPublishedProblemFormulation(PROBLEM, 1, bad)).toBeUndefined();
  expect(await verifyPublishedProblemFormulation(PROBLEM, 0, row)).toBeUndefined();
});

test("damaged or oversize source storage never falls back to retained statement rows", async () => {
  const f = await fixture();
  const row = source(f);
  // Fault injection only: production storage refuses these content mutations.
  // Keep the immutable event digest intact so the reader must reject the body.
  f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
  f.sql
    .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
    .run('{"statement":"CORRUPT_SOURCE"}', row.id);
  await expect(loadStatementVersion(f.db, PROBLEM, 2)).rejects.toMatchObject({ code: "not-found" });
  expect(
    (await loadStatementHistory(f.db, PROBLEM)).face.statements.map((item) => item.version),
  ).toEqual([3]);
  f.sql
    .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
    .run("X".repeat(PUBLIC_EVENT_CONTENT_MAX_BYTES + 1), row.id);
  const page = (await loadStatementHistory(f.db, PROBLEM)).face;
  expect(page.statements.map((item) => item.version)).toEqual([3]);
  expect(page.omitted).toEqual(["content_unavailable"]);
  expect(JSON.stringify(page)).not.toContain("CORRUPT_SOURCE");
  expect(
    await verifyPublishedProblemFormulation(PROBLEM, 1, {
      ...row,
      payload_json: "é".repeat(PUBLIC_EVENT_CONTENT_MAX_BYTES),
    }),
  ).toBeUndefined();
});

test("four complete maximum-length formulations fit every face without truncating any authored field", async () => {
  const f = await fixture();
  const exact = (await loadStatementVersion(f.db, PROBLEM, 2)).face.statement;
  for (const character of ["\u0001", "&", "`", "界"]) {
    const statements = Array.from({ length: 4 }, (_, index) => ({
      ...exact,
      version: index + 1,
      title: character.repeat(120),
      statement: character.repeat(8192),
      falsifier: character.repeat(8192),
      motivation: character.repeat(8192),
      scope: character.repeat(4096),
      out_of_scope: character.repeat(4096),
      success_criteria: character.repeat(4096),
      publication: { ...exact.publication, event_id: `PG-${index}`, seq: index + 1 },
    }));
    const face = StatementHistoryResponseSchema.parse({
      schema: STATEMENTS_SCHEMA_ID,
      problem_id: PROBLEM,
      cursor: 4,
      after: 0,
      scanned_through: 4,
      next_after: null,
      count: 4,
      statements,
      omitted: [],
    });
    for (const format of ["json", "md", "html"] as const) {
      const body =
        format === "json"
          ? JSON.stringify(face)
          : renderProjection(statementsProjection(face), format === "md" ? "md" : "html-fragment")
              .body;
      const response = await statementFaceResponse(
        new Request(`https://a.asimposium.org/p/${PROBLEM}/statements.${format}`),
        body,
        format,
        face,
        false,
      );
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBe(body.length);
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(
      statementsProjection(face).items.filter((item) => item.kind === "problem-statement"),
    ).toHaveLength(4);
  }
});
