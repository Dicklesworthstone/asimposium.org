import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { parseEventTailQuery, renderEventTail } from "../../../../packages/contracts/src/event-tail-model.ts";
import { eventTailResponse } from "../../src/ledger/event-tail-http.ts";
import { type EventTailDatabase, EventTailReadError } from "../../src/ledger/event-tail-read.ts";
import {
  EVENT_WAIT_HEAD_SELECT,
  EVENT_WAIT_LIMITS,
  EventWaitAdmission,
  type EventWaitRuntime,
  eventWaitDelay,
  readPublicEventTailWithWait,
} from "../../src/ledger/event-tail-wait.ts";

function fixture(count = 1) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, public_seq INTEGER, status TEXT, unlisted INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, problem_id TEXT, seq INTEGER, type TEXT,
      object_kind TEXT, object_id TEXT, object_version INTEGER, created_at TEXT,
      payload_sha256 TEXT, actor_fellow_id TEXT, actor_sponsor_id TEXT, actor_session_id TEXT,
      model_string_self_declared TEXT, harness TEXT, UNIQUE(problem_id, seq));
    CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_sha256 TEXT, payload_json TEXT, redacted_at TEXT);
    CREATE TABLE workshop_objects (body TEXT);
    INSERT INTO workshop_objects VALUES ('PRIVATE-WORKSHOP-CANARY');
    INSERT INTO problems VALUES ('P-DEMO', 0, 'active', 0), ('P-OTHER', 0, 'active', 0);`);
  const digest = "a".repeat(64);
  const append = (seq: number, problem = "P-DEMO") => {
    sql.prepare("INSERT INTO events VALUES (?, ?, ?, 'claim.created', 'claim', ?, 1, ?, ?, 'F-1', 'S-1', 'SES-1', 'model', 'harness')")
      .run(`${problem}-event-${seq}`, problem, seq, `C-${seq}`, "2026-09-22T00:00:00.000Z", digest);
    sql.prepare("INSERT INTO event_content VALUES (?, ?, ?, NULL)")
      .run(`${problem}-event-${seq}`, digest, '{"secret":"PRIVATE-CONTENT-CANARY"}');
    sql.prepare("UPDATE problems SET public_seq=? WHERE id=?").run(seq, problem);
  };
  for (let i = 1; i <= count; i++) append(i);
  const queries: string[] = [];
  let beforeQuery: ((query: string) => Promise<void>) | undefined;
  let afterQuery: ((query: string) => void) | undefined;
  const db: EventTailDatabase = {
    prepare(query) {
      return { bind(...values) {
        return { all: async <T>() => {
          queries.push(query);
          await beforeQuery?.(query);
          const results = sql.prepare(query).all(...values) as T[];
          afterQuery?.(query);
          return { results };
        } };
      } };
    },
  };
  let now = 0;
  let onDelay: ((index: number) => void) | undefined;
  let advance = true;
  const delays: number[] = [];
  const slots = new EventWaitAdmission(() => now);
  const timing: EventWaitRuntime = {
    now: () => now,
    admission: slots,
    delay: async (ms, signal) => {
      signal.throwIfAborted();
      assert.ok(ms > 0 && ms <= EVENT_WAIT_LIMITS.probeIntervalMs);
      delays.push(ms);
      if (advance) now += ms;
      onDelay?.(delays.length);
    },
  };
  const controller = new AbortController();
  const request = { method: "GET", signal: controller.signal };
  const run = (wait = 25, since = count, through?: number, method = "GET") =>
    readPublicEventTailWithWait(db, "P-DEMO", { since, limit: 50, wait, ...(through === undefined ? {} : { through }) }, { ...request, method }, timing);
  return {
    sql, db, append, queries, delays, slots, timing, controller, request, run,
    onDelay: (fn: (index: number) => void) => { onDelay = fn; },
    beforeQuery: (fn: (query: string) => Promise<void>) => { beforeQuery = fn; },
    afterQuery: (fn: (query: string) => void) => { afterQuery = fn; },
    setNow: (value: number) => { now = value; },
    freezeClock: () => { advance = false; },
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof EventTailReadError && error.code === expected;
}

const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("W7.3 bounded public event waiting on actual SQLite", () => {
  for (const seconds of [1, 5, 6, 24, 25]) {
    test(`wait=${seconds} expires with a complete unchanged page and bounded reads`, async () => {
      const f = fixture();
      try {
        const result = await f.run(seconds);
        assert.ok(result);
        assert.equal(result.waitOutcome, "timeout");
        assert.equal(result.page.events.length, 0);
        assert.equal(result.page.page_end.next_cursor, 1);
        assert.equal(result.page.page_end.through, 1);
        assert.equal(result.page.page_end.has_more, false);
        assert.equal(f.delays.reduce((sum, ms) => sum + ms, 0), seconds * 1000);
        assert.ok(f.queries.length <= 6);
        assert.ok(f.queries.every((query) => !query.includes("payload_json") && !query.includes("workshop")));
        const lines = renderEventTail(result.page, "ndjson").trim().split("\n");
        assert.equal(lines.length, 1);
        assert.equal(JSON.parse(lines[0] ?? "").control, "page_end");
        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
      } finally { f.sql.close(); }
    });
  }

  for (const scenario of ["absent", "zero", "head", "pinned", "backlog"] as const) {
    test(`${scenario} never opens a wait`, async () => {
      const f = fixture();
      try {
        const result = scenario === "absent"
          ? await readPublicEventTailWithWait(f.db, "P-DEMO", { since: 1, limit: 50 }, f.request, f.timing)
          : await f.run(scenario === "zero" ? 0 : 25, scenario === "backlog" ? 0 : 1, scenario === "pinned" ? 1 : undefined, scenario === "head" ? "HEAD" : "GET");
        assert.equal(result?.waitOutcome, "immediate");
        assert.equal(f.queries.length, 1);
        assert.equal(f.delays.length, 0);
      } finally { f.sql.close(); }
    });
  }

  test("new commit wakes a reader and the canonical page supplies exact event IDs", async () => {
    const f = fixture();
    try {
      f.onDelay(() => { f.append(2); f.append(3); });
      const result = await f.run();
      assert.equal(result?.waitOutcome, "changed");
      assert.deepEqual(result?.page.events.map((e) => e.event?.id), ["P-DEMO-event-2", "P-DEMO-event-3"]);
      assert.equal(result?.page.page_end.next_cursor, 3);
      assert.equal(f.queries.length, 3);
      assert.equal(f.delays.length, 1);
    } finally { f.sql.close(); }
  });

  test("commit at the timeout boundary is not reported as an empty timeout", async () => {
    const f = fixture();
    try {
      f.onDelay((i) => { if (i === 5) f.append(2); });
      const result = await f.run();
      assert.equal(result?.waitOutcome, "changed");
      assert.equal(result?.page.events[0]?.seq, 2);
      assert.equal(f.delays.length, 5);
    } finally { f.sql.close(); }
  });

  test("workshop and other-problem changes cannot wake this problem's reader", async () => {
    const f = fixture();
    try {
      f.onDelay((i) => {
        f.append(i, "P-OTHER");
        f.sql.exec("UPDATE workshop_objects SET body='UPDATED-PRIVATE-CANARY'");
      });
      const result = await f.run();
      assert.equal(result?.waitOutcome, "timeout");
      assert.equal(result?.page.page_end.next_cursor, 1);
      assert.ok(!JSON.stringify(result).includes("P-OTHER"));
      assert.ok(!JSON.stringify(result).includes("CANARY"));
    } finally { f.sql.close(); }
  });

  test("problem becomes private while waiting: no successful page or cursor", async () => {
    const f = fixture();
    try {
      f.onDelay(() => f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'"));
      assert.equal(await f.run(), null);
      assert.equal(f.queries.length, 2);
    } finally { f.sql.close(); }
  });

  test("privacy change after the head hint still wins at canonical readback", async () => {
    const f = fixture();
    try {
      f.onDelay(() => f.append(2));
      f.afterQuery((q) => { if (q === EVENT_WAIT_HEAD_SELECT) f.sql.exec("UPDATE problems SET status='private-draft' WHERE id='P-DEMO'"); });
      assert.equal(await f.run(), null);
      assert.equal(f.queries.length, 3);
    } finally { f.sql.close(); }
  });

  test("unlisting is rechecked instead of returning old shared-cache authority", async () => {
    const f = fixture();
    try {
      f.onDelay(() => f.sql.exec("UPDATE problems SET unlisted=1 WHERE id='P-DEMO'"));
      const result = await f.run();
      assert.equal(result?.unlisted, true);
      assert.equal(result?.waitOutcome, "changed");
      assert.equal(result?.page.page_end.next_cursor, 1);
    } finally { f.sql.close(); }
  });

  test("redaction between notification and readback cannot restore content availability", async () => {
    const f = fixture();
    try {
      f.onDelay(() => f.append(2));
      f.afterQuery((q) => { if (q === EVENT_WAIT_HEAD_SELECT) f.sql.exec("UPDATE event_content SET redacted_at='2026-09-22T01:00:00.000Z'"); });
      const result = await f.run();
      assert.equal(result?.page.events[0]?.body_omitted, "content_unavailable");
      assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
    } finally { f.sql.close(); }
  });

  test("sequence gaps after wake fail closed", async () => {
    const f = fixture();
    try {
      f.onDelay(() => f.append(3));
      await assert.rejects(() => f.run(), code("EVENT_TAIL_UNAVAILABLE"));
    } finally { f.sql.close(); }
  });

  for (const head of [null, -1, 0, 1.5, "bad", 9007199254740992]) {
    test(`corrupt or regressed head ${String(head)} does not mint a cursor`, async () => {
      const f = fixture();
      try {
        f.onDelay(() => f.sql.prepare("UPDATE problems SET public_seq=? WHERE id='P-DEMO'").run(head));
        await assert.rejects(() => f.run(), code("EVENT_TAIL_UNAVAILABLE"));
        assert.equal(f.delays.length, 1);
      } finally { f.sql.close(); }
    });
  }

  test("unavailable binding errors are coarse and release admission", async () => {
    const f = fixture();
    try {
      f.beforeQuery(async (q) => { if (q === EVENT_WAIT_HEAD_SELECT) throw new Error("PRIVATE-DRIVER-DIAGNOSTIC"); });
      await assert.rejects(() => f.run(), code("EVENT_TAIL_UNAVAILABLE"));
      const releases = Array.from({ length: 8 }, () => f.slots.acquire(f.db, "P-DEMO"));
      assert.ok(releases.every(Boolean));
      for (const release of releases) release?.();
    } finally { f.sql.close(); }
  });

  test("cancellation before entry never touches D1 or reflects an abort reason", async () => {
    const f = fixture();
    try {
      f.controller.abort("PRIVATE-ABORT-REASON");
      await assert.rejects(() => f.run(), (error: unknown) => aborted(error) && !String(error).includes("PRIVATE-"));
      assert.equal(f.queries.length, 0);
    } finally { f.sql.close(); }
  });

  test("cancellation during the sleep prevents every later probe and frees the slot", async () => {
    const f = fixture();
    try {
      const releases = Array.from({ length: 7 }, () => f.slots.acquire(f.db, "P-DEMO"));
      f.onDelay(() => f.controller.abort());
      await assert.rejects(() => f.run(), aborted);
      assert.equal(f.queries.length, 1);
      const reclaimed = f.slots.acquire(f.db, "P-DEMO");
      assert.ok(reclaimed);
      reclaimed();
      for (const release of releases) release?.();
    } finally { f.sql.close(); }
  });

  test("cancellation of an in-flight initial read settles without waiting for D1", async () => {
    const f = fixture();
    let rejectRead: ((error: Error) => void) | undefined;
    try {
      f.beforeQuery(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
      const pending = f.run();
      await flush();
      assert.ok(rejectRead);
      f.controller.abort();
      await assert.rejects(() => pending, aborted);
      rejectRead(new Error("PRIVATE-LATE-ERROR"));
      await flush();
      assert.equal(f.queries.length, 1);
    } finally { f.sql.close(); }
  });

  test("a slow head probe cannot outlive the remaining wait budget", async () => {
    const f = fixture();
    let rejectRead: ((error: Error) => void) | undefined;
    try {
      f.onDelay(() => f.setNow(24_999));
      f.beforeQuery((q) => q === EVENT_WAIT_HEAD_SELECT
        ? new Promise((_resolve, reject) => { rejectRead = reject; }) : Promise.resolve());
      await assert.rejects(() => f.run(), code("EVENT_TAIL_UNAVAILABLE"));
      assert.equal(f.queries.length, 2);
      rejectRead?.(new Error("PRIVATE-LATE-ERROR"));
      await flush();
    } finally { f.sql.close(); }
  });

  test("capacity exhaustion returns an immediate canonical polling page", async () => {
    const f = fixture();
    try {
      const releases = Array.from({ length: 8 }, () => f.slots.acquire(f.db, "P-DEMO"));
      const result = await f.run();
      assert.equal(result?.waitOutcome, "capacity");
      assert.equal(result?.page.page_end.next_cursor, 1);
      assert.equal(f.delays.length, 0);
      assert.equal(f.queries.length, 1);
      for (const release of releases) release?.();
    } finally { f.sql.close(); }
  });

  test("frozen or backward clock cannot create an unbounded polling loop", async () => {
    const f = fixture();
    try {
      f.freezeClock();
      f.onDelay(() => f.setNow(-1000));
      const result = await f.run();
      assert.equal(result?.waitOutcome, "timeout");
      assert.equal(f.delays.length, 5);
      assert.equal(f.queries.length, 6);
    } finally { f.sql.close(); }
  });

  for (const wait of [-1, 26, 1000, 1.5, NaN, Infinity]) {
    test(`invalid wait ${String(wait)} is rejected before binding work`, async () => {
      const f = fixture();
      try {
        await assert.rejects(() => f.run(wait), code("CURSOR_INVALID"));
        assert.equal(f.queries.length, 0);
      } finally { f.sql.close(); }
    });
  }

  test("initial canonical query errors preserve the teaching code", async () => {
    const f = fixture();
    try { await assert.rejects(() => f.run(25, 2), code("CURSOR_INVALID")); }
    finally { f.sql.close(); }
  });

  test("actual timer delay is promptly cancellable", async () => {
    const controller = new AbortController();
    const pending = eventWaitDelay(25_000, controller.signal);
    controller.abort("PRIVATE-ABORT-REASON");
    await assert.rejects(() => pending, (error: unknown) => aborted(error) && !String(error).includes("PRIVATE-"));
  });
});

 describe("wait admission is bounded without shared request I/O", () => {
  test("per-problem and global limits; duplicate release cannot free a peer slot", () => {
    const slots = new EventWaitAdmission();
    const db = {};
    const releases: (() => void)[] = [];
    for (let p = 0; p < 8; p++) {
      for (let i = 0; i < 8; i++) {
        const release = slots.acquire(db, `P-${p}`);
        assert.ok(release);
        releases.push(release);
      }
      assert.equal(slots.acquire(db, `P-${p}`), undefined);
    }
    assert.equal(slots.acquire(db, "P-NEW"), undefined);
    releases[0]?.(); releases[0]?.();
    const replacement = slots.acquire(db, "P-0");
    assert.ok(replacement);
    assert.equal(slots.acquire(db, "P-NEW"), undefined);
    replacement();
    for (const release of releases) release();
  });

  test("same identifier on different bindings does not share per-problem admission", () => {
    const slots = new EventWaitAdmission();
    const dbA = {}, dbB = {};
    for (let i = 0; i < 8; i++) assert.ok(slots.acquire(dbA, "P-DEMO"));
    assert.equal(slots.acquire(dbA, "P-DEMO"), undefined);
    assert.ok(slots.acquire(dbB, "P-DEMO"));
  });

  test("abandoned request slots expire without timers or releasing their replacements", () => {
    let now = 0;
    const slots = new EventWaitAdmission(() => now);
    const db = {};
    const abandoned = Array.from({ length: 8 }, () => slots.acquire(db, "P-DEMO"));
    now = EVENT_WAIT_LIMITS.admissionTtlMs - 1;
    assert.equal(slots.acquire(db, "P-DEMO"), undefined);
    now += 1;
    for (let i = 0; i < 8; i++) assert.ok(slots.acquire(db, "P-DEMO"));
    for (const release of abandoned) release?.();
    assert.equal(slots.acquire(db, "P-DEMO"), undefined);
  });
});

describe("event wait HTTP readback", () => {
  for (const format of ["json", "ndjson", "toon"] as const) {
    for (const outcome of ["changed", "timeout", "capacity"] as const) {
      test(`${format} ${outcome} retains complete framing, cache identity and retry semantics`, async () => {
        const f = fixture();
        const releases: Array<(() => void) | undefined> = [];
        try {
          if (outcome === "changed") f.onDelay(() => f.append(2));
          if (outcome === "capacity") {
            for (let i = 0; i < 8; i++) releases.push(f.slots.acquire(f.db, "P-DEMO"));
          }
          const result = await f.run();
          assert.ok(result);
          assert.equal(result.waitOutcome, outcome);
          const request = new Request(`https://a.asimposium.org/p/P-DEMO/events.${format}?since=1&wait=25`);
          const response = await eventTailResponse(request, result.page, format, result.unlisted, result.waitOutcome);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-asimposium-wait"), outcome);
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          assert.equal(response.headers.get("vary"), "Accept, Last-Event-ID");
          assert.equal(response.headers.get("retry-after"), outcome === "changed" ? null : "5");
          const body = await response.text();
          assert.equal(new TextEncoder().encode(body).byteLength, Number(response.headers.get("content-length")));
          assert.ok(!body.includes("PRIVATE-"));
          if (format === "json") assert.equal(JSON.parse(body).page_end.next_cursor, outcome === "changed" ? 2 : 1);
          if (format === "ndjson") {
            const end = JSON.parse(body.trim().split("\n").at(-1) ?? "");
            assert.equal(end.control, "page_end");
            assert.ok(end.poll.endsWith("&wait=25"));
          }
          if (format === "toon") assert.ok(body.trimEnd().endsWith("|has_more:false]"));
        } finally {
          for (const release of releases) release?.();
          f.sql.close();
        }
      });
    }
  }

  for (const method of ["GET", "HEAD"] as const) {
    test(`${method} conditional read retains wait outcome and no-store headers on 304`, async () => {
      const f = fixture();
      try {
        const result = await f.run();
        assert.ok(result);
        const url = "https://a.asimposium.org/p/P-DEMO/events.json?since=1&wait=25";
        const first = await eventTailResponse(new Request(url), result.page, "json", true, "timeout");
        const etag = first.headers.get("etag");
        assert.ok(etag);
        const conditional = await eventTailResponse(new Request(url, { method, headers: { "if-none-match": etag } }), result.page, "json", true, "timeout");
        assert.equal(conditional.status, 304);
        assert.equal(await conditional.text(), "");
        assert.equal(conditional.headers.get("etag"), etag);
        assert.equal(conditional.headers.get("x-robots-tag"), "noindex, nofollow");
        assert.equal(conditional.headers.get("x-asimposium-wait"), "timeout");
        assert.equal(conditional.headers.get("retry-after"), "5");
        assert.equal(conditional.headers.get("cache-control"), "private, no-store");
      } finally { f.sql.close(); }
    });
  }

  test("HEAD does not hold a connection and still returns the GET content length", async () => {
    const f = fixture();
    try {
      const result = await f.run(25, 1, undefined, "HEAD");
      assert.ok(result);
      const response = await eventTailResponse(new Request("https://a.asimposium.org/p/P-DEMO/events.json?wait=25", { method: "HEAD" }), result.page, "json", false, result.waitOutcome);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("x-asimposium-wait"), "immediate");
      assert.ok(Number(response.headers.get("content-length")) > 0);
      assert.equal(f.delays.length, 0);
    } finally { f.sql.close(); }
  });

  test("wait preference survives snapshot pagination and returns to an unpinned poll", async () => {
    const f = fixture(3);
    try {
      const first = await readPublicEventTailWithWait(f.db, "P-DEMO", { since: 0, limit: 1, wait: 25 }, f.request, f.timing);
      assert.ok(first?.page.page_end.next);
      const next = parseEventTailQuery(new URL(first.page.page_end.next, "https://a.asimposium.org").searchParams);
      assert.deepEqual(next, { since: 1, limit: 1, through: 3, wait: 25 });
      f.append(4);
      const second = await readPublicEventTailWithWait(f.db, "P-DEMO", next!, f.request, f.timing);
      assert.equal(second?.waitOutcome, "immediate");
      assert.equal(second?.page.page_end.through, 3);
      assert.ok(second?.page.page_end.poll.endsWith("&wait=25"));
      assert.ok(!second?.page.page_end.poll.includes("through="));
      assert.equal(f.delays.length, 0);
    } finally { f.sql.close(); }
  });

  for (const legacy of ["missing", "throwing"] as const) {
    test(`incoming signal ${legacy}: read succeeds but waiting is explicitly unavailable`, async () => {
      const f = fixture();
      try {
        const request = Object.defineProperty({ method: "GET" }, "signal", {
          get: () => { if (legacy === "throwing") throw new Error("PRIVATE-RUNTIME-DETAIL"); return undefined; },
        }) as Pick<Request, "method" | "signal">;
        const result = await readPublicEventTailWithWait(f.db, "P-DEMO", { since: 1, limit: 50, wait: 25 }, request, f.timing);
        assert.equal(result?.waitOutcome, "unavailable");
        assert.equal(result?.page.page_end.next_cursor, 1);
        assert.equal(f.delays.length, 0);
        assert.equal(f.queries.length, 1);
        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
      } finally { f.sql.close(); }
    });
  }

  test("ordinary responses keep their original cache policy without a wait header", async () => {
    const f = fixture();
    try {
      const result = await f.run(0);
      assert.ok(result);
      const response = await eventTailResponse(new Request("https://a.asimposium.org/p/P-DEMO/events.json"), result.page, "json", false);
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      assert.equal(response.headers.get("x-asimposium-wait"), null);
      assert.equal(response.headers.get("retry-after"), null);
    } finally { f.sql.close(); }
  });

  test("a real one-second timer wait discovers an actual SQLite append", async () => {
    const f = fixture();
    const timer = setTimeout(() => f.append(2), 20);
    try {
      const start = performance.now();
      const result = await readPublicEventTailWithWait(f.db, "P-DEMO", { since: 1, limit: 50, wait: 1 }, f.request);
      assert.equal(result?.waitOutcome, "changed");
      assert.equal(result?.page.events[0]?.event?.id, "P-DEMO-event-2");
      assert.ok(performance.now() - start >= 900);
    } finally { clearTimeout(timer); f.sql.close(); }
  });
});
