import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { eventTailPath, parseEventTailQuery } from "../../src/event-tail-model.ts";

describe("event wait wire grammar", () => {
  test("every canonical wait from 0 through 25 is accepted without coercion", () => {
    for (let wait = 0; wait <= 25; wait++) {
      const parsed = parseEventTailQuery(new URLSearchParams(`since=8&limit=2&wait=${wait}`));
      assert.deepEqual(parsed, { since: 8, limit: 2, wait });
      assert.ok(parsed);
      assert.equal(
        eventTailPath("P-DEMO", "json", parsed),
        `/p/P-DEMO/events.json?since=8&limit=2&wait=${wait}`,
      );
    }
  });
  test("malformed, repeated, fractional and over-limit waits are refused", () => {
    for (const wait of [
      "",
      "00",
      "01",
      "026",
      "26",
      "1000",
      "-1",
      "1.5",
      "+1",
      " 1",
      "1 ",
      "1e1",
      "NaN",
      "Infinity",
    ]) {
      const params = new URLSearchParams({ wait });
      assert.equal(parseEventTailQuery(params), undefined);
    }
    assert.equal(parseEventTailQuery(new URLSearchParams("wait=1&wait=1")), undefined);
    assert.equal(parseEventTailQuery(new URLSearchParams("wait=25&unknown=x")), undefined);
  });
  test("ordinary and pinned cursors retain their original meaning", () => {
    assert.deepEqual(parseEventTailQuery(new URLSearchParams()), { since: 0, limit: 50 });
    const query = parseEventTailQuery(new URLSearchParams("since=4&through=9&limit=2&wait=25"));
    assert.deepEqual(query, { since: 4, through: 9, limit: 2, wait: 25 });
    assert.ok(query);
    assert.equal(
      eventTailPath("P-DEMO", "ndjson", query),
      "/p/P-DEMO/events.ndjson?since=4&limit=2&through=9&wait=25",
    );
    assert.equal(parseEventTailQuery(new URLSearchParams("since=9&through=4&wait=25")), undefined);
  });
});
