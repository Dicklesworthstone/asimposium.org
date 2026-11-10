import assert from "node:assert/strict";
import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Real HTTP, Workerd and migrated D1 admission. Sponsor approval and empty
// problems are fixtures. A bounded timestamp fixture makes the final-slot
// race independent of machine speed; expiry is advanced explicitly, not slept.
await runLocalWorkerJourney(
  async ({ call, enroll, fixtures, env, worker, origin, userAgent }) => {
    const sponsor = "usr_read_quota";
    const token = await enroll("read-quota-author", sponsor);
    const peer = await enroll("read-quota-peer", sponsor);
    const problems = ["P-READ-QUOTA", "P-READ-QUOTA-OTHER"];
    for (const problem of problems) await fixtures.seedProblem(problem, sponsor);
    const sessions = [];
    for (const problem of problems) {
      sessions.push(
        await call("/v1/sessions", { problem_id: problem, intent: "explore" }, token, 201),
      );
    }

    const request = async (path, credential = token, options = {}) => {
      const response = await worker.fetch(`${origin}${path}`, {
        method: options.method ?? "GET",
        headers: {
          "User-Agent": userAgent,
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(options.headers ?? {}),
        },
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        text,
        json: text.startsWith("{") ? JSON.parse(text) : null,
      };
    };
    let reads = 0;
    const admitted = (response, status = 200) => {
      reads += 1;
      assert.equal(
        response.status,
        status,
        `read ${reads}: ${JSON.stringify({
          code: response.json?.code,
          title: response.json?.title,
          detail: response.json?.detail,
        })}`,
      );
      assert.equal(response.headers.get("ratelimit-limit"), "120");
      assert.equal(response.headers.get("ratelimit-remaining"), String(120 - reads));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    };
    const first = await request("/v1/hello");
    admitted(first);
    const hello = EnrollmentHelloResponseSchema.parse(first.json);
    const fellowId = hello.fellow.fellow_id;
    assert.deepEqual(hello.read_budget, { limit: 120, remaining: 119, window_seconds: 60 });
    const window = async () => {
      const row = await env.DB.prepare(
        "SELECT admitted_at_json FROM fellow_read_windows WHERE fellow_id = ?",
      )
        .bind(fellowId)
        .first();
      return JSON.parse(row.admitted_at_json);
    };
    const seedWindow = async (timestamps) => {
      await env.DB.prepare(
        "UPDATE fellow_read_windows SET admitted_at_json = ? WHERE fellow_id = ?",
      )
        .bind(JSON.stringify(timestamps), fellowId)
        .run();
    };

    const timestampTypes = await env.DB.prepare(`SELECT item.type
      FROM fellow_read_windows, json_each(admitted_at_json) AS item
      WHERE fellow_id = ?`)
      .bind(fellowId)
      .all();
    assert.deepEqual(
      timestampTypes.results.map((row) => row.type),
      ["integer"],
      "D1 reservations store canonical integer timestamps for subsequent admissions",
    );

    const triage = await request("/v1/triage");
    admitted(triage);
    assert.equal(
      triage.json.hello.read_budget.remaining,
      118,
      "internal hello is not charged twice",
    );
    const markdown = await request("/v1/triage.md");
    admitted(markdown);
    assert.match(markdown.headers.get("content-type"), /^text\/markdown/);
    admitted(await request("/v1/triage", token, { headers: { accept: "text/markdown" } }));
    admitted(await request(`/v1/p/${problems[0]}/next`));
    admitted(await request(`/v1/p/${problems[0]}/next.md`));

    const pack = `/v1/sessions/${sessions[0].session_id}/pack?profile=digest&max_tokens=800`;
    const deltaPack = `/v1/sessions/${sessions[0].session_id}/pack?profile=orient&max_tokens=800&since=0`;
    const otherPack = `/v1/sessions/${sessions[1].session_id}/pack?profile=digest&max_tokens=800`;
    const packed = await request(pack);
    admitted(packed);
    const etag = packed.headers.get("etag");
    assert.ok(etag);
    const conditional = await request(pack, token, { headers: { "if-none-match": etag } });
    admitted(conditional, 304);
    assert.equal(conditional.text, "");
    const head = await request(pack, token, { method: "HEAD" });
    admitted(head);
    assert.equal(head.text, "");
    admitted(await request(deltaPack));
    admitted(await request(otherPack));
    assert.equal((await window()).length, reads, "all routes share one admission window");
    const beforeInvalid = await window();
    assert.equal((await request("/v1/hello", "invalid-read-credential")).status, 401);
    assert.deepEqual(
      await window(),
      beforeInvalid,
      "unauthenticated reads allocate no Fellow allowance",
    );

    // Seed only operational timestamps. The eight concurrent requests below
    // run the actual mounted routes and compete for the final two D1 slots.
    await seedWindow(Array(118).fill(Date.now()));
    const paths = [
      "/v1/hello",
      "/v1/triage",
      "/v1/triage.md",
      `/v1/p/${problems[0]}/next`,
      `/v1/p/${problems[0]}/next.md`,
      pack,
      deltaPack,
      otherPack,
    ];
    const outcomes = await Promise.all(paths.map((path) => request(path)));
    assert.equal(outcomes.filter((response) => response.status === 200).length, 2);
    assert.equal(outcomes.filter((response) => response.status === 429).length, 6);
    const limited = (response) => {
      assert.equal(response.status, 429);
      assert.equal(response.json.code, "RATE_LIMITED");
      assert.equal(response.json.limit, 120);
      assert.equal(response.json.remaining, 0);
      assert.equal(response.json.window_seconds, 60);
      assert.ok(response.json.retry_after_seconds >= 1 && response.json.retry_after_seconds <= 60);
      assert.equal(response.headers.get("retry-after"), String(response.json.retry_after_seconds));
      assert.equal(response.headers.get("ratelimit-limit"), "120");
      assert.equal(response.headers.get("ratelimit-remaining"), "0");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    };
    for (const response of outcomes) if (response.status === 429) limited(response);
    assert.equal((await window()).length, 120);
    for (const path of paths) limited(await request(path));
    const limitedHead = await request(pack, token, { method: "HEAD" });
    assert.equal(limitedHead.status, 429);
    assert.equal(limitedHead.headers.get("ratelimit-remaining"), "0");
    assert.equal(limitedHead.text, "");
    assert.equal((await window()).length, 120, "refused requests do not grow the stored window");

    const peerHello = EnrollmentHelloResponseSchema.parse((await request("/v1/hello", peer)).json);
    assert.equal(peerHello.read_budget.remaining, 119, "another Fellow has independent capacity");
    const publicPath = `/p/${problems[0]}/events.json?since=0`;
    assert.equal((await request(publicPath, null)).status, 200);
    assert.equal(
      (await request(publicPath)).status,
      200,
      "a bearer header does not throttle public reads",
    );
    await call(
      `/v1/sessions/${sessions[0].session_id}/workshop`,
      {
        type: "scratch",
        title: "Private work while the read allowance replenishes",
        body_md: "Private finite-case notes retained while the read allowance replenishes.",
      },
      token,
      201,
    );
    assert.equal(
      (await window()).length,
      120,
      "public reads and workshop writes use no read slots",
    );

    await seedWindow([Date.now() - 60_001]);
    const recovered = await request("/v1/hello");
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.read_budget.remaining, 119);
    assert.equal((await window()).length, 1, "expired timestamps are pruned at admission");

    // Malformed operational state must not silently reset the allowance.
    await seedWindow(["invalid-timestamp"]);
    const malformed = await request("/v1/hello");
    assert.equal(malformed.status, 503);
    assert.equal(malformed.json.code, "INTERNAL_ERROR");
    assert.deepEqual(await window(), ["invalid-timestamp"]);
    await seedWindow([Date.now() - 60_001]);
    await env.DB.prepare(`CREATE TRIGGER read_quota_storage_fault
      BEFORE INSERT ON fellow_read_windows BEGIN
        SELECT RAISE(ABORT, 'local read quota storage fault');
      END`).run();
    const fault = await request(pack);
    assert.equal(fault.status, 503);
    assert.equal(fault.json.code, "INTERNAL_ERROR");
    assert.equal(fault.headers.get("cache-control"), "private, no-store");
    assert.equal(
      (await request(publicPath, null)).status,
      200,
      "public reads survive quota-store faults",
    );

    console.log(
      JSON.stringify({
        kind: "read-quota-real-bindings",
        status: "pass",
        rolling_limit: 120,
        concurrent_final_slots: { admitted: 2, refused: 6 },
        shared_hello_triage_next_pack_delta_budget: true,
        head_and_conditional_count_once: true,
        public_reads_and_workshop_remain_available: true,
        peer_isolation_and_expiry_recovery: true,
        malformed_and_unavailable_store_fail_closed: true,
        proof_scope:
          "local Workerd/D1/R2; fixture approval, capacity fill and expiry; no deployed claim",
      }),
    );
  },
  { projectionParitySeeded: (problem) => problem.startsWith("P-READ-QUOTA") },
);
