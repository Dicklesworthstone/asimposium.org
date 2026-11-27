import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Herald rooms (beads asimposiumorg-f37v / W7) on real local Workerd with the
// exported HeraldRoom Durable Object, D1 migrations 0078/0157/0164 and the production
// heraldRoomFetch/scheduleHeraldDelivery layering. A live sponsor-approved
// Fellow credential upgrades to a WebSocket (101) with the room protocol; a
// committed public write then reaches the open socket. Missing upgrade,
// missing or bogus credentials are refused without a socket.
//
// A database missing room delivery or moderation-wake schema refuses the
// upgrade fail-closed instead of opening a room that misses a withdrawal.
// Whole-problem moderation evicts idle sockets without advancing public_seq;
// object moderation preserves room access and refreshes WS/SSE readers without
// inventing an event. A later whole-problem restoration reopens the room.
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
    assert.equal(
      heraldObjects.length,
      9,
      "0078/0157/0164 create one table, one index and seven triggers",
    );
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
    const objectWake = heraldObjects.find(
      ({ name }) => name === "herald_room_object_control_insert",
    );
    assert.ok(moderationWake);
    assert.ok(objectWake);
    for (const { name, sql } of heraldObjects)
      if (name !== moderationWake.name && name !== objectWake.name) await env.DB.prepare(sql).run();
    const missingModerationWake = await open({
      upgrade: "websocket",
      authorization: `Bearer ${viewer}`,
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(missingModerationWake.status, 503, "missing moderation wake refuses the room");
    assert.equal((await missingModerationWake.json()).code, "ROOM_UNAVAILABLE");
    await env.DB.prepare(moderationWake.sql).run();
    const missingObjectWake = await open({
      upgrade: "websocket",
      "sec-websocket-protocol": PROTOCOL,
    });
    assert.equal(missingObjectWake.status, 503, "missing object visibility wake refuses the room");
    assert.equal((await missingObjectWake.json()).code, "ROOM_UNAVAILABLE");
    const missingSseWake = await worker.fetch(`${origin}/p/${problem}/room/sse`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(missingSseWake.status, 503, "SSE cannot accept a stream that misses object hides");
    assert.equal((await missingSseWake.json()).code, "ROOM_UNAVAILABLE");
    await env.DB.prepare(objectWake.sql).run();

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

    // Moderation is not scientific progress. An object hide keeps the room
    // usable but must refresh both WS and SSE readers at the same event cursor.
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
    const streamAbort = new AbortController();
    const stream = await worker.fetch(`${origin}/p/${problem}/room/sse`, {
      headers: { "User-Agent": userAgent },
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    const streamReader = stream.body.getReader();
    const decoder = new TextDecoder();
    const streamNotices = [];
    let streamBytes = "";
    let streamError;
    const streamRead = (async () => {
      try {
        let buffer = "";
        while (true) {
          const part = await streamReader.read();
          if (part.done) return;
          const text = decoder.decode(part.value, { stream: true });
          streamBytes += text;
          buffer += text;
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.startsWith("event: resync\n")) continue;
            streamNotices.push(JSON.parse(frame.split("\ndata: ")[1]));
          }
        }
      } catch (error) {
        if (!streamAbort.signal.aborted) streamError = error;
      }
    })();
    const waitForNotice = async (predicate, message) => {
      for (let i = 0; i < 100 && !predicate(); i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(predicate(), message);
      assert.equal(streamError, undefined, "the live SSE stream remains readable");
    };
    try {
      await waitForNotice(
        () => streamNotices.length === 1,
        "SSE announces its current public head",
      );
      const privateBefore = [messages.length, streamNotices.length];
      await call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "scratch",
          title: "Private room isolation control",
          body_md: "PRIVATE-HERALD-VISIBILITY-CANARY",
        },
        author,
        201,
      );
      await fixtures.deliverHeraldTick();
      await new Promise((resolve) => setTimeout(resolve, 1700));
      assert.deepEqual(
        [messages.length, streamNotices.length],
        privateBefore,
        "a private workshop push must not wake either public subscriber",
      );

      for (const action of ["hide", "restore"]) {
        const beforeControl = [messages.length, streamNotices.length];
        await control("claim", `${problem}/${promoted.claim_id}`, action);
        await fixtures.deliverHeraldTick();
        await waitForNotice(
          () => messages.length > beforeControl[0] && streamNotices.length > beforeControl[1],
          `claim ${action} refreshes both live transports without another scientific event`,
        );
        assert.equal(socket.readyState, 1, `claim ${action} preserves its public problem room`);
        assert.equal(JSON.parse(messages.at(-1)).through, headBeforeHide.public_seq);
        assert.equal(streamNotices.at(-1).through, headBeforeHide.public_seq);
        assert.deepEqual(
          await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?")
            .bind(problem)
            .first(),
          headBeforeHide,
          "object visibility does not manufacture scientific progress",
        );
        const face = await worker.fetch(`${origin}/p/${problem}/claims/${promoted.claim_id}.json`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(
          face.status,
          action === "hide" ? 403 : 200,
          `a ${action} notification leads to the current authoritative reader`,
        );
        const faceText = await face.text();
        if (action === "hide") {
          assert.equal(JSON.parse(faceText).code, "CONTENT_HIDDEN");
          assert.ok(!faceText.includes("Zero squared is even in the room."));
        } else {
          assert.ok(faceText.includes("Zero squared is even in the room."));
        }
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      for (const bytes of [messages.join("\n"), streamBytes]) {
        assert.ok(!bytes.includes("PRIVATE-HERALD-VISIBILITY-CANARY"));
        assert.ok(!bytes.includes("Zero squared is even in the room."));
        assert.ok(!bytes.includes("Exercise room visibility"));
      }
      // A whole-problem hide must still wake and evict both idle transports.
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
      await waitForNotice(
        () =>
          closes.length > 0 &&
          streamBytes.includes('event: closed\ndata: {"reason":"access-ended"}'),
        "the committed hide evicts both idle public transports",
      );
      assert.ok(closes[0]?.startsWith("1008:"));
      await streamRead;
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
    } finally {
      streamAbort.abort();
      await streamReader.cancel().catch(() => {});
      await streamRead;
      streamReader.releaseLock();
    }

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

    // Private SSE and WebSockets share one Durable Object and one durable
    // ticket replay guard. Only scope, never capability secrets, enters URLs.
    const authorFellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
      .bind(session)
      .first();
    const viewerFellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
      .bind(reviewSession)
      .first();
    assert.ok(authorFellow && viewerFellow);
    const workshopScope = { fellow_id: authorFellow.fellow_id, problem_id: problem };
    const ticketFor = (sponsor = OWNER, scope = workshopScope, expected = 200) =>
      sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/workshop/room-ticket",
        "workshop.read",
        scope,
        expected,
      );
    const privateUrl =
      origin +
      "/v1/workshop-room?" +
      new URLSearchParams({ fellow: authorFellow.fellow_id, problem });
    const agoraOrigin = "https://staging.asimposium.org";
    const privateOpen = (ticket, extraHeaders = {}) =>
      worker.fetch(privateUrl, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          origin: agoraOrigin,
          accept: "text/event-stream",
          "content-type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(ticket === undefined ? {} : { auth: ticket }),
      });
    const deadline = async (operation) => {
      let timer;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Workshop stream deadline")), 8000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const preflight = await worker.fetch(privateUrl, {
      method: "OPTIONS",
      headers: {
        origin: agoraOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), agoraOrigin);
    assert.equal(preflight.headers.has("access-control-allow-credentials"), false);
    assert.equal((await privateOpen()).status, 401, "anonymous stream has no private access");
    await ticketFor("usr_herald_viewer", workshopScope, 404);
    const otherTicket = await ticketFor("usr_herald_viewer", {
      fellow_id: viewerFellow.fellow_id,
      problem_id: problem,
    });
    assert.equal(
      (await privateOpen(otherTicket.ticket)).status,
      401,
      "another sponsor's valid ticket cannot select this Fellow",
    );
    const minted = await ticketFor();
    assert.equal(
      (await privateOpen(minted.ticket, { origin: "https://outside.invalid" })).status,
      401,
    );
    assert.equal((await privateOpen(minted.ticket, { cookie: "session=forbidden" })).status, 401);
    assert.equal(
      (await privateOpen(minted.ticket, { authorization: "Bearer " + author })).status,
      401,
    );
    const streamed = await privateOpen(minted.ticket);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(streamed.headers.get("cache-control"), "private, no-store");
    assert.equal(streamed.headers.get("access-control-allow-origin"), agoraOrigin);
    assert.equal(streamed.headers.has("access-control-allow-credentials"), false);
    assert.ok(streamed.body);
    const privateReader = streamed.body.getReader();
    let pendingFrame = "";
    const privateFrames = [];
    const nextFrame = async () =>
      deadline(
        (async () => {
          while (true) {
            const boundary = pendingFrame.indexOf("\n\n");
            if (boundary !== -1) {
              const frame = pendingFrame.slice(0, boundary);
              pendingFrame = pendingFrame.slice(boundary + 2);
              const event = /^event: (.+)$/m.exec(frame)?.[1];
              const raw = /^data: (.+)$/m.exec(frame)?.[1];
              if (!event || !raw) continue;
              privateFrames.push(frame);
              return { event, data: JSON.parse(raw) };
            }
            const part = await privateReader.read();
            assert.equal(part.done, false, "private room stays open until a bounded close");
            pendingFrame += new TextDecoder().decode(part.value);
          }
        })(),
      );
    try {
      const first = await nextFrame();
      assert.equal(first.event, "workshop-update");
      assert.equal(first.data.fellow_id, authorFellow.fellow_id);
      assert.equal(first.data.problem_id, problem);
      assert.equal(first.data.workshop_cursor, minted.workshop_cursor);
      assert.equal(
        (await privateOpen(minted.ticket)).status,
        401,
        "SSE cannot replay its consumed ticket",
      );
      const openPrivateSocket = async () => {
        const response = await worker.fetch(privateUrl, {
          headers: {
            "User-Agent": userAgent,
            upgrade: "websocket",
            "sec-websocket-protocol": PROTOCOL,
          },
        });
        assert.equal(response.status, 101);
        assert.ok(response.webSocket);
        response.webSocket.accept();
        return response.webSocket;
      };
      const replay = await openPrivateSocket();
      const replayMessages = [];
      replay.addEventListener("message", (event) => replayMessages.push(String(event.data)));
      const replayClosed = new Promise((resolve) =>
        replay.addEventListener("close", (event) => resolve(event.code)),
      );
      replay.send(JSON.stringify({ auth: minted.ticket }));
      assert.equal(
        await deadline(replayClosed),
        1008,
        "a ticket consumed by SSE also refuses WebSocket replay",
      );
      assert.deepEqual(replayMessages, []);
      const wsTicket = await ticketFor();
      const privateSocket = await openPrivateSocket();
      try {
        const connected = new Promise((resolve) =>
          privateSocket.addEventListener("message", (event) => resolve(String(event.data))),
        );
        privateSocket.send(JSON.stringify({ auth: wsTicket.ticket }));
        assert.equal(JSON.parse(await deadline(connected)).control, "workshop-update");
        assert.equal(
          (await privateOpen(wsTicket.ticket)).status,
          401,
          "SSE refuses a ticket already consumed by WebSocket",
        );
      } finally {
        privateSocket.close(1000, "transport replay check complete");
      }
      const privateCanary = "PRIVATE_WORKSHOP_SSE_BODY_MUST_NEVER_STREAM";
      await call(
        "/v1/sessions/" + session + "/workshop",
        {
          type: "note",
          title: "Private stream update",
          body_md: privateCanary,
        },
        author,
        201,
      );
      const updated = await nextFrame();
      assert.equal(updated.event, "workshop-update");
      assert.ok(updated.data.workshop_cursor > first.data.workshop_cursor);
      assert.deepEqual(Object.keys(updated.data).sort(), [
        "control",
        "fellow_id",
        "heartbeat",
        "problem_id",
        "schema",
        "workshop_cursor",
      ]);
      assert.ok(
        !privateFrames.join("").includes(privateCanary),
        "even the authorized stream carries no private work product",
      );
      await sponsorCall(OWNER, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
        fellow_id: authorFellow.fellow_id,
        status: "revoked",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      });
      assert.deepEqual(await nextFrame(), { event: "closed", data: { reason: "access-ended" } });
      assert.equal(
        (await deadline(privateReader.read())).done,
        true,
        "current revocation closes the live stream",
      );
      await ticketFor(OWNER, workshopScope, 404);
    } finally {
      await privateReader.cancel();
      privateReader.releaseLock();
    }

    console.log(
      JSON.stringify({
        stage: "herald-room-journey-passed",
        kind: "herald-room-real-bindings",
        status: "pass",
        messages: messages.length,
        boundary:
          "local Workerd Durable Object + D1 0078/0118/0157/0164; public WS/SSE object hide/restore resync and whole-problem eviction, private WS/SSE replay, cursor-only update, and revocation; no deployed room or hibernation claim",
      }),
    );
  },
);
