import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { EventTailResponseSchema } from "../../../../packages/contracts/src/event-tail.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Event-tail formats and feeds on real local Workerd/D1 (bead asimposiumorg-yv6).
// State is caused by real writes. Every format pages to the same ordered,
// gap-free, duplicate-free sequence; NDJSON ends each page with its control
// record; Last-Event-ID resumes; every format and feed revalidates by ETag;
// RSS/Atom/JSON Feed carry one entry per public event with stable IDs; the
// export parses; and a private workshop canary appears in none of them.
//
// Not covered: SSE (no event-tail SSE route exists), feed validation by an
// external RSS/Atom validator, edge caching.

const CANARY = "PRIVATE-WORKSHOP-CANARY-7f3a";

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
  const author = await enroll("tails-author", "usr_tails_author");
  const reviewer = await enroll("tails-reviewer", "usr_tails_reviewer");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Tail formats problem",
        statement: "Every integer in 0..90 has a square of the same parity.",
        falsifier: "An integer in 0..90 whose square has the opposite parity.",
        motivation: "Exercise every event-tail format at one ledger state.",
        areas: ["number-theory"],
      },
      author,
      201,
    )
  ).problem.id;
  await sponsorCall(
    "usr_tails_author",
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact range.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  // A private workshop draft carrying the canary; never promoted.
  await call(
    `/v1/sessions/${session}/workshop`,
    { type: "scratch", title: "Private", body_md: `Unpromoted notes ${CANARY}.` },
    author,
    201,
  );
  for (const n of [1, 3, 5, 7]) {
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: `Draft ${n}`, body_md: "Public-bound." },
      author,
      201,
    );
    await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: `${n} squared is odd, like ${n}.`,
        falsifier: `${n} squared is even.`,
      },
      author,
      201,
    );
  }

  const get = async (path, headers = {}) => {
    const response = await worker.fetch(`${origin}${path}`, {
      headers: { "User-Agent": userAgent, ...headers },
    });
    return { response, text: await response.text() };
  };
  const bodies = [];
  const revalidates = async (path, headers = {}) => {
    const first = await get(path, headers);
    assert.equal(first.response.status, 200, path);
    const etag = first.response.headers.get("etag");
    assert.ok(etag, `${path} has an ETag`);
    const again = await get(path, { ...headers, "if-none-match": etag });
    assert.equal(again.response.status, 304, `${path} revalidates`);
    bodies.push(first.text);
    return first;
  };

  // The whole tail as JSON is the reference sequence.
  const full = EventTailResponseSchema.parse(
    JSON.parse((await revalidates(`/p/${problem}/events.json?since=0&limit=200`)).text),
  );
  const reference = full.events.map((event) => event.seq);
  assert.deepEqual(
    reference,
    Array.from({ length: reference.length }, (_, i) => i + 1),
    "the reference tail is gap-free from 1",
  );
  assert.ok(reference.length >= 5, `tail has ${reference.length} events`);

  // Page every format with limit=2 and resume from its own cursor.
  const pageThrough = async (format) => {
    const seen = [];
    let since = 0;
    for (let page = 0; page < 50; page++) {
      const { response, text } = await revalidates(
        `/p/${problem}/events.${format}?since=${since}&limit=2`,
      );
      assert.ok(response.headers.get("content-type"), `${format} declares its type`);
      let next;
      let more;
      if (format === "json") {
        const body = EventTailResponseSchema.parse(JSON.parse(text));
        seen.push(...body.events.map((event) => event.seq));
        next = body.page_end.next_cursor;
        more = body.page_end.has_more;
      } else if (format === "ndjson") {
        const lines = text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        const control = lines.at(-1);
        assert.equal(control.control, "page_end", "every NDJSON page ends with its control record");
        seen.push(...lines.slice(0, -1).map((line) => line.seq));
        next = control.next_cursor;
        more = control.has_more;
      } else {
        const lines = text.trimEnd().split("\n");
        assert.equal(lines[0], "id|seq|type|object_id|created_at");
        const footer = /^\[control:page_end\|next_cursor:(\d+)\|has_more:(true|false)\]$/.exec(
          lines.at(-1),
        );
        assert.ok(footer, "TOON page ends with its control record");
        seen.push(...lines.slice(1, -1).map((line) => Number(line.split("|")[1])));
        next = Number(footer[1]);
        more = footer[2] === "true";
      }
      since = next;
      if (!more) break;
    }
    return seen;
  };
  for (const format of ["json", "ndjson", "toon"]) {
    assert.deepEqual(await pageThrough(format), reference, `${format} pages the same sequence`);
  }

  // Last-Event-ID resumes where a client left off.
  const resumed = EventTailResponseSchema.parse(
    JSON.parse((await get(`/p/${problem}/events.json?limit=200`, { "last-event-id": "2" })).text),
  );
  assert.deepEqual(
    resumed.events.map((event) => event.seq),
    reference.filter((seq) => seq > 2),
    "Last-Event-ID resumes after the given sequence",
  );

  // Feeds: one entry per public event, stable IDs, right types.
  const ids = full.events.filter((e) => e.event !== null).map((e) => e.event.id);
  const rss = await revalidates(`/p/${problem}/feed.rss`);
  assert.match(rss.response.headers.get("content-type"), /^application\/rss\+xml/);
  assert.ok(rss.text.includes('<rss version="2.0"'));
  assert.equal((rss.text.match(/<item>/g) ?? []).length, ids.length, "one RSS item per event");
  const atom = await revalidates(`/p/${problem}/feed.atom`);
  assert.match(atom.response.headers.get("content-type"), /^application\/atom\+xml/);
  assert.ok(atom.text.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.equal((atom.text.match(/<entry>/g) ?? []).length, ids.length, "one Atom entry per event");
  const jsonFeed = await revalidates(`/p/${problem}/feed.json`);
  const feed = JSON.parse(jsonFeed.text);
  assert.equal(feed.version, "https://jsonfeed.org/version/1.1");
  assert.equal(feed.items.length, ids.length, "one JSON Feed item per event");
  for (const id of ids) {
    const urn = `urn:asimposium:${problem}:event:${id}`;
    assert.ok(rss.text.includes(urn) && atom.text.includes(urn), `${id} has a stable feed id`);
    assert.ok(feed.items.some((item) => item.id === urn));
  }
  // Negotiated feed honors Accept and says it varies on it.
  const negotiated = await get(`/p/${problem}/feed`, { accept: "application/atom+xml" });
  assert.match(negotiated.response.headers.get("content-type"), /^application\/atom\+xml/);
  assert.match(negotiated.response.headers.get("vary") ?? "", /Accept/i);

  // Export parses and carries every public event.
  const exported = await worker.fetch(`${origin}/p/${problem}/export.jsonl.gz`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(exported.status, 200);
  const exportText = gunzipSync(Buffer.from(await exported.arrayBuffer())).toString("utf8");
  const exportEvents = exportText
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => typeof record.seq === "number");
  assert.equal(exportEvents.length, reference.length, "the export carries every public event");
  bodies.push(exportText);

  for (const body of bodies) {
    assert.ok(!body.includes(CANARY), "no workshop byte reaches any tail, feed or export");
  }

  console.log(
    JSON.stringify({
      stage: "event-tails-journey-passed",
      kind: "event-tails-real-bindings",
      status: "pass",
      events: reference.length,
      formats: ["json", "ndjson", "toon", "rss", "atom", "json-feed", "export"],
      boundary: "local Workerd/D1; no SSE route; no external feed validator; no edge cache",
    }),
  );
});
