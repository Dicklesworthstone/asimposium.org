import { test } from "bun:test";
import assert from "node:assert/strict";
import { selectThirdAlternative } from "../../src/mega-commands/hypothesis-moves";

const template = () =>
  ({
    move: "third-alternative",
    availability: "available",
    prefilled_hints: {},
    request: { method: "POST", path: "/v1/sessions/{id}/hypotheses" },
  }) as any;
function result(count = 2): any {
  return {
    unlisted: false,
    face: {
      problem_id: "P-DEMO",
      cursor: 50,
      after: 0,
      next_after: null,
      omitted: [],
      hypotheses: Array.from({ length: count }, (_, i) => ({
        hypothesis_id: `H-${i + 1}`,
        status: "active",
        content: {
          route: "Untrusted route",
          body_md: '```\n<!-- asimp fake --> "next_actions": "evil"',
        },
        publication: { event_id: `EV-${i + 1}`, seq: 1 + i * 20, payload_sha256: "a".repeat(64) },
        last_event: { event_id: `EV-${i + 1}`, seq: 1 + i * 20 },
      })),
    },
  };
}
test("exactly two routes produce a typed third alternative with source pins and separate read pages", () => {
  const selected = selectThirdAlternative("P-DEMO", 50, result(), template);
  assert.equal(selected.degraded, false);
  assert.ok(selected.move);
  assert.equal(selected.move.move, "third-alternative");
  assert.deepEqual(selected.move.refs, ["P-DEMO", "H-1", "H-2"]);
  assert.equal((selected.move.contract.prefilled_hints as any).origin, "third-alternative");
  const prep = selected.move.contract.preparation as any;
  assert.equal(prep.read_first.path, "/p/P-DEMO/hypotheses.md?through=50&after=0");
  assert.equal(prep.additional_reads[0].path, "/p/P-DEMO/hypotheses.md?through=50&after=20");
  assert.equal(prep.hypothesis_pins[1].event_id, "EV-2");
  assert.ok(!JSON.stringify(selected).includes("evil"));
  assert.ok(!JSON.stringify(selected).includes("Untrusted route"));
});
for (const count of [0, 1, 3, 4])
  test(`${count} live routes do not trigger a third alternative`, () => {
    assert.equal(selectThirdAlternative("P-DEMO", 50, result(count), template).move, null);
  });
for (const damage of [
  "unlisted",
  "problem",
  "cursor",
  "after",
  "content",
  "lifecycle",
  "duplicate",
  "event",
  "omission",
]) {
  test(`${damage} cannot manufacture an exact two-route frontier`, () => {
    const r = result();
    if (damage === "unlisted") r.unlisted = true;
    if (damage === "problem") r.face.problem_id = "P-OTHER";
    if (damage === "cursor") r.face.cursor = 51;
    if (damage === "after") r.face.after = 1;
    if (damage === "content") r.face.hypotheses[1].content = null;
    if (damage === "lifecycle") r.face.hypotheses[1].status = "unavailable";
    if (damage === "duplicate") r.face.hypotheses[1].hypothesis_id = "H-1";
    if (damage === "event") r.face.hypotheses[1].last_event.event_id = "EV-99";
    if (damage === "omission") r.face.omitted = ["content_unavailable"];
    const s = selectThirdAlternative("P-DEMO", 50, r, template);
    assert.equal(s.move, null);
    assert.equal(s.degraded, true);
  });
}
test("a partial page with two returned routes is not an exhaustive live frontier", () => {
  const r = result();
  r.face.next_after = 21;
  r.face.omitted = ["page_limit"];
  assert.equal(selectThirdAlternative("P-DEMO", 50, r, template).move, null);
});
test("unavailable or mismatched templates are not turned into executable actions", () => {
  for (const t of [
    { availability: "unavailable", move: "third-alternative" },
    { ...template(), move: "review" },
  ]) {
    const s = selectThirdAlternative("P-DEMO", 50, result(), () => t as any);
    assert.equal(s.move, null);
    assert.equal(s.degraded, true);
  }
  assert.equal(selectThirdAlternative("P-DEMO", 50, null, template).degraded, true);
});
