import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Herald rooms (beads asimposiumorg-f37v / W7) on real local Workerd with the
// exported HeraldRoom Durable Object, D1 migration 0078 and the production
// heraldRoomFetch/scheduleHeraldDelivery layering. A live sponsor-approved
// Fellow credential upgrades to a WebSocket (101) with the room protocol; a
// committed public write then reaches the open socket. Missing upgrade,
// missing or bogus credentials are refused without a socket.
//
// A database missing migration 0078 refuses the upgrade fail-closed (503
// ROOM_UNAVAILABLE) instead of opening a room no write would ever wake.
//
// Not covered: deployed Durable Object behaviour, hibernation across evictions.

const PROTOCOL = "asimposium.room.v1";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, worker, origin, userAgent, env }) => {
    const OWNER = "usr_herald_owner";
    const author = await enroll("herald-author", OWNER);
    const viewer = await enroll("herald-viewer", "usr_herald_viewer");
    const created = await call(
      "/v1/problems",
      {
        title: "Herald room problem",
        statement: "Every integer in 0..52 has a square of the same parity.",
        falsifier: "An integer in 0..52 whose square has the opposite parity.",
        motivation: "Exercise live Herald rooms.",
        areas: ["number-theory"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const roomUrl = `${origin}/p/${problem}/room?since=0`;
    const open = (headers) =>
      worker.fetch(roomUrl, { headers: { "User-Agent": userAgent, ...headers } });

    // Missing 0078 fails closed. Must run before any successful upgrade: the
    // Worker caches a positive schema check per isolate.
    const heraldObjects = (
      await env.DB.prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'herald_room_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
      ).all()
    ).results;
    assert.equal(heraldObjects.length, 7, "0078 creates one table, one index and five triggers");
    for (const { type, name } of [...heraldObjects].reverse())
      await env.DB.prepare(`DROP ${type.toUpperCase()} "${name}"`).run();
    const unmigrated = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(unmigrated.status, 503, "a database without 0078 refuses the room");
    assert.equal((await unmigrated.json()).code, "ROOM_UNAVAILABLE");
    for (const { sql } of heraldObjects) await env.DB.prepare(sql).run();

    // Refusals: no socket without an upgrade or a live credential.
    assert.equal((await open({ authorization: `Bearer ${viewer}` })).status, 426);
    assert.equal((await open({ upgrade: "websocket" })).status, 401);
    assert.equal(
      (await open({ upgrade: "websocket", authorization: "Bearer asimp_ag_bogus" })).status,
      401,
    );

    // A live Fellow credential upgrades.
    const upgraded = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(upgraded.status, 101, "a live Fellow credential opens the room");
    const socket = upgraded.webSocket;
    assert.ok(socket, "the 101 carries the WebSocket");
    socket.accept();
    const messages = [];
    const closes = [];
    const tails = [];
    const acks = [];
    socket.addEventListener("close", (event) => closes.push(`${event.code}:${event.reason}`));
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      messages.push(text);
      // A well-behaved client reads the advertised event-tail page, then
      // acknowledges (the room refuses acks faster than 250 ms apart).
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return; // heartbeats are not JSON
      }
      if (!frame.acknowledgement) return;
      const tailPath = frame.events;
      void (async () => {
        if (typeof tailPath === "string") {
          const tail = await worker.fetch(`${origin}${tailPath}`, {
            headers: { "User-Agent": userAgent },
          });
          tails.push(tail.status);
          await tail.text();
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (socket.readyState !== 1) return; // the test already closed it
        socket.send(JSON.stringify(frame.acknowledgement));
        acks.push(frame.acknowledgement.ack);
      })();
    });

    // Settle the connection first (resync read and acknowledged), so the
    // notice below can only come from the push path, not an ack reply.
    for (let i = 0; i < 100 && acks.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(acks.length, 1, "the resync was acknowledged");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // A committed public write reaches the open socket.
    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, viewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact.",
      },
      viewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      author,
      201,
    );
    const before = messages.length;
    await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "Zero squared is even in the room.",
        falsifier: "Zero squared is odd.",
      },
      author,
      201,
    );
    for (let i = 0; i < 100 && messages.length === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(messages.length > before, `the room delivered the write: ${messages.slice(0, 3)}`);
    assert.ok(!messages.join("").includes("Private."), "no workshop bytes reach the room");
    assert.deepEqual(closes, [], "a well-behaved client is never closed");
    assert.ok(tails.length >= 1 && tails.every((status) => status === 200), `tail reads: ${tails}`);
    socket.close(1000, "done");

    console.log(
      JSON.stringify({
        stage: "herald-room-journey-passed",
        kind: "herald-room-real-bindings",
        status: "pass",
        messages: messages.length,
        boundary: "local Workerd Durable Object + D1 0078; no deployed room or hibernation claim",
      }),
    );
  },
);
