import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  EventTailNdjsonPageEndSchema,
  EventTailResponseSchema,
  renderEventTail,
} from "../../../../packages/contracts/src/event-tail.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Event-tail formats and feeds on real local Workerd/D1 (bead asimposiumorg-yv6).
// State is caused by real writes. Every format pages to the same ordered,
// gap-free, duplicate-free sequence; NDJSON ends each page with its control
// record; Last-Event-ID resumes; every format and feed revalidates by ETag;
// RSS/Atom/JSON Feed carry one entry per public event with stable IDs; the
// export parses; and a private workshop canary appears in none of them.
//
// SSE pages close after each page; EventSource reconnects with Last-Event-ID.
// A held wait at the head hands off to a concurrent public write.
// Not covered: feed validation by an
// external RSS/Atom validator, edge caching.

const CANARY = "PRIVATE-WORKSHOP-CANARY-7f3a";
const cliMode = process.argv[2] === "cli";
const cliBinary = process.env.ASIMP_WATCH_TEST_BINARY;
if (cliMode) assert.ok(cliBinary, "CLI mode requires the source-bound Rust library test binary");
const execute = promisify(execFile);

function readNdjsonPage(text) {
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const { omitted, ...end } = EventTailNdjsonPageEndSchema.parse(records.pop());
  // The response schema checks canonical JSON links. Normalize just that face
  // for its complete sequence/link validation, then require the original bytes
  // to round-trip through the canonical NDJSON renderer, including its footer.
  const page = EventTailResponseSchema.parse({
    schema: end.schema,
    events: records,
    page_end: {
      ...end,
      next: end.next?.replace("/events.ndjson?", "/events.json?") ?? null,
      poll: end.poll.replace("/events.ndjson?", "/events.json?"),
    },
    omitted,
  });
  assert.equal(renderEventTail(page, "ndjson"), text, "complete canonical NDJSON page");
  return page;
}

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
    // Sponsor commentary between material events: a real problem-scope
    // event that is not a public tail type, so it stays in the sequence as
    // an undisclosed placeholder.
    if (n === 3) {
      await sponsorCall(
        "usr_tails_author",
        "POST",
        `/v1/problems/${problem}/commentary`,
        "post-commentary",
        { problem_id: problem, body: "Sponsor note between claims." },
        201,
      );
    }
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
  // The commentary event stays in the sequence as an undisclosed placeholder
  // ahead of later material events, so the paging below crosses it; feeds
  // carry only the disclosed ones.
  const firstUndisclosed = full.events.findIndex((event) => event.event === null);
  assert.ok(firstUndisclosed >= 0, "the tail carries an undisclosed process event");
  assert.equal(full.events[firstUndisclosed].body_omitted, "undisclosed_event");
  assert.ok(
    full.events.slice(firstUndisclosed + 1).some((event) => event.event !== null),
    "a material event follows the undisclosed one",
  );

  if (cliMode) {
    // Actual HTTP and production Rust reader; only its configured HTTPS origin
    // maps to loopback. Fixture identity/screening are not Google/TLS proof.
    let requests = [];
    const bridge = createServer(async (request, response) => {
      requests.push({
        method: request.method,
        path: request.url,
        ua: request.headers["user-agent"],
        auth: request.headers.authorization,
      });
      const result = await worker.fetch(`${origin}${request.url}`, {
        headers: { "User-Agent": request.headers["user-agent"] ?? "" },
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${bridge.address().port}`;
    try {
      for (const item of [
        { since: 0, limit: 2, json: true },
        { since: firstUndisclosed, limit: 2, json: true },
        { since: 0, limit: 1, json: false },
        { since: full.page_end.next_cursor, limit: 2, json: true },
      ]) {
        const pages = [];
        const paths = [];
        const seen = [];
        let since = item.since;
        let through;
        for (let page = 0; page < 50; page++) {
          const path = `/p/${problem}/events.ndjson?since=${since}&limit=${item.limit}${through === undefined ? "" : `&through=${through}`}`;
          const { stdout } = await execute(
            "curl",
            [
              "--disable",
              "--silent",
              "--show-error",
              "--fail",
              "--max-time",
              "5",
              "--user-agent",
              userAgent,
              `${local}${path}`,
            ],
            { timeout: 6000, maxBuffer: 1024 * 1024 },
          );
          pages.push(stdout);
          paths.push(path);
          bodies.push(stdout);
          const typed = readNdjsonPage(stdout);
          seen.push(...typed.events.map((event) => event.seq));
          since = typed.page_end.next_cursor;
          through = typed.page_end.through;
          if (!typed.page_end.has_more) break;
          assert.ok(page < 49, "the independently fetched snapshot must finish");
        }
        assert.deepEqual(
          seen,
          reference.filter((seq) => seq > item.since),
          "curl snapshot preserves the independently read full sequence, including withheld placeholders",
        );
        requests = [];
        const { stdout } = await execute(
          cliBinary,
          ["--exact", "watch::tests::watch_real_http", "--ignored"],
          {
            env: {
              ...process.env,
              ASIMP_TOKEN: "private-ambient-token-canary",
              ASIMP_WATCH_PROBE: JSON.stringify({
                ...item,
                origin: local,
                problem,
                pages,
                canary: CANARY,
              }),
            },
            timeout: 20000,
            maxBuffer: 256 * 1024,
          },
        ).catch((error) => {
          if (error.stdout) process.stdout.write(error.stdout);
          if (error.stderr) process.stderr.write(error.stderr);
          throw new assert.AssertionError({
            message: `asimp watch diverged for since=${item.since}, limit=${item.limit}, json=${item.json}`,
          });
        });
        assert.match(stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
        assert.deepEqual(
          requests,
          paths.map((path) => ({ method: "GET", path, ua: userAgent, auth: undefined })),
          "the parsed public command follows exactly the pinned pages, without credential or extra reads",
        );
      }
      console.log(
        JSON.stringify({
          stage: "asimp-watch-real-bindings",
          status: "pass",
          cases: 4,
          cursor_snapshot: full.page_end.next_cursor,
          boundary:
            "parsed Rust streaming reader over real Workerd/D1/R2 via explicit loopback mapping; no TLS/Google/staging claim",
        }),
      );
    } finally {
      await new Promise((resolve) => bridge.close(resolve));
    }
  }

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
        assert.equal(lines[0], "id|seq|type|object_id|created_at|caused_by|causality_omitted");
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

  // SSE: page like a browser EventSource, resuming from Last-Event-ID.
  {
    const seen = [];
    let lastId;
    for (let page = 0; page < 50; page++) {
      const { response, text } = await get(`/p/${problem}/events?format=sse&limit=2`, {
        ...(lastId === undefined ? {} : { "last-event-id": lastId }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      assert.ok(text.startsWith("retry: "), "SSE carries a reconnect hint");
      bodies.push(text);
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      seen.push(...ids);
      const end = /^event: page_end\ndata: (.+)$/m.exec(text);
      assert.ok(end, "every SSE page ends with a page_end event");
      const control = JSON.parse(end[1]);
      if (!control.has_more) break;
      lastId = String(ids.at(-1));
    }
    assert.deepEqual(seen, reference, "SSE with Last-Event-ID pages the same sequence");
    const negotiated = await get(`/p/${problem}/events?limit=1`, { accept: "text/event-stream" });
    assert.match(negotiated.response.headers.get("content-type"), /^text\/event-stream/);
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

  // Long-poll handoff: an empty wait at the head returns as soon as a
  // concurrent public write lands, carrying it, well before the wait expires.
  const head = full.page_end.next_cursor;
  const started = Date.now();
  const held = get(`/p/${problem}/events.json?since=${head}&wait=25`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const handoffDraft = await call(
    `/v1/sessions/${session}/workshop`,
    { type: "claim-draft", title: "Handoff", body_md: "Public-bound." },
    author,
    201,
  );
  await call(
    `/v1/sessions/${session}/promote`,
    {
      workshop_id: handoffDraft.workshop_id,
      kind: "conjecture",
      statement: "9 squared is odd, like 9.",
      falsifier: "9 squared is even.",
    },
    author,
    201,
  );
  const handed = await held;
  const elapsed = Date.now() - started;
  assert.equal(handed.response.status, 200);
  assert.equal(handed.response.headers.get("x-asimposium-wait"), "changed");
  const handedBody = EventTailResponseSchema.parse(JSON.parse(handed.text));
  assert.ok(handedBody.events.length >= 1, "the held request returns the new event");
  assert.ok(
    handedBody.events.every((event) => event.seq > head),
    "only events after the waited cursor",
  );
  assert.ok(elapsed < 20_000, `handoff took ${elapsed} ms, before the 25 s wait expired`);
  bodies.push(handed.text);
  // A wait with nothing new ends as a timeout, empty, with a retry hint.
  const quietHead = handedBody.page_end.next_cursor;
  const quiet = await get(`/p/${problem}/events.json?since=${quietHead}&wait=1`);
  assert.equal(quiet.response.headers.get("x-asimposium-wait"), "timeout");
  assert.equal(EventTailResponseSchema.parse(JSON.parse(quiet.text)).events.length, 0);

  if (cliMode) {
    // Exercise the default continuous path with the real site-wide /cursor.
    // After it observes a new committed publication, deliberately close its
    // next read so the infinite watcher terminates with an explicit resume hint.
    const initial = EventTailResponseSchema.parse(
      JSON.parse((await get(`/p/${problem}/events.json?since=0&limit=200`)).text),
    );
    const initialHead = initial.page_end.next_cursor;
    let hintReads = 0;
    let published = false;
    let caughtUp = false;
    let resume = 0;
    let bridgeError;
    const expectedPages = [];
    const cliRequests = [];
    const bridge = createServer(async (request, response) => {
      try {
        const oracle = request.headers["x-asimp-test-oracle"] === "1";
        if (!oracle) {
          cliRequests.push(request.url);
          assert.equal(request.method, "GET");
          assert.equal(request.headers.authorization, undefined);
          assert.equal(request.headers["user-agent"], userAgent);
          if (request.url === "/cursor") {
            hintReads++;
            if (caughtUp) {
              request.destroy();
              return;
            }
            if (hintReads === 2) {
              const draft = await call(
                `/v1/sessions/${session}/workshop`,
                {
                  type: "claim-draft",
                  title: "Live reader update",
                  body_md: "Public-bound live update.",
                },
                author,
                201,
              );
              await call(
                `/v1/sessions/${session}/promote`,
                {
                  workshop_id: draft.workshop_id,
                  kind: "conjecture",
                  statement: "11 squared is odd, like 11.",
                  falsifier: "11 squared is even.",
                },
                author,
                201,
              );
              published = true;
            }
          }
        }
        const result = await worker.fetch(`${origin}${request.url}`, {
          headers: { "User-Agent": userAgent },
        });
        const bytes = Buffer.from(await result.arrayBuffer());
        if (!oracle && request.url.startsWith(`/p/${problem}/events.ndjson?`)) {
          assert.equal(result.status, 200);
          const { stdout } = await execute(
            "curl",
            [
              "--disable",
              "--silent",
              "--show-error",
              "--fail",
              "--max-time",
              "5",
              "--user-agent",
              userAgent,
              "--header",
              "x-asimp-test-oracle: 1",
              `http://127.0.0.1:${bridge.address().port}${request.url}`,
            ],
            { timeout: 6000, maxBuffer: 1024 * 1024 },
          );
          assert.equal(bytes.toString(), stdout, "live page is stable against independent curl");
          expectedPages.push(stdout);
          bodies.push(stdout);
          const typed = readNdjsonPage(stdout);
          resume = typed.page_end.next_cursor;
          caughtUp = published && resume > initialHead && !typed.page_end.has_more;
        }
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(bytes);
      } catch (error) {
        bridgeError = error;
        response.writeHead(500);
        response.end("Test bridge failed.");
      }
    });
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    try {
      const { stdout } = await execute(
        cliBinary,
        ["--exact", "watch::tests::watch_real_http", "--ignored", "--nocapture"],
        {
          env: {
            ...process.env,
            ASIMP_TOKEN: "private-ambient-token-canary",
            ASIMP_WATCH_PROBE: JSON.stringify({
              origin: `http://127.0.0.1:${bridge.address().port}`,
              problem,
              since: 0,
              limit: 2,
              json: true,
              live: true,
              canary: CANARY,
            }),
          },
          timeout: 20000,
          maxBuffer: 256 * 1024,
        },
      );
      if (bridgeError) throw bridgeError;
      assert.match(stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
      const encoded = /^ASIMP_WATCH_BYTES=(.+)$/m.exec(stdout)?.[1];
      assert.ok(encoded, "the live reader must return its actual public bytes");
      assert.equal(Buffer.from(encoded, "base64url").toString(), expectedPages.join(""));
      assert.ok(
        published && caughtUp && resume > initialHead,
        "the live reader observes the real committed publication",
      );
      assert.match(
        stdout,
        new RegExp(`ASIMP_WATCH_RESUME=Resume the same watch command with --since ${resume}\\.`),
      );
      assert.equal(
        cliRequests[0],
        "/cursor",
        "capture the global hint before the first problem snapshot",
      );
      assert.ok(
        hintReads >= 3,
        "initial hint, publication wake, and deliberate final read failure all execute",
      );
      assert.ok(
        cliRequests.every(
          (path) => path === "/cursor" || path.startsWith(`/p/${problem}/events.ndjson?`),
        ),
        "only mounted public read routes are used",
      );
      console.log(
        JSON.stringify({
          stage: "asimp-watch-live-real-bindings",
          status: "pass",
          hint_reads: hintReads,
          resume_cursor: resume,
          termination: "deliberately closed bridge after observed publication",
        }),
      );
    } finally {
      await new Promise((resolve) => bridge.close(resolve));
    }
  }

  for (const body of bodies) {
    assert.ok(!body.includes(CANARY), "no workshop byte reaches any tail, feed or export");
  }

  console.log(
    JSON.stringify({
      stage: "event-tails-journey-passed",
      kind: "event-tails-real-bindings",
      status: "pass",
      events: reference.length,
      formats: ["json", "ndjson", "toon", "sse", "rss", "atom", "json-feed", "export"],
      long_poll: "changed-and-timeout",
      boundary:
        "local Workerd/D1; SSE pages end per page (no held stream); no external feed validator; no edge cache",
    }),
  );
});
