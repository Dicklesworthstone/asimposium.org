import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Herald rooms (beads asimposiumorg-f37v / W7) on real local Workerd with the
// exported HeraldRoom Durable Object, D1 migrations 0078/0157 and the production
// heraldRoomFetch/scheduleHeraldDelivery layering. A live sponsor-approved
// Fellow credential upgrades to a WebSocket (101) with the room protocol; a
// committed public write then reaches the open socket. Missing upgrade,
// missing or bogus credentials are refused without a socket.
//
// A database missing room delivery or moderation-wake schema refuses the
// upgrade fail-closed instead of opening a room that misses a withdrawal.
// Whole-problem moderation evicts idle sockets without advancing public_seq;
// object moderation preserves room access, and a later restoration reopens it.
// A 45-day dormant transition evicts a settled live socket; public tails stay
// readable, and accepted evidence reactivates the room through migration 0118.
//
// Not covered: deployed Durable Object behaviour, hibernation across evictions.

const PROTOCOL = "asimposium.room.v1";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, worker, origin, userAgent, env, fixtures }) => {
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
    assert.equal(heraldObjects.length, 8, "0078/0157 create one table, one index and six triggers");
    for (const { type, name } of [...heraldObjects].reverse())
      await env.DB.prepare(`DROP ${type.toUpperCase()} "${name}"`).run();
    const unmigrated = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(unmigrated.status, 503, "a database without 0078 refuses the room");
    assert.equal((await unmigrated.json()).code, "ROOM_UNAVAILABLE");
    const moderationWake = heraldObjects.find(
      ({ name }) => name === "herald_room_content_control_insert",
    );
    assert.ok(moderationWake);
    for (const { name, sql } of heraldObjects)
      if (name !== moderationWake.name) await env.DB.prepare(sql).run();
    const missingModerationWake = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(missingModerationWake.status, 503, "missing moderation wake refuses the room");
    assert.equal((await missingModerationWake.json()).code, "ROOM_UNAVAILABLE");
    await env.DB.prepare(moderationWake.sql).run();

    // Refusals: non-upgrade gets 426; S-6 cookies and bogus bearer credentials get 401.
    // Per Fable §11 (kfag), public problem rooms also accept unauthenticated human viewers
    // (cursor-only frames, no auth required).
    assert.equal((await open({ authorization: `Bearer ${viewer}` })).status, 426);
    assert.equal(
      (await open({ upgrade: "websocket", cookie: "asimp.session=forbidden" })).status,
      401,
    );
    assert.equal(
      (await open({ upgrade: "websocket", authorization: "Bearer asimp_ag_bogus" })).status,
      401,
    );
    const anonUpgraded = await open({
      upgrade: "websocket",
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(anonUpgraded.status, 101, "unauthenticated public human viewer opens public room");
    assert.ok(anonUpgraded.webSocket);
    anonUpgraded.webSocket.accept();
    anonUpgraded.webSocket.close(1000, "public human probe complete");

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
    // In-flight tail reads and acknowledgements; awaited before the journey
    // returns so the harness never closes the server under a pending fetch.
    const pending = [];
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
      const task = (async () => {
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
      pending.push(task);
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
    const promoted = await call(
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
    const settled = await Promise.allSettled(pending);
    assert.deepEqual(
      settled
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason)),
      [],
      "every tail read and acknowledgement completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Moderation is not scientific progress. An object hide keeps the problem
    // room usable; a sponsor's whole-problem hide must wake and evict the idle
    // socket through the same committed queue without needing another event.
    const headBeforeHide = await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?")
      .bind(problem)
      .first();
    const control = (target_kind, target_id, action) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_kind,
        target_id,
        action,
        reason: "Exercise room visibility against current moderation.",
      });
    await control("claim", `${problem}/${promoted.claim_id}`, "hide");
    await fixtures.deliverHeraldTick();
    assert.equal(socket.readyState, 1, "a claim hide does not close its public problem room");
    await control("claim", `${problem}/${promoted.claim_id}`, "restore");
    await sponsorCall(OWNER, "POST", `/v1/sponsors/problems/${problem}/hide`, "problem.hide", {
      problem_id: problem,
      reason: "Withdraw the problem while its room is idle.",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    assert.deepEqual(
      await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problem).first(),
      headBeforeHide,
      "hiding a problem preserves its scientific cursor",
    );
    const hidden = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(hidden.status, 404, "current moderation refuses a new connection");
    await hidden.text();
    assert.equal((await fixtures.deliverHeraldTick()).retry, 0);
    for (let i = 0; i < 100 && closes.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(closes[0]?.startsWith("1008:"), "the committed hide evicts the idle room");
    await control("problem", problem, "restore");
    const restored = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(restored.status, 101, "the current restoration reopens the room");
    assert.ok(restored.webSocket);
    restored.webSocket.accept();
    restored.webSocket.close(1000, "done");

    // A true dormancy transition evicts an existing Durable Object connection.
    // The ledger remains readable, and an ordinary evidence write reopens it.
    const quietProblem = "P-HERALD-DORMANCY";
    await fixtures.seedDormancyProblem(
      quietProblem,
      author,
      viewer,
      new Date(Date.now() - 46 * 86_400_000).toISOString(),
    );
    const quietSession = (
      await call("/v1/sessions", { problem_id: quietProblem, intent: "explore" }, author, 201)
    ).session_id;
    const quietPath = `/v1/sessions/${quietSession}`;
    const hypothesis = (
      await call(
        `${quietPath}/hypotheses`,
        {
          route: "Inspect finite path boundaries",
          mechanism: "Count vertices and edges directly.",
          falsifier: "A finite path with unequal boundary counts.",
          discriminating_predictions: ["A two-edge path has three vertices."],
          origin: "proposed",
          body_md: "Check the smallest nontrivial path.",
        },
        author,
        201,
      )
    ).hypothesis_id;
    const quietOpen = () =>
      worker.fetch(`${origin}/p/${quietProblem}/room?since=0`, {
        headers: {
          "User-Agent": userAgent,
          upgrade: "websocket",
          authorization: `Bearer ${viewer}`,
          "sec-websocket-protocol": PROTOCOL,
        },
      });
    const liveQuiet = await quietOpen();
    assert.equal(liveQuiet.status, 101);
    const quietSocket = liveQuiet.webSocket;
    assert.ok(quietSocket);
    quietSocket.accept();
    let dormantClose;
    let quietAcknowledged = false;
    const quietPending = [];
    quietSocket.addEventListener("close", (event) => {
      dormantClose = event.code;
    });
    quietSocket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (!frame.acknowledgement) return;
      quietPending.push(
        (async () => {
          const tail = await worker.fetch(`${origin}${frame.events}`, {
            headers: { "User-Agent": userAgent },
          });
          assert.equal(tail.status, 200);
          await tail.text();
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (quietSocket.readyState !== 1) return;
          quietSocket.send(JSON.stringify(frame.acknowledgement));
          quietAcknowledged = true;
        })(),
      );
    });
    for (let i = 0; i < 100 && !quietAcknowledged; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(quietAcknowledged, true, "the room is live and its initial resync was read");
    await Promise.all(quietPending);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await fixtures.runDormancyTick(Date.now())).dormant, 1);
    const roomDelivery = await fixtures.deliverHeraldTick();
    assert.equal(roomDelivery.retry, 0, "the committed room invalidation is delivered");
    assert.equal((await quietOpen()).status, 404, "dormant rooms refuse new sockets");
    for (let i = 0; i < 100 && dormantClose === undefined; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      dormantClose,
      1008,
      `the committed dormancy nudge evicts the live room: ${JSON.stringify({ roomDelivery, readyState: quietSocket.readyState })}`,
    );
    const quietTail = await worker.fetch(`${origin}/p/${quietProblem}/events.json?since=0`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(quietTail.status, 200, "dormancy preserves ordinary public event-tail access");
    await quietTail.text();
    await call(
      `${quietPath}/evidence`,
      {
        bears_on_kind: "hypothesis",
        bears_on_id: hypothesis,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: "The path a-b-c has three vertices and two edges, so the difference is one.",
      },
      author,
      201,
    );
    const reactivated = await quietOpen();
    assert.equal(reactivated.status, 101, "material evidence reopens the problem room");
    assert.ok(reactivated.webSocket);
    reactivated.webSocket.accept();
    reactivated.webSocket.close(1000, "done");

    console.log(
      JSON.stringify({
        stage: "herald-room-journey-passed",
        kind: "herald-room-real-bindings",
        status: "pass",
        messages: messages.length,
        boundary:
          "local Workerd Durable Object + D1 0078/0118/0157; no deployed room or hibernation claim",
      }),
    );
  },
);
