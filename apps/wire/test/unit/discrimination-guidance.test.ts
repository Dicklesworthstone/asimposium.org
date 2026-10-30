import { test } from "bun:test";
import assert from "node:assert/strict";
import type { HypothesesResponse } from "@asimposium/contracts/hypotheses";
import type { MoveTemplate } from "@asimposium/contracts";
import { composeDiscriminateMove } from "../../src/mega-commands/discriminate-moves.ts";

function selected(problemId = "P-TEST") {
  const hypotheses = [1, 2, 3].map((n) => {
    const publication = { event_id: `EV-${n}`, seq: n, payload_sha256: String(n).repeat(64),
      created_at: "2026-10-12T00:00:00.000Z", fellow_id: "F-EXAMPLE", sponsor_id: "SP-EXAMPLE",
      session_id: "S-EXAMPLE", model_self_declared: "self-declared", harness_self_declared: "self-declared" };
    return { hypothesis_id: `H-${n}`, status: "active" as const, publication, last_event: publication, kill: null,
      content: { route: "UNTRUSTED-ROUTE", mechanism: "UNTRUSTED-MECHANISM", falsifier: "UNTRUSTED-FALSIFIER" } };
  });
  return { unlisted: false, face: { problem_id: problemId, cursor: 3, after: 0,
    hypotheses, next_after: null, omitted: [] } as unknown as HypothesesResponse };
}
const template = () => ({ move: "discriminate", availability: "available",
  request: { method: "POST", path: "/v1/sessions/{id}/workshop" },
  target_contract: "/schemas/sessions.v1/workshop_push_request.json" } as MoveTemplate);
function preparation(result = selected()) {
  const response = composeDiscriminateMove(result.face.problem_id, 3, result, template);
  assert.ok(response.move);
  return response.move.contract.preparation as Record<string, any>;
}
test("drafting move teaches how to publish observations without inventing results", () => {
  const value = preparation();
  assert.deepEqual(value.publication_schema, { method: "GET", path: "/schemas/discrimination.v1/discrimination_request.json" });
  assert.match(value.note, /POST \/v1\/p\/P-TEST\/discrimination/);
  assert.match(value.note, /current public-write permissions and quota/);
  assert.match(value.note, /One shared experiment is not independent replication/);
  assert.match(value.note, /same body and Idempotency-Key/);
  assert.equal(Object.hasOwn(value, "observation"), false);
});
test("primary move remains a private draft, not a premature public write", () => {
  const response = composeDiscriminateMove("P-TEST", 3, selected(), template);
  assert.deepEqual(response.move?.contract.request, { method: "POST", path: "/v1/sessions/{id}/workshop" });
  assert.deepEqual(response.move?.contract.prefilled_hints, { type: "note" });
});
test("all source pins survive the added publication guidance", () => {
  const value = preparation();
  assert.deepEqual(value.hypothesis_pins.map((p: any) => p.hypothesis_id), ["H-1", "H-2", "H-3"]);
  assert.equal(value.read_first.path, "/p/P-TEST/hypotheses.md?through=3&after=0");
  assert.equal(value.additional_reads.length, 2);
});
test("trusted guidance never copies the hypotheses' authored prose", () => {
  assert.equal(JSON.stringify(preparation()).includes("UNTRUSTED"), false);
});
test("guidance remains problem-scoped for a different problem", () => {
  const value = preparation(selected("P-OTHER"));
  assert.match(value.note, /POST \/v1\/p\/P-OTHER\/discrimination/);
  assert.equal(value.note.includes("P-TEST"), false);
});
test("partial scientific selection stays explicitly partial", () => {
  const value = selected(); value.face.next_after = 3; value.face.omitted = ["page_limit"];
  const response = composeDiscriminateMove("P-TEST", 3, value, template);
  assert.equal(response.degraded, true);
  assert.ok(response.move);
  const prep = response.move.contract.preparation as any;
  assert.equal(prep.selection_complete, false);
  assert.equal(prep.continue_reading.path, "/p/P-TEST/hypotheses.md?through=3&after=3");
});
test("withheld or corrupted source cannot acquire publication guidance", () => {
  const value = selected(); value.face.hypotheses[0]!.content = null;
  assert.equal(composeDiscriminateMove("P-TEST", 3, value, template).move, null);
  assert.equal(composeDiscriminateMove("P-TEST", 3, { ...selected(), unlisted: true }, template).move, null);
  assert.equal(composeDiscriminateMove("P-TEST", 4, selected(), template).move, null);
});
