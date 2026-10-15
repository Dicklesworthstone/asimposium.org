import { test } from "bun:test";
import assert from "node:assert/strict";
import { frictionFixture } from "./friction-moves-fixture.ts";

for (const unlisted of [false, true]) {
  test(`friction investigation uses pinned scoped work with unlisted=${unlisted}`, async () => {
    const f = frictionFixture(unlisted);
    try {
      f.report(2, f.claim(1));
      const selected = await f.run();
      assert.equal(selected.degraded, false);
      assert.equal(selected.move?.move, "add-refuter-from-friction");
      assert.deepEqual(selected.move?.refs, ["P-DEMO", "C-1@1", "E-2"]);
      const prep = selected.move?.contract.preparation as Record<string, any>;
      assert.equal(prep.target_pin.event_id, "EV-P-DEMO-1");
      assert.equal(prep.friction_pin.event_id, "EV-P-DEMO-2");
      assert.equal(prep.read_first.path, "/p/P-DEMO/formal.md?through=100&target=E-2");
      assert.deepEqual(selected.move?.contract.prefilled_hints, { type: "scratch" });
      assert.equal(prep.publication_target_hints.direction, undefined);
      assert.doesNotMatch(JSON.stringify(selected), /WITNESS-SENTINEL|ANALYSIS-SENTINEL|TOOLCHAIN-SENTINEL|OBLIGATION-SENTINEL|\/search|\/review-queue/);
    } finally { f.sqlite.close(); }
  });
  for (const target of ["problem", "C-1", "C-1@1", "#1", "E-2", "E-2@1", "#2"]) {
    test(`unlisted=${unlisted} friction binding rechecks ${target} hide/restore after admission`, async () => {
      const f = frictionFixture(unlisted);
      try {
        f.report(2, f.claim(1));
        assert.ok((await f.run()).move);
        const hidden = await f.run({ ...f.dependencies, page: async (...args) => {
          const page = await f.dependencies.page(...args);
          f.sqlite.query("INSERT INTO content_controls VALUES('P-DEMO', ?, 1, 'hidden')").run(target);
          return page;
        } });
        assert.equal(hidden.move, null);
        assert.equal(hidden.degraded, true);
        f.sqlite.query("INSERT INTO content_controls VALUES('P-DEMO', ?, 2, 'visible')").run(target);
        const restored = await f.run();
        assert.ok(restored.move);
        assert.equal(restored.degraded, false);
      } finally { f.sqlite.close(); }
    });
  }
  test(`unlisted=${unlisted} formalization task refuses a relisted target after page capture`, async () => {
    const f = frictionFixture(unlisted);
    try {
      f.report(2, f.claim(1));
      const selected = await f.run({ ...f.dependencies, page: async (...args) => {
        const page = await f.dependencies.page(...args);
        f.sqlite.query("UPDATE problems SET unlisted=? WHERE id='P-DEMO'").run(unlisted ? 0 : 1);
        return page;
      } });
      assert.deepEqual(selected, { move: null, degraded: true });
    } finally { f.sqlite.close(); }
  });
}

test("unlisted witness selection preserves consequence ranking and oldest same-target report", async () => {
  const f = frictionFixture(true);
  try {
    const low = f.claim(1, "C-1", 1, 1), high = f.claim(3, "C-3", 1, 12);
    f.report(2, low);
    f.report(5, high);
    f.report(4, high);
    assert.deepEqual((await f.run()).move?.refs, ["P-DEMO", "C-3@1", "E-4"]);
  } finally { f.sqlite.close(); }
});
test("hidden high-consequence work does not suppress an independent readable witness", async () => {
  const f = frictionFixture(true);
  try {
    const low = f.claim(1, "C-1", 1, 1), high = f.claim(3, "C-3", 1, 12);
    f.report(2, low);
    f.report(4, high);
    f.sqlite.exec("INSERT INTO content_controls VALUES('P-DEMO','C-3',1,'hidden')");
    const selected = await f.run();
    assert.equal(selected.degraded, true);
    assert.deepEqual(selected.move?.refs, ["P-DEMO", "C-1@1", "E-2"]);
  } finally { f.sqlite.close(); }
});
test("formalization pages may not combine different listing scopes", async () => {
  const f = frictionFixture(true);
  try {
    f.report(2, f.claim(1));
    await assert.rejects(f.run({ ...f.dependencies, page: async (...args) => {
      const page = await f.dependencies.page(...args);
      return { ...page, unlisted: page.after === 0, next_after: page.after === 0 ? 2 : null };
    } }), /FRICTION_MOVE_PAGE_INVALID/);
  } finally { f.sqlite.close(); }
});
for (const value of [undefined, null, 1, "true"]) {
  test(`malformed formalization listing state ${String(value)} cannot create work`, async () => {
    const f = frictionFixture(true);
    try {
      f.report(2, f.claim(1));
      await assert.rejects(f.run({ ...f.dependencies, page: async (...args) => ({
        ...(await f.dependencies.page(...args)), unlisted: value as unknown as boolean,
      }) }), /FRICTION_MOVE_PAGE_INVALID/);
      assert.equal(f.calls.length, 0);
    } finally { f.sqlite.close(); }
  });
}
for (const status of ["private-draft", "retired", "resolved"]) {
  test(`unlisted formalization tasks never recommend ${status} problems`, async () => {
    const f = frictionFixture(true);
    try {
      f.report(2, f.claim(1));
      f.sqlite.query("UPDATE problems SET status=? WHERE id='P-DEMO'").run(status);
      assert.deepEqual(await f.run(), { move: null, degraded: true });
    } finally { f.sqlite.close(); }
  });
}
test("unlisted scoped witnesses remain bound to their original claim version", async () => {
  const f = frictionFixture(true);
  try {
    const old = f.claim(1);
    f.report(2, old);
    assert.ok((await f.run()).move);
    f.claim(3, "C-1", 2);
    f.items.splice(0, f.items.length, old);
    assert.deepEqual(await f.run(), { move: null, degraded: true });
  } finally { f.sqlite.close(); }
});
