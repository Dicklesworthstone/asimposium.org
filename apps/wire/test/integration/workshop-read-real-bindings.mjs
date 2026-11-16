import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import {
  FullPackPageSchema,
  InboxResponseSchema,
  LeaseAcquireResponseSchema,
  LeaseListResponseSchema,
  PackResponseSchema,
  ProblemNextResponseSchema,
  SponsorWorkshopViewSchema,
  WorkshopObjectResponseSchema,
} from "@asimposium/contracts";
import { WorkshopDirectoryResponseSchema } from "@asimposium/contracts/workshop-directory";
import { createInboxNotice } from "../../src/inbox/store.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const cliLoopMode = process.argv[2] === "cli-loop";
const cliMode = process.argv[2] === "cli" || cliLoopMode;
const execute = promisify(execFile);
if (cliMode)
  assert.ok(
    process.env.ASIMP_WORKSHOP_TEST_BINARY,
    "CLI mode requires the built Rust library test binary",
  );

// Actual Workerd, D1, private R2 and signed sponsor reads. Enrollment approval
// and the already-active problems are explicit fixtures; no Google/live claim.
await runLocalWorkerJourney(
  async ({ call, enroll, fixtures, env, worker, origin, userAgent, sponsorCall }) => {
    // Each CLI mode owns one native runtime. Run `cli` and `cli-loop` in
    // separate processes rather than reusing a disposed Wrangler harness.
    if (cliLoopMode)
      return cliCoordinationJourney({ call, enroll, sponsorCall, worker, origin, userAgent, env });
    const sponsor = "usr_sponsor_problems";
    const token = await enroll("workshop-reader", sponsor);
    const peer = await enroll("workshop-peer", sponsor);
    const stranger = await enroll("workshop-stranger", "usr_workshop_stranger");
    const problem = "P-WORKSHOP-READ";
    await fixtures.seedProblem(problem, sponsor);
    await fixtures.seedProblem("P-WORKSHOP-OTHER", sponsor);
    const open = (credential, problemId = problem) =>
      call("/v1/sessions", { problem_id: problemId, intent: "explore" }, credential, 201);
    const session = await open(token);
    const peerSession = await open(peer);
    const strangerSession = await open(stranger);
    const otherProblemSession = await open(token, "P-WORKSHOP-OTHER");
    const fellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
      .bind(session.session_id)
      .first();
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    const bodies = [
      "Private finite-path notes.",
      `\uFEFFPrivate symbols α ∀ 𝑥.\n${"A deliberate work product; no transcript.\n".repeat(100)}`,
    ];
    const editedBody = "Private finite-path notes, with the boundary case corrected.";
    const drafts = [];
    const revision = {
      claim_id: "C-1",
      base_version: 1,
      kind: "conjecture",
      statement: "A finite path with n edges has n + 1 vertices.",
      falsifier: "A finite path with another vertex count.",
      depends_on: [],
    };
    // W2.1 (jfi): each (fellow, problem) workshop cursor advances on its own.
    // The same Fellow on another problem and another Fellow on this problem
    // keep their cursors while this pair pushes, and vice versa.
    const cursorOf = async (context, credential) =>
      (await call(`/v1/sessions/${context.session_id}`, undefined, credential)).workshop_cursor;
    const cursorsBefore = {
      here: await cursorOf(session, token),
      otherProblem: await cursorOf(otherProblemSession, token),
      otherFellow: await cursorOf(peerSession, peer),
    };
    for (const [index, body_md] of bodies.entries()) {
      drafts.push(
        await call(
          `/v1/sessions/${session.session_id}/workshop`,
          {
            type: index === 0 ? "claim-draft" : "dead-end-draft",
            title: "Private work to resume",
            body_md,
            relates_to: ["C-1"],
            ...(index === 0 ? { revision } : {}),
          },
          token,
          201,
        ),
      );
    }
    assert.deepEqual(
      {
        here: await cursorOf(session, token),
        otherProblem: await cursorOf(otherProblemSession, token),
        otherFellow: await cursorOf(peerSession, peer),
      },
      { ...cursorsBefore, here: cursorsBefore.here + bodies.length },
      "pushes on this (fellow, problem) advance only its own workshop cursor",
    );
    await call(
      `/v1/sessions/${otherProblemSession.session_id}/workshop`,
      { type: "claim-draft", title: "Cursor independence control", body_md: bodies[0] },
      token,
      201,
    );
    assert.deepEqual(
      {
        here: await cursorOf(session, token),
        otherProblem: await cursorOf(otherProblemSession, token),
        otherFellow: await cursorOf(peerSession, peer),
      },
      {
        here: cursorsBefore.here + bodies.length,
        otherProblem: cursorsBefore.otherProblem + 1,
        otherFellow: cursorsBefore.otherFellow,
      },
      "the same Fellow's push on another problem advances only that cursor",
    );
    // Another Fellow on this same problem: its push advances its own cursor by
    // exactly one (a counter shared per problem would number it after ours).
    await call(
      `/v1/sessions/${peerSession.session_id}/workshop`,
      { type: "claim-draft", title: "Peer cursor independence control", body_md: bodies[0] },
      peer,
      201,
    );
    assert.deepEqual(
      {
        here: await cursorOf(session, token),
        otherProblem: await cursorOf(otherProblemSession, token),
        otherFellow: await cursorOf(peerSession, peer),
      },
      {
        here: cursorsBefore.here + bodies.length,
        otherProblem: cursorsBefore.otherProblem + 1,
        otherFellow: cursorsBefore.otherFellow + 1,
      },
      "another Fellow's push on the same problem advances only its own cursor",
    );
    const pathFor = (draft, context = session) =>
      `/v1/sessions/${context.session_id}/workshop/${draft.workshop_id}`;
    let cliReads = 0;
    let cliNextReads = 0;
    const cliStatuses = { 200: 0, 400: 0, 401: 0, 404: 0, 500: 0 };
    async function verifyCli(path, credential, status, body, nextProbe) {
      // A real loopback HTTP bridge forwards unchanged GETs to the actual
      // Worker. Rust maps only its test origin here; production stays HTTPS.
      let requests = 0;
      let bridgeFailure;
      const bridge = createServer(async (request, response) => {
        try {
          requests++;
          assert.equal(request.method, "GET");
          assert.equal(request.url, path);
          assert.ok(
            request.headers.authorization === `Bearer ${credential}`,
            "CLI must send its probe credential",
          );
          assert.equal(request.headers["user-agent"], userAgent);
          const result = await worker.fetch(`${origin}${request.url}`, {
            headers: { authorization: request.headers.authorization, "User-Agent": userAgent },
          });
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          bridgeFailure = error;
          response.writeHead(500);
          response.end();
        }
      });
      try {
        await new Promise((resolve, reject) => {
          bridge.once("error", reject);
          bridge.listen(0, "127.0.0.1", resolve);
        });
        const target = new URL(path, origin);
        const parts = target.pathname.split("/");
        const probe = {
          origin: `http://127.0.0.1:${bridge.address().port}`,
          session: parts[3],
          workshop: parts[5],
          version: target.searchParams.get("version"),
          token: credential,
          status,
          body,
          ...nextProbe,
        };
        const { stdout, stderr } = await execute(
          process.env.ASIMP_WORKSHOP_TEST_BINARY,
          ["--exact", "tests::workshop_recovery_real_http", "--ignored"],
          {
            env: { ...process.env, ASIMP_WORKSHOP_PROBE: JSON.stringify(probe) },
            timeout: 20000,
            maxBuffer: 128 * 1024,
          },
        ).catch((error) => {
          if (error.stderr) process.stderr.write(error.stderr);
          if (error.stdout) process.stdout.write(error.stdout);
          throw new Error("Rust workshop HTTP probe failed");
        });
        if (stderr) process.stderr.write(stderr);
        assert.match(stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
        assert.equal(
          bridgeFailure,
          undefined,
          "CLI request must cross the exact authorized HTTP bridge",
        );
        assert.equal(requests, 1);
        if (nextProbe) {
          cliNextReads++;
        } else {
          cliReads++;
          cliStatuses[status]++;
        }
      } finally {
        bridge.closeAllConnections();
        await new Promise((resolve, reject) =>
          bridge.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    async function read(path, credential, status = 200, method = "GET", etag) {
      const response = await worker.fetch(`${origin}${path}`, {
        method,
        headers: {
          "User-Agent": userAgent,
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(etag ? { "if-none-match": etag } : {}),
        },
      });
      const body = await response.text();
      assert.equal(response.status, status, `private read status; response digest=${sha(body)}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      if (method === "HEAD" || status === 304) assert.equal(body, "");
      if (status >= 400) {
        for (const privateBody of [...bodies, editedBody]) assert.ok(!body.includes(privateBody));
        assert.ok(!body.includes(token) && !body.includes("cas/sha256/"));
        assert.equal(response.headers.get("etag"), null);
      }
      if (
        cliMode &&
        credential &&
        method === "GET" &&
        !etag &&
        (!path.includes("?") || /^\?version=[^&]*$/.test(new URL(path, origin).search)) &&
        [200, 400, 401, 404, 500].includes(status)
      ) {
        await verifyCli(path, credential, status, body);
      }
      return { response, body, data: body ? JSON.parse(body) : null };
    }
    const before = await call("/cursor");
    const eventsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first();
    const publicBefore = await env.PUBLIC_ARTIFACTS.list();
    const privateBefore = await env.ARTIFACTS.list();
    const next = ProblemNextResponseSchema.parse(
      await call(`/v1/p/${problem}/next`, undefined, token),
    );
    assert.equal(next.problem_id, problem);
    if (cliMode) {
      for (const [problemId, json, credential, status] of [
        [problem, true, token, 200],
        [problem, false, token, 200],
        ["P-NEXT-MISSING", true, token, 404],
        [problem, true, "asimp_ag_invalid", 401],
      ]) {
        const path = `/v1/p/${problemId}/next${json ? "" : ".md"}`;
        const response = await worker.fetch(`${origin}${path}`, {
          headers: { authorization: `Bearer ${credential}`, "User-Agent": userAgent },
        });
        const body = await response.text();
        assert.equal(response.status, status, `next response digest=${sha(body)}`);
        if (status === 200) {
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          if (json) {
            assert.equal(ProblemNextResponseSchema.parse(JSON.parse(body)).problem_id, problem);
          }
        }
        for (const privateBody of bodies) assert.ok(!body.includes(privateBody));
        await verifyCli(path, credential, status, body, { problem: problemId, json });
      }
      assert.equal(cliNextReads, 4);
    }
    const etags = [];
    for (const [index, draft] of drafts.entries()) {
      const result = await read(pathFor(draft), token);
      const parsed = WorkshopObjectResponseSchema.parse(result.data);
      assert.equal(parsed.object.body_md, bodies[index]);
      assert.equal(parsed.body_sha256, sha(bodies[index]));
      assert.equal(parsed.problem_id, problem);
      assert.equal(parsed.fellow_id, fellow.fellow_id);
      assert.deepEqual(parsed.object.relates_to, ["C-1"]);
      if (index === 0) assert.deepEqual(parsed.object.revision, revision);
      etags.push(result.response.headers.get("etag"));
      assert.ok(etags[index]);
      await read(pathFor(draft), token, 304, "GET", etags[index]);
      await read(pathFor(draft), token, 200, "HEAD");
      const sponsorView = await sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/workshop",
        "workshop.read",
        { problem_id: problem, fellow_id: fellow.fellow_id },
      );
      assert.deepEqual(
        sponsorView.objects.find((item) => item.workshop_id === draft.workshop_id),
        parsed.object,
      );
    }
    await call(
      `/v1/sessions/${session.session_id}/workshop`,
      { workshop_id: drafts[0].workshop_id, base_version: 1, body_md: editedBody },
      token,
      201,
    );
    const original = await read(`${pathFor(drafts[0])}?version=1`, token);
    assert.equal(original.data.object.body_md, bodies[0]);
    assert.equal(original.data.body_sha256, sha(bodies[0]));
    assert.equal(original.data.object.version, 1);
    assert.equal(original.data.object.current_version, 2);
    const latest = await read(pathFor(drafts[0]), token);
    assert.equal(latest.data.object.body_md, editedBody);
    assert.equal(latest.data.body_sha256, sha(editedBody));
    assert.equal(latest.data.object.current_version, 2);
    assert.equal(latest.data.object.version, 2);
    const sponsorRevision = (draft, version, actor = sponsor, status = 200, extra = {}) =>
      sponsorCall(
        actor,
        "POST",
        "/v1/sponsors/workshop",
        "workshop.read",
        {
          problem_id: problem,
          fellow_id: fellow.fellow_id,
          object: { workshop_id: draft.workshop_id, version },
          ...extra,
        },
        status,
      );
    const historyBefore = await env.DB.prepare(
      "SELECT public_seq, (SELECT MAX(workshop_seq) FROM workshop_objects WHERE problem_id = ? AND fellow_id = ?) AS workshop_seq FROM problems WHERE id = ?",
    )
      .bind(problem, fellow.fellow_id, problem)
      .first();
    for (const [draft, version, expected] of [
      [drafts[0], 1, original.data.object],
      [drafts[0], 2, (await read(`${pathFor(drafts[0])}?version=2`, token)).data.object],
      [drafts[1], 1, (await read(`${pathFor(drafts[1])}?version=1`, token)).data.object],
    ]) {
      const page = SponsorWorkshopViewSchema.parse(await sponsorRevision(draft, version));
      assert.deepEqual(
        page.objects,
        [expected],
        "both principals read the identical immutable revision, including complete private CAS bytes",
      );
      assert.equal(page.has_more, false);
      assert.equal(page.next_cursor, null);
    }
    await sponsorRevision(drafts[0], 999, sponsor, 404);
    await sponsorRevision({ workshop_id: "W-00000000000000000000000000" }, 1, sponsor, 404);
    await sponsorRevision(drafts[0], 1, "usr_workshop_stranger", 404);
    await sponsorRevision(drafts[0], 1, sponsor, 404, { problem_id: "P-WORKSHOP-OTHER" });
    await sponsorRevision(drafts[0], 1, sponsor, 422, { before_workshop_seq: 10 });
    await sponsorRevision(drafts[0], 0, sponsor, 422);
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT public_seq, (SELECT MAX(workshop_seq) FROM workshop_objects WHERE problem_id = ? AND fellow_id = ?) AS workshop_seq FROM problems WHERE id = ?",
      )
        .bind(problem, fellow.fellow_id, problem)
        .first(),
      historyBefore,
      "reading history never mutates either cursor",
    );
    await read(`${pathFor(drafts[0])}?version=999`, token, 404);
    await read(`${pathFor(drafts[0], peerSession)}?version=1`, peer, 404);

    const discovery = await call("/openapi.json");
    const operation = discovery.paths["/v1/sessions/{id}/workshop/{workshopId}"].get;
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.ok(
      operation.responses["200"].content["application/json"].schema.$ref.endsWith(
        "/properties/workshop_object_response",
      ),
    );
    for (const [profile, kind] of [
      ["working", "workshop-head"],
      ["graveyard", "dead-end"],
    ]) {
      const pack = await call(
        `/v1/sessions/${session.session_id}/pack?profile=${profile}`,
        undefined,
        token,
      );
      const item = pack.items.find(
        (entry) => entry.id === drafts[1].workshop_id && entry.kind === kind,
      );
      assert.ok(item, "The own work product is included in the requested private pack");
      assert.equal(item.scope, "workshop");
      assert.ok(item.body.includes(pathFor(drafts[1])));
      const link = item.body.match(
        /\/v1\/sessions\/S-[A-Za-z0-9]{26}\/workshop\/W-[A-Za-z0-9]{26}/,
      )?.[0];
      assert.equal((await read(link, token)).data.object.body_md, bodies[1]);
    }
    for (const method of ["GET", "HEAD"]) {
      await read(pathFor(drafts[0]), undefined, 401, method);
      await read(pathFor(drafts[0]), peer, 404, method, etags[0]);
      await read(pathFor(drafts[0], peerSession), peer, 404, method);
      await read(pathFor(drafts[0], strangerSession), stranger, 404, method);
      await read(pathFor(drafts[0], otherProblemSession), token, 404, method);
      await read(pathFor({ workshop_id: "W-00000000000000000000000000" }), token, 404, method);
      await read(`${pathFor(drafts[0])}?unknown=1`, token, 400, method);
      const invalid = await read(`${pathFor(drafts[0])}?version=0`, token, 400, method);
      if (invalid.data) {
        assert.equal(invalid.data.code, "SCHEMA_INVALID");
        for (const field of ["rule", "fix_hint", "schema", "example"])
          assert.ok(invalid.data[field]);
      }
    }
    // Absent/corrupt/oversized data is test-controlled in this ephemeral private
    // store. Never delete an object, disable a trigger, or change public data.
    const row = await env.DB.prepare("SELECT cas_hash FROM workshop_objects WHERE workshop_id = ?")
      .bind(drafts[1].workshop_id)
      .first();
    assert.ok(row.cas_hash);
    await env.DB.prepare("UPDATE workshop_objects SET cas_hash = ? WHERE workshop_id = ?")
      .bind(`sha256:${"0".repeat(64)}`, drafts[1].workshop_id)
      .run();
    await read(pathFor(drafts[1]), token, 500);
    await env.DB.prepare("UPDATE workshop_objects SET cas_hash = ? WHERE workshop_id = ?")
      .bind(row.cas_hash, drafts[1].workshop_id)
      .run();
    const key = `cas/sha256/${row.cas_hash.slice(7)}`;
    for (const corrupt of [
      "Different private bytes",
      new Uint8Array([0xff, 0xff]),
      "x".repeat(1024 * 1024),
    ]) {
      await env.ARTIFACTS.put(key, corrupt);
      await read(pathFor(drafts[1]), token, 500, "GET", etags[1]);
      await read(pathFor(drafts[1]), token, 500, "HEAD");
      await sponsorRevision(drafts[1], 1, sponsor, 500);
    }
    await env.ARTIFACTS.put(key, bodies[1]);
    assert.equal((await read(pathFor(drafts[1]), token)).data.object.body_md, bodies[1]);
    await call(
      `/v1/sessions/${session.session_id}/close`,
      {
        handback: "Private work remains recoverable.",
        promote: [],
        keep: [],
        discard: [],
      },
      token,
      201,
    );
    await read(pathFor(drafts[1]), token);
    assert.equal(
      (await read(`${pathFor(drafts[0])}?version=1`, token)).data.object.body_md,
      bodies[0],
    );
    assert.equal((await sponsorRevision(drafts[0], 1)).objects[0].body_md, bodies[0]);
    const resumed = await open(token);
    assert.equal((await read(pathFor(drafts[1], resumed), token)).data.object.body_md, bodies[1]);
    await call(
      `/v1/sessions/${otherProblemSession.session_id}/close`,
      {
        handback: "Completed the cross-problem privacy control.",
        promote: [],
        keep: [],
        discard: [],
      },
      token,
      201,
    );
    // A real private problem proposal lets its creator read its work; changing
    // the sponsor of this test problem models the loss of that private grant.
    const proposal = {
      title: "Cycle parity under edge subdivision",
      statement: "Subdividing one edge of a finite cycle reverses its length parity.",
      falsifier: "A finite cycle whose parity is unchanged after one edge subdivision.",
      motivation: "Determine which local graph edits preserve parity.",
      areas: ["combinatorics"],
    };
    const brief = await sponsorCall(
      sponsor,
      "POST",
      "/v1/sponsors/problem-briefs",
      "save-problem-brief",
      proposal,
      201,
    );
    const proposed = await call(
      "/v1/problems",
      { ...proposal, brief_id: brief.brief.id, expected_brief_version: brief.brief.version },
      token,
      201,
    );
    const privateSession = await open(token, proposed.problem.id);
    const privateDraft = await call(
      `/v1/sessions/${privateSession.session_id}/workshop`,
      { type: "claim-draft", title: "Private parity", body_md: bodies[0] },
      token,
      201,
    );
    await read(pathFor(privateDraft, privateSession), token);
    await env.DB.prepare("UPDATE problems SET sponsor_id = ? WHERE id = ?")
      .bind("usr_workshop_stranger", proposed.problem.id)
      .run();
    await read(pathFor(privateDraft, privateSession), token, 404);
    await sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
      fellow_id: fellow.fellow_id,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    await read(pathFor(drafts[0]), token, 401, "GET", etags[0]);
    await read(pathFor(drafts[0]), token, 401, "HEAD");
    assert.equal(
      (await sponsorRevision(drafts[0], 1)).objects[0].body_md,
      bodies[0],
      "current sponsors can recover immutable drafts after their Fellow is paused",
    );
    const peerDraft = await call(
      `/v1/sessions/${peerSession.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "Revocation recovery control",
        body_md: bodies[0],
      },
      peer,
      201,
    );
    await read(pathFor(peerDraft, peerSession), peer);
    const peerCredential = await env.DB.prepare(
      "SELECT credential_id, fellow_id FROM fellow_tokens WHERE fellow_id = (SELECT fellow_id FROM sessions WHERE session_id = ?) AND revoked_at IS NULL",
    )
      .bind(peerSession.session_id)
      .first();
    await sponsorCall(
      sponsor,
      "POST",
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
      {
        ...peerCredential,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
    );
    await read(pathFor(peerDraft, peerSession), peer, 401);
    await read(`${pathFor(peerDraft, peerSession)}?version=1`, peer, 401);
    const expirySponsor = "usr_workshop_expiry";
    await enroll("workshop-expiry-sponsor", expirySponsor);
    const invitation = await sponsorCall(
      expirySponsor,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["promote"],
        fellow_grant_expires_in_ms: 5000,
      },
      201,
    );
    const claimed = await call(
      "/v1/fellows",
      {
        enrollment_id: invitation.enrollment_id,
        secret: invitation.secret,
        name: "workshop-expiring",
        model: "synthetic-expiry",
        harness: "local-workshop-read",
      },
      undefined,
      202,
    );
    await fixtures.approve(expirySponsor, invitation.enrollment_id);
    const expiring = (await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle })).token;
    const expirySession = await open(expiring);
    const expiryDraft = await call(
      `/v1/sessions/${expirySession.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "Expiry recovery control",
        body_md: bodies[0],
      },
      expiring,
      201,
    );
    await read(pathFor(expiryDraft, expirySession), expiring);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await read(pathFor(expiryDraft, expirySession), expiring, 401);
    // The recovery reads and workshop/session operations never publish the work.
    // The separate proposal legitimately appends its own governance event.
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(problem)
          .first()
      ).n,
      0,
    );
    assert.equal(eventsBefore.n, 0);
    assert.deepEqual(publicBefore.objects, (await env.PUBLIC_ARTIFACTS.list()).objects);
    assert.deepEqual(
      privateBefore.objects.map((entry) => entry.key),
      (await env.ARTIFACTS.list()).objects.map((entry) => entry.key),
    );
    assert.deepEqual(await call("/cursor"), before);
    if (cliMode) assert.deepEqual(cliStatuses, { 200: 15, 400: 1, 401: 3, 404: 7, 500: 1 });
    console.log(
      JSON.stringify({
        kind: "workshop-read-real-bindings",
        status: "pass",
        positive_bodies: 2,
        body_storage: ["D1", "R2"],
        immutable_revision_after_edit_and_close: true,
        ...(cliMode
          ? {
              cli_reads: cliReads,
              cli_next_reads: cliNextReads,
              cli_statuses: cliStatuses,
              cli_transport:
                "production Rust dispatcher and bearer HTTP reader via explicit loopback origin mapping",
            }
          : {}),
        proof_scope:
          "local real bindings and signed sponsor reads; fixture enrollment approval, active problems and private-grant loss; no Google, deployment or synthesis-publication claim",
      }),
    );
  },
);

// Publication is a distinct journey so the read-only privacy lane above keeps
// proving that recovery itself never appends a public scientific event.
if (!cliMode) {
  await runLocalWorkerJourney(
    async ({ call, enroll, fixtures, env, sponsorCall, worker, origin, userAgent }) => {
      const sponsor = "usr_workshop_typed_revision";
      const token = await enroll("workshop-corrected-revision", sponsor);
      const problemId = "P-WORKSHOP-REVISION";
      await fixtures.seedProblem(problemId, sponsor);
      const session = await call(
        "/v1/sessions",
        { problem_id: problemId, intent: "explore" },
        token,
        201,
      );
      const path = `/v1/sessions/${session.session_id}`;
      const { fellow_id: fellowId } = await env.DB.prepare(
        "SELECT fellow_id FROM sessions WHERE session_id = ?",
      )
        .bind(session.session_id)
        .first();
      const publication = {
        kind: "conjecture",
        statement: "Every finite nonempty path has one more vertex than edge.",
        falsifier: "A finite nonempty path with a different vertex count.",
        depends_on: [],
        relates_to: [],
      };
      const original = await call(
        `${path}/workshop`,
        {
          type: "claim-draft",
          title: "Typed publication to review",
          body_md: "Private deliberate work accompanies the typed statement.",
          publication,
        },
        token,
        201,
      );
      const sponsorView = await sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/workshop",
        "workshop.read",
        { problem_id: problemId, fellow_id: fellowId },
      );
      assert.deepEqual(sponsorView.objects[0].publication, publication);
      const claim = await call(
        `${path}/promote`,
        { workshop_id: original.workshop_id, ...publication },
        token,
        201,
      );
      const firstReplacement = {
        claim_id: claim.claim_id,
        base_version: claim.version,
        kind: "conjecture",
        statement: "The replacement draft covers paths with at least two edges.",
        falsifier: "A qualifying path outside the draft vertex count.",
        depends_on: [],
      };
      const replacementDraft = await call(
        `${path}/workshop`,
        {
          type: "claim-draft",
          title: "Replacement draft",
          body_md: "Private draft with an explicitly typed replacement.",
          revision: firstReplacement,
        },
        token,
        201,
      );
      const correctedReplacement = {
        ...firstReplacement,
        statement: "Every finite connected acyclic graph has one more vertex than edge.",
        falsifier: "A finite connected acyclic graph with a different count.",
      };
      await call(
        `${path}/workshop`,
        {
          workshop_id: replacementDraft.workshop_id,
          base_version: replacementDraft.version,
          revision: correctedReplacement,
        },
        token,
        201,
      );
      const current = await call(
        `${path}/workshop/${replacementDraft.workshop_id}`,
        undefined,
        token,
      );
      const historical = await call(
        `${path}/workshop/${replacementDraft.workshop_id}?version=1`,
        undefined,
        token,
      );
      assert.equal(current.object.version, 2);
      assert.deepEqual(current.object.revision, correctedReplacement);
      assert.equal(historical.object.version, 1);
      assert.deepEqual(historical.object.revision, firstReplacement);
      const corrected = await call(
        `${path}/revise`,
        { workshop_id: replacementDraft.workshop_id },
        token,
        201,
      );
      assert.equal(corrected.version, 2);
      const versions = await env.DB.prepare(
        "SELECT version, statement FROM claim_versions WHERE problem_id = ? AND claim_id = ? ORDER BY version",
      )
        .bind(problemId, claim.claim_id)
        .all();
      assert.deepEqual(versions.results, [
        { version: 1, statement: publication.statement },
        { version: 2, statement: correctedReplacement.statement },
      ]);
      const retained = await call(
        `${path}/workshop/${replacementDraft.workshop_id}?version=1`,
        undefined,
        token,
      );
      assert.deepEqual(retained.object.revision, firstReplacement);
      const eventCount = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE problem_id = ?",
      )
        .bind(problemId)
        .first();
      assert.equal(eventCount.n, 2);

      const publicState = () =>
        env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM events WHERE problem_id = ?) AS events,
      (SELECT COUNT(*) FROM event_content) AS content,
      (SELECT COUNT(*) FROM claim_versions) AS versions,
      (SELECT COUNT(*) FROM idempotency) AS idempotency,
      (SELECT COUNT(*) FROM outbox) AS outbox,
      (SELECT COUNT(*) FROM screening_publications) AS screened,
      (SELECT cursor FROM public_cursor WHERE singleton = 1) AS cursor,
      (SELECT public_seq FROM problems WHERE id = ?) AS seq,
      (SELECT statement FROM claims WHERE problem_id = ? AND id = ?) AS statement
    `)
          .bind(problemId, problemId, problemId, claim.claim_id)
          .first();
      let publicVersion = corrected.version;
      for (const mode of ["session", "batch"]) {
        const stale = {
          ...correctedReplacement,
          base_version: publicVersion,
          statement: `The ${mode} replacement selected before screening is outdated.`,
        };
        const draft = await call(
          `${path}/workshop`,
          {
            type: "claim-draft",
            title: `${mode} source-pinned replacement`,
            body_md: "Private replacement edited while publication is being checked.",
            revision: stale,
          },
          token,
          201,
        );
        const writePath = mode === "session" ? `${path}/revise` : `/v1/p/${problemId}/events:batch`;
        const body =
          mode === "session"
            ? { workshop_id: draft.workshop_id }
            : {
                members: [
                  {
                    tempId: "tmp:replacement",
                    action: "revise",
                    data: { workshop_id: draft.workshop_id },
                  },
                ],
              };
        const before = await publicState();
        const screens = await fixtures.screeningCalls();
        await fixtures.pauseScreening(3000);
        let responded = false;
        const pending = worker
          .fetch(`${origin}${writePath}`, {
            method: "POST",
            headers: {
              "User-Agent": userAgent,
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "Idempotency-Key": `typed-source-${mode}-stale`,
            },
            body: JSON.stringify(body),
          })
          .then((response) => {
            responded = true;
            return response;
          });
        const current = {
          ...stale,
          statement: `The ${mode} corrected replacement retains its exact scope.`,
        };
        try {
          for (let i = 0; i < 100 && (await fixtures.screeningCalls()) === screens; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            await fixtures.screeningCalls(),
            screens + 1,
            "the old replacement reached screening",
          );
          await call(
            `${path}/workshop`,
            {
              workshop_id: draft.workshop_id,
              base_version: draft.version,
              revision: current,
            },
            token,
            201,
          );
          assert.equal(responded, false, "the edit committed before the old publication completed");
        } finally {
          await fixtures.resumeScreening();
        }
        const refused = await pending;
        assert.equal(refused.status, 409);
        const refusal = await refused.json();
        assert.equal(refusal.code, "WORKSHOP_VERSION_CONFLICT");
        assert.equal(refusal.current_version, 2);
        assert.deepEqual(
          await publicState(),
          before,
          "stale publication left every public companion unchanged",
        );
        const key = `typed-source-${mode}-current`;
        const committed = await call(writePath, body, token, 201, key);
        publicVersion += 1;
        assert.equal(
          mode === "session" ? committed.version : committed.results[0].version,
          publicVersion,
        );
        assert.equal((await publicState()).statement, current.statement);
        const history = await call(
          `${path}/workshop/${draft.workshop_id}?version=1`,
          undefined,
          token,
        );
        assert.deepEqual(history.object.revision, stale);

        const publishedDraft = await call(
          `${path}/workshop/${draft.workshop_id}`,
          undefined,
          token,
        );
        assert.equal(publishedDraft.object.current_version, 3);
        assert.equal(publishedDraft.object.version, 3);
        assert.equal(publishedDraft.object.state, "archived");
        assert.deepEqual(publishedDraft.object.revision, current);

        await call(
          `${path}/workshop`,
          {
            workshop_id: draft.workshop_id,
            base_version: publishedDraft.object.current_version,
            revision: {
              ...current,
              statement: `The ${mode} next private draft remains unpublished.`,
            },
          },
          token,
          201,
        );
        const committedState = await publicState();
        assert.deepEqual(await call(writePath, body, token, 200, key), committed);
        assert.deepEqual(
          await publicState(),
          committedState,
          "replay after a private edit appends nothing",
        );
      }
      assert.equal((await publicState()).events, 4);
      console.log(
        JSON.stringify({
          kind: "workshop-typed-revision-real-bindings",
          status: "pass",
          sponsor_receives_typed_publication: true,
          latest_replacement_published: true,
          private_and_public_history_preserved: true,
          concurrent_typed_replacement_edits_refused: ["session", "batch"],
          exact_retry_receipts_after_later_edits: true,
          proof_scope:
            "local Workerd and real D1/R2 with signed sponsor reads; no deployment claim",
        }),
      );
    },
  );

  // Only scheduling is controlled: real R2 bytes are read before a second,
  // signed HTTP request transfers ownership or deletes the private authority.
  await runLocalWorkerJourney(
    async ({ call, enroll, fixtures, env, sponsorCall, worker, origin, userAgent }) => {
      const owner = "usr_workshop_read_owner";
      const recipient = "usr_workshop_read_recipient";
      const token = await enroll("workshop-read-owner", owner);
      await enroll("workshop-read-recipient", recipient);
      const problem = "P-WORKSHOP-READ-AUTHORITY";
      await fixtures.seedProblem(problem, owner);
      const session = await call("/v1/sessions", { problem_id: problem }, token, 201);
      const { fellow_id: fellow } = await env.DB.prepare(
        "SELECT fellow_id FROM sessions WHERE session_id = ?",
      )
        .bind(session.session_id)
        .first();
      const scope = { problem_id: problem, fellow_id: fellow };
      const path = "/v1/sponsors/workshop";
      const inlineBody = "PRIVATE_AUTHORITY_INLINE: owner-only boundary calculation.";
      const spilledBody =
        "PRIVATE_AUTHORITY_R2: exact work product must remain private across ownership changes.\n".repeat(
          100,
        );
      const push = (authorSession, credential, title, body) =>
        call(
          `/v1/sessions/${authorSession.session_id}/workshop`,
          { type: "scratch", title, body_md: body },
          credential,
          201,
        );
      const inline = await push(session, token, "Private inline authority canary", inlineBody);
      const spilled = await push(session, token, "Private R2 authority canary", spilledBody);
      const row = await env.DB.prepare(
        "SELECT cas_hash FROM workshop_objects WHERE workshop_id = ?",
      )
        .bind(spilled.workshop_id)
        .first();
      assert.match(row.cas_hash, /^sha256:[a-f0-9]{64}$/);
      const read = (actor, selected = scope, expected = 200) =>
        sponsorCall(actor, "POST", path, "workshop.read", selected, expected);
      const historicalScope = {
        ...scope,
        object: { workshop_id: spilled.workshop_id, version: 1 },
      };
      const assertRefusal = (data, extraCanaries = []) => {
        assert.equal(data.code, "WORKSHOP_NOT_FOUND");
        const serialized = JSON.stringify(data);
        for (const privateValue of [
          inlineBody,
          spilledBody,
          inline.workshop_id,
          spilled.workshop_id,
          row.cas_hash,
          "cas/sha256/",
          "Private inline authority canary",
          "Private R2 authority canary",
          ...extraCanaries,
        ])
          assert.ok(!serialized.includes(privateValue), "a refusal contains no private work");
        assert.equal(data.objects, undefined);
        assert.equal(data.workshop_cursor, undefined);
      };
      const first = await read(owner);
      assert.equal(
        first.objects.find((item) => item.workshop_id === inline.workshop_id).body_md,
        inlineBody,
      );
      assert.equal(
        first.objects.find((item) => item.workshop_id === spilled.workshop_id).body_md,
        spilledBody,
      );
      assertRefusal(await read(recipient, scope, 404));
      const firstHistory = await read(owner, historicalScope);
      assert.equal(firstHistory.objects[0].body_md, spilledBody);
      assertRefusal(await read(recipient, historicalScope, 404));
      for (const headers of [
        {},
        { authorization: `Bearer ${token}` },
        // A browser cookie is never service-envelope authority at the Worker.
        { cookie: "authjs.session-token=fixture-browser-session" },
      ]) {
        const response = await worker.fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "User-Agent": userAgent, "Content-Type": "application/json", ...headers },
          body: JSON.stringify(scope),
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const refused = await response.json();
        assert.equal(refused.code, "WRONG_PRINCIPAL");
        assert.ok(!JSON.stringify(refused).includes(inlineBody));
        assert.ok(!JSON.stringify(refused).includes(spilledBody));
      }
      const publicBefore = await call("/cursor");
      const publicObjectsBefore = (await env.PUBLIC_ARTIFACTS.list()).objects;
      const whileBodyHeld = async (actor, selected, digest, mutate, canaries = []) => {
        await fixtures.holdPrivateBodyRead(`cas/sha256/${digest.slice("sha256:".length)}`);
        let responded = false;
        const pending = read(actor, selected, 404).then(
          (data) => {
            responded = true;
            return { data };
          },
          (error) => {
            responded = true;
            return { error };
          },
        );
        try {
          for (
            let attempt = 0;
            attempt < 200 && !(await fixtures.privateBodyReadBlocked());
            attempt++
          )
            await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(await fixtures.privateBodyReadBlocked(), true, "real R2 bytes materialized");
          assert.equal(responded, false, "the private response remains held");
          await mutate();
          assert.equal(responded, false, "authority changed before the private response completed");
        } finally {
          await fixtures.releasePrivateBodyRead();
        }
        const result = await pending;
        if (result.error) throw result.error;
        assertRefusal(result.data, canaries);
      };
      const now = () => Math.floor(Date.now() / 1000);
      await whileBodyHeld(owner, scope, row.cas_hash, async () => {
        const offered = await sponsorCall(
          owner,
          "POST",
          "/v1/sponsors/transfers",
          "sponsor.transfer.initiate",
          {
            fellow_id: fellow,
            target_sponsor_id: recipient,
            confirm: "initiate-fellow-transfer",
            step_up_authenticated_at: now(),
            directive_attestation: "no_directives",
          },
          201,
        );
        await sponsorCall(
          recipient,
          "POST",
          `/v1/sponsors/transfers/${offered.transfer_id}/accept`,
          "sponsor.transfer.accept",
          {
            transfer_id: offered.transfer_id,
            confirm: "accept-fellow-transfer",
            step_up_authenticated_at: now(),
          },
        );
      });
      assertRefusal(await read(owner, scope, 404));
      const received = await read(recipient);
      assert.deepEqual(
        received.objects,
        first.objects,
        "the current sponsor can recover unchanged work",
      );
      assertRefusal(await read(owner, historicalScope, 404));
      assert.deepEqual((await read(recipient, historicalScope)).objects, firstHistory.objects);
      await whileBodyHeld(recipient, scope, row.cas_hash, async () => {
        const preview = await sponsorCall(
          recipient,
          "GET",
          "/v1/sponsors/account/delete-preview",
          "sponsor.account.delete-preview",
        );
        const deleted = await sponsorCall(
          recipient,
          "POST",
          "/v1/sponsors/account/delete",
          "sponsor.account.delete",
          {
            confirm: "delete-sponsor-account-and-revoke-all-fellows",
            expected_preview: preview.review,
            step_up_authenticated_at: now(),
          },
        );
        assert.equal(deleted.acknowledged, true);
      });
      assertRefusal(await read(recipient, scope, 404));
      assertRefusal(await read(owner, scope, 404));
      assertRefusal(await read(recipient, historicalScope, 404));
      assertRefusal(await read(owner, historicalScope, 404));

      const privateToken = await enroll("workshop-read-erasure", owner);
      const privateProblem = await call(
        "/v1/problems",
        {
          title: "Private endpoint erasure control",
          statement: "Every finite simple path with n edges has n plus one vertices.",
          falsifier: "A finite simple path whose vertex count differs from n plus one.",
          motivation: "Check private work erasure during an in-flight sponsor read.",
          areas: ["combinatorics"],
        },
        privateToken,
        201,
      );
      const privateSession = await call(
        "/v1/sessions",
        { problem_id: privateProblem.problem.id },
        privateToken,
        201,
      );
      const privateFellow = await env.DB.prepare(
        "SELECT fellow_id FROM sessions WHERE session_id = ?",
      )
        .bind(privateSession.session_id)
        .first();
      const privateScope = {
        problem_id: privateProblem.problem.id,
        fellow_id: privateFellow.fellow_id,
      };
      const privateDraft = await push(
        privateSession,
        privateToken,
        "Private erasure canary",
        spilledBody,
      );
      assert.equal((await read(owner, privateScope)).objects[0].body_md, spilledBody);
      const privateHistory = {
        ...privateScope,
        object: { workshop_id: privateDraft.workshop_id, version: 1 },
      };
      assert.equal((await read(owner, privateHistory)).objects[0].body_md, spilledBody);
      await whileBodyHeld(
        owner,
        privateScope,
        row.cas_hash,
        async () => {
          const deleted = await sponsorCall(
            owner,
            "DELETE",
            `/v1/sponsors/problems/${privateProblem.problem.id}`,
            "delete-problem-draft",
          );
          assert.equal(deleted.deleted, true);
        },
        [privateDraft.workshop_id, "Private erasure canary"],
      );
      assertRefusal(await read(owner, privateScope, 404), [privateDraft.workshop_id]);
      assertRefusal(await read(owner, privateHistory, 404), [privateDraft.workshop_id]);
      assert.deepEqual(await call("/cursor"), publicBefore);
      assert.deepEqual((await env.PUBLIC_ARTIFACTS.list()).objects, publicObjectsBefore);
      assert.equal(
        (
          await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
            .bind(problem)
            .first()
        ).n,
        0,
      );
      console.log(
        JSON.stringify({
          kind: "sponsor-workshop-read-authority-real-bindings",
          status: "pass",
          complete_inline_and_r2_bodies: true,
          current_owner_after_bilateral_transfer: true,
          denied_after_r2_materialization: [
            "sponsor-transfer",
            "account-deletion",
            "private-draft-erasure",
          ],
          public_cursor_and_artifacts_unchanged: true,
          proof_scope:
            "local Workerd, real D1/R2 and signed lifecycle routes; fixture enrollment approval and request scheduling; no Google or deployment claim",
        }),
      );
    },
  );
}

// The optional CLI loop extends this existing native lane. Build the matching
// Rust library test executable, set ASIMP_WORKSHOP_TEST_BINARY, then run this
// file with `cli-loop`. All requests below cross a real HTTP socket into real
// Workerd/D1/R2; only the test HTTPS origin is mapped to that loopback socket.
// Enrollment approval, screening decisions and the idle timestamp are fixtures.
// Private command results remain in a fresh mode-0700 temporary directory.
async function cliCoordinationJourney({
  call,
  enroll,
  sponsorCall,
  worker,
  origin,
  userAgent,
  env,
}) {
  const sponsor = "usr_cli_loop_owner";
  const author = await enroll("cli-loop-author", sponsor);
  const reviewer = await enroll("cli-loop-reviewer", "usr_cli_loop_reviewer");
  const inboxReader = await enroll("cli-loop-inbox", "usr_cli_loop_inbox");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Finite paths and their endpoints",
        statement: "A finite path with n edges has n + 1 vertices.",
        falsifier: "A finite path whose vertex count differs from its edge count plus one.",
        motivation: "Check that recovered work and coordinated effort retain exact scope.",
        areas: ["combinatorics"],
      },
      author,
      201,
    )
  ).problem.id;
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const peerSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: peerSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The graph class and finite vertex-count condition are explicit.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "explore" }, author, 201)
  ).session_id;
  const base = `/v1/sessions/${session}`;
  const artifacts = mkdtempSync(join(tmpdir(), "asimp-cli-loop-"));
  let commands = 0;
  let requestCount = 0;
  let expected;
  let observed;
  let bridgeFailure;
  const bridge = createServer(async (request, response) => {
    try {
      assert.ok(expected, "the bridge accepts only the current command");
      assert.equal(request.method, expected.method);
      assert.equal(request.url, expected.path);
      assert.equal(request.headers["user-agent"], userAgent);
      assert.ok(request.headers.authorization === `Bearer ${expected.token}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (expected.body !== undefined) {
        assert.equal(request.headers["idempotency-key"], expected.key);
        assert.deepEqual(JSON.parse(body), expected.body);
      } else assert.equal(body, "");
      requestCount++;
      const result = await worker.fetch(`${origin}${request.url}`, {
        method: request.method,
        headers: {
          authorization: request.headers.authorization,
          "User-Agent": userAgent,
          ...(expected.body === undefined
            ? {}
            : { "content-type": "application/json", "Idempotency-Key": expected.key }),
        },
        ...(expected.body === undefined ? {} : { body }),
      });
      observed = { status: result.status, body: await result.text() };
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(observed.body);
    } catch (error) {
      bridgeFailure = error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });

  async function cli(args, path, options = {}) {
    const number = ++commands;
    const body = options.body;
    const key = options.key ?? `cli-loop-${number}`;
    const token = options.token ?? author;
    const status = options.status ?? 200;
    const outputFile = join(artifacts, `${number}.result.json`);
    const arguments_ = [...args];
    if (body !== undefined) {
      const inputFile = join(artifacts, `${number}.request.json`);
      writeFileSync(inputFile, JSON.stringify(body), { mode: 0o600, flag: "wx" });
      arguments_.push("--file", inputFile, "--idempotency-key", key);
    }
    expected = { method: body === undefined ? "GET" : "POST", path, body, key, token };
    observed = undefined;
    const before = requestCount;
    const probe = {
      origin: `http://127.0.0.1:${bridge.address().port}`,
      args: arguments_,
      token,
      path,
      method: expected.method,
      output_file: outputFile,
    };
    const result = await execute(
      process.env.ASIMP_WORKSHOP_TEST_BINARY,
      ["--exact", "coordination_native_tests::coordination_real_http", "--ignored"],
      {
        env: { ...process.env, ASIMP_COORDINATION_PROBE: JSON.stringify(probe) },
        timeout: 20000,
        maxBuffer: 128 * 1024,
      },
    ).catch((error) => {
      // Preserve diagnostics without publishing private command arguments,
      // request bodies or environment values in the lane's output.
      writeFileSync(join(artifacts, `${number}.rust.stdout`), error.stdout ?? "", {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(join(artifacts, `${number}.rust.stderr`), error.stderr ?? "", {
        mode: 0o600,
        flag: "wx",
      });
      throw new Error(`Native CLI command ${number} failed; diagnostics retained in ${artifacts}`);
    });
    assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
    if (bridgeFailure !== undefined) {
      writeFileSync(join(artifacts, `${number}.bridge.error`), inspect(bridgeFailure), {
        mode: 0o600,
        flag: "wx",
      });
      throw new Error(`Native CLI bridge ${number} failed; diagnostics retained in ${artifacts}`);
    }
    assert.equal(requestCount, before + 1, "one explicit command performs exactly one request");
    assert.equal(observed?.status, status, `native CLI command ${number} HTTP status`);
    const output = JSON.parse(readFileSync(outputFile, "utf8"));
    if (status >= 200 && status < 300) {
      assert.equal(output.exit_code, 0);
      assert.equal(output.stderr, "");
      assert.ok(output.stdout === observed.body, "CLI preserves the complete Worker response");
    } else {
      assert.equal(output.exit_code, 1);
      assert.equal(output.stdout, "");
      assert.ok(output.stderr.includes(`HTTP ${status}`));
      assert.ok(!output.stderr.includes(token));
    }
    const response = observed.body;
    expected = undefined;
    return options.markdown ? response : JSON.parse(response);
  }

  try {
    // Discover, edit and discard exact private revisions; edits do not
    // reorder the immutable directory cursor or publish draft contents.
    const publicBefore = await call("/cursor");
    const original = "Private finite-path notes before checking the boundary case.";
    const replacement = `Corrected private finite-path notes.\n${"Boundary vertices α and β.\n".repeat(60)}`;
    const first = await cli(["workshop", "push", session], `${base}/workshop`, {
      body: { type: "scratch", title: "First private draft", body_md: original },
      status: 201,
    });
    const second = await cli(["workshop", "push", session], `${base}/workshop`, {
      body: {
        type: "scratch",
        title: "Second private draft",
        body_md: "A separate private approach.",
      },
      status: 201,
    });
    const page = WorkshopDirectoryResponseSchema.parse(
      await cli(
        ["workshop", "list", session, "--limit", "1", "--state", "open"],
        `${base}/workshop?limit=1&state=open`,
      ),
    );
    assert.equal(page.items.length, 1);
    assert.ok(page.next_after);
    const selected = page.items[0];
    const originalBody =
      selected.workshop_id === first.workshop_id ? original : "A separate private approach.";
    assert.equal(selected.read_url, `${base}/workshop/${selected.workshop_id}?version=1`);
    const edit = {
      workshop_id: selected.workshop_id,
      base_version: 1,
      action: "edit",
      body_md: replacement,
    };
    const revised = await cli(["workshop", "revise", session], `${base}/workshop`, {
      body: edit,
      key: "cli-loop-edit",
      status: 201,
    });
    assert.equal(revised.version, 2);
    assert.deepEqual(
      await cli(["workshop", "revise", session], `${base}/workshop`, {
        body: edit,
        key: "cli-loop-edit",
        status: 200,
      }),
      revised,
      "an unchanged retry retains the immutable revision receipt",
    );
    const stale = await cli(["workshop", "revise", session], `${base}/workshop`, {
      body: { ...edit, body_md: "A stale replacement must not overwrite the current draft." },
      status: 409,
    });
    assert.equal(stale.code, "WORKSHOP_VERSION_CONFLICT");
    const next = WorkshopDirectoryResponseSchema.parse(
      await cli(
        [
          "workshop",
          "list",
          session,
          "--after",
          page.next_after,
          "--limit",
          "1",
          "--state",
          "open",
        ],
        `${base}/workshop?after=${page.next_after}&limit=1&state=open`,
      ),
    );
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].workshop_id, selected.workshop_id);
    assert.equal(next.next_after, null);
    assert.deepEqual(
      [selected.workshop_id, next.items[0].workshop_id].sort(),
      [first.workshop_id, second.workshop_id].sort(),
    );
    for (const [version, body] of [
      [1, originalBody],
      [2, replacement],
    ]) {
      const recovered = WorkshopObjectResponseSchema.parse(
        await cli(
          ["workshop", "get", session, selected.workshop_id, "--version", String(version)],
          `${base}/workshop/${selected.workshop_id}?version=${version}`,
        ),
      );
      assert.ok(recovered.object.body_md === body);
      assert.equal(recovered.object.version, version);
      assert.equal(recovered.body_sha256, createHash("sha256").update(body).digest("hex"));
    }
    await cli(["workshop", "revise", session], `${base}/workshop`, {
      body: { workshop_id: selected.workshop_id, base_version: 2, action: "discard" },
      status: 201,
    });
    const discarded = WorkshopDirectoryResponseSchema.parse(
      await cli(
        ["workshop", "list", session, "--state", "discarded"],
        `${base}/workshop?state=discarded`,
      ),
    );
    assert.deepEqual(
      discarded.items.map((item) => item.workshop_id),
      [selected.workshop_id],
    );
    assert.deepEqual(
      await call("/cursor"),
      publicBefore,
      "private recovery does not advance the public cursor",
    );

    // Reading is not acknowledgment. The explicit ack is state-idempotent;
    // unlike publication writes, its repeat count is correctly zero.
    const inboxFellow = (await call("/v1/hello", undefined, inboxReader)).fellow.fellow_id;
    const notices = [];
    for (let i = 0; i < 2; i++)
      notices.push(
        await createInboxNotice(env.DB, {
          fellowId: inboxFellow,
          noticeType: "protocol_notice",
          title: `Private coordination notice ${i + 1}`,
        }),
      );
    const inboxBefore = (
      await env.DB.prepare(
        "SELECT id, acknowledged_at FROM fellow_inbox_notices WHERE fellow_id=? ORDER BY seq",
      )
        .bind(inboxFellow)
        .all()
    ).results;
    const firstInbox = InboxResponseSchema.parse(
      await cli(
        ["inbox", "list", "--since", "0", "--limit", "1", "--unread-only", "--json"],
        "/v1/inbox?since=0&limit=1&unread_only=true",
        { token: inboxReader },
      ),
    );
    assert.equal(firstInbox.items[0].id, notices[0].id);
    assert.equal(firstInbox.next_cursor, notices[0].seq);
    assert.equal(firstInbox.has_more, true);
    const lastInbox = InboxResponseSchema.parse(
      await cli(
        [
          "inbox",
          "list",
          "--since",
          String(firstInbox.next_cursor),
          "--limit",
          "1",
          "--unread-only",
          "--json",
        ],
        `/v1/inbox?since=${firstInbox.next_cursor}&limit=1&unread_only=true`,
        { token: inboxReader },
      ),
    );
    assert.equal(lastInbox.items[0].id, notices[1].id);
    assert.equal(lastInbox.has_more, false);
    await cli(["inbox", "list"], "/v1/inbox.md", { token: inboxReader, markdown: true });
    assert.deepEqual(
      (
        await env.DB.prepare(
          "SELECT id, acknowledged_at FROM fellow_inbox_notices WHERE fellow_id=? ORDER BY seq",
        )
          .bind(inboxFellow)
          .all()
      ).results,
      inboxBefore,
      "all CLI reads leave acknowledgment unchanged",
    );
    const ackOptions = {
      token: inboxReader,
      body: { notice_ids: [notices[0].id] },
      key: "cli-loop-ack",
    };
    assert.deepEqual(await cli(["inbox", "ack"], "/v1/inbox/ack", ackOptions), {
      acknowledged_count: 1,
      unacknowledged_count: 1,
    });
    assert.deepEqual(await cli(["inbox", "ack"], "/v1/inbox/ack", ackOptions), {
      acknowledged_count: 0,
      unacknowledged_count: 1,
    });
    const unread = InboxResponseSchema.parse(
      await cli(["inbox", "list", "--unread-only", "--json"], "/v1/inbox?unread_only=true", {
        token: inboxReader,
      }),
    );
    assert.deepEqual(
      unread.items.map((item) => item.id),
      [notices[1].id],
    );

    // Publish a target through the ordinary validator, then coordinate it.
    const draft = await cli(["workshop", "push", session], `${base}/workshop`, {
      body: {
        type: "claim-draft",
        title: "Finite path count",
        body_md: "Private count calculation.",
      },
      status: 201,
    });
    const claim = await cli(["promote", session], `${base}/promote`, {
      body: {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "Every finite path with n edges has exactly n + 1 vertices.",
        falsifier: "A finite path whose vertex count is not one greater than its edge count.",
      },
      status: 201,
    });
    const acquire = {
      object: claim.claim_id,
      objective: "Check the endpoint count.",
      deliverable: "A checked finite-path argument.",
      parallel_safe: false,
    };
    const held = LeaseAcquireResponseSchema.parse(
      await cli(["lease", "acquire", session], `${base}/leases`, {
        body: acquire,
        key: "cli-loop-lease",
        status: 201,
      }),
    ).lease;
    const peerBase = `/v1/sessions/${peerSession}`;
    const listed = LeaseListResponseSchema.parse(
      await cli(["lease", "list", peerSession], `${peerBase}/leases`, { token: reviewer }),
    );
    assert.deepEqual(listed.leases, [held]);
    const challengeOptions = {
      token: reviewer,
      body: { reason: "The holder has been idle beyond the documented interval." },
      key: "cli-loop-challenge",
    };
    const challengeArgs = ["lease", "challenge", peerSession, held.lease_id];
    const challengePath = `${peerBase}/leases/${held.lease_id}/challenge`;
    const refusal = await cli(challengeArgs, challengePath, {
      ...challengeOptions,
      status: 409,
    });
    assert.equal(refusal.code, "LEASE_NOT_STALE");
    // Explicit clock fixture; the subsequent decision and write remain the
    // real guarded Worker transition, not a mocked lease response.
    await env.DB.prepare("UPDATE sessions SET last_heartbeat_at=? WHERE session_id=?")
      .bind(new Date(Date.now() - 31 * 60 * 1000).toISOString(), session)
      .run();
    const challenged = await cli(challengeArgs, challengePath, challengeOptions);
    assert.equal(challenged.lease_id, held.lease_id);
    assert.equal(challenged.status, "challenged");
    assert.deepEqual(await cli(challengeArgs, challengePath, challengeOptions), challenged);
    const challengedList = LeaseListResponseSchema.parse(
      await cli(["lease", "list", peerSession], `${peerBase}/leases`, { token: reviewer }),
    );
    assert.equal(challengedList.leases[0]?.lease_id, held.lease_id);
    assert.equal(challengedList.leases[0]?.status, "challenged");
    assert.equal(challengedList.leases[0]?.challenge_reason, challengeOptions.body.reason);
    const challengedConflict = await cli(["lease", "acquire", peerSession], `${peerBase}/leases`, {
      token: reviewer,
      body: acquire,
      status: 409,
    });
    assert.equal(challengedConflict.code, "LEASED");
    // The original holder retains control. Only its explicit release (or
    // expiry) allows a successor; challenging an idle lease is not force-steal.
    const holderRelease = await cli(
      ["lease", "release", session, held.lease_id],
      `${base}/leases/${held.lease_id}/release`,
      { body: {}, key: "cli-loop-holder-release" },
    );
    assert.equal(holderRelease.status, "released");
    const replacementLease = LeaseAcquireResponseSchema.parse(
      await cli(["lease", "acquire", peerSession], `${peerBase}/leases`, {
        token: reviewer,
        body: acquire,
        status: 201,
      }),
    ).lease;
    const releaseOptions = {
      token: reviewer,
      body: { reason: "The bounded check is complete." },
      key: "cli-loop-release",
    };
    const releaseArgs = ["lease", "release", peerSession, replacementLease.lease_id];
    const releasePath = `${peerBase}/leases/${replacementLease.lease_id}/release`;
    const released = await cli(releaseArgs, releasePath, releaseOptions);
    assert.equal(released.status, "released");
    assert.deepEqual(await cli(releaseArgs, releasePath, releaseOptions), released);
    assert.deepEqual(
      LeaseListResponseSchema.parse(
        await cli(["lease", "list", peerSession], `${peerBase}/leases`, { token: reviewer }),
      ).leases,
      [],
    );

    // A full continuation retains its captured upper bound when a newer
    // public event arrives. Ordinary --since reads select only the delta.
    const firstFull = PackResponseSchema.parse(
      await cli(
        ["pack", session, "--profile", "full", "--max-tokens", "800"],
        `${base}/pack?profile=full&max_tokens=800`,
      ),
    );
    const controlOf = (pack) =>
      FullPackPageSchema.parse(
        JSON.parse(pack.items.find((item) => item.kind === "full-page").body),
      );
    const recordsOf = (pack) =>
      pack.items.filter((item) => item.kind === "full-event").map((item) => JSON.parse(item.body));
    let control = controlOf(firstFull);
    const through = control.through;
    assert.equal(control.after, 0);
    assert.equal(control.has_more, true, "the small token budget must produce a continuation");
    const sequences = recordsOf(firstFull).map((record) => record.seq);
    const newerDraft = await cli(["workshop", "push", session], `${base}/workshop`, {
      body: {
        type: "claim-draft",
        title: "Endpoint removal",
        body_md: "Check the resulting counts after removing one endpoint and its incident edge.",
      },
      status: 201,
    });
    const newer = await cli(["promote", session], `${base}/promote`, {
      body: {
        workshop_id: newerDraft.workshop_id,
        kind: "conjecture",
        statement:
          "Removing an endpoint and its incident edge from a path with at least two vertices reduces the vertex and edge counts by one each.",
        falsifier: "A qualifying endpoint removal that changes either count by a different amount.",
      },
      status: 201,
    });
    let pages = 1;
    while (control.has_more) {
      assert.ok(pages++ < 25, "full traversal is bounded by its captured event window");
      const after = control.next_after;
      const pack = PackResponseSchema.parse(
        await cli(
          [
            "pack",
            session,
            "--profile",
            "full",
            "--max-tokens",
            "800",
            "--after",
            String(after),
            "--through",
            String(through),
          ],
          `${base}/pack?profile=full&max_tokens=800&after=${after}&through=${through}`,
        ),
      );
      assert.equal(pack.cursor, through);
      control = controlOf(pack);
      assert.equal(control.after, after);
      assert.equal(control.through, through);
      sequences.push(...recordsOf(pack).map((record) => record.seq));
    }
    assert.deepEqual(
      sequences,
      Array.from({ length: through }, (_, i) => i + 1),
    );
    const changed = PackResponseSchema.parse(
      await cli(
        [
          "pack",
          session,
          "--profile",
          "working",
          "--max-tokens",
          "8000",
          "--since",
          String(through),
        ],
        `${base}/pack?profile=working&max_tokens=8000&since=${through}`,
      ),
    );
    assert.ok(changed.cursor > through);
    const delta = changed.items
      .filter((item) => item.kind === "orientation-event")
      .map((item) => JSON.parse(item.body));
    assert.ok(delta.length > 0);
    assert.ok(delta.every((event) => event.seq > through));
    assert.ok(
      delta.some(
        (event) =>
          event.event?.type === "claim.created" && event.event.object_id === newer.claim_id,
      ),
    );
    assert.ok(!JSON.stringify(firstFull).includes(original));
    console.log(
      JSON.stringify({
        kind: "cli-coordination-real-bindings",
        status: "pass",
        commands,
        http_requests: requestCount,
        full_pack_pages: pages,
        private_revision_history: true,
        inbox_reads_do_not_ack: true,
        explicit_ack_state_idempotent: true,
        lease_transitions: ["active", "challenged", "released"],
        proof_scope:
          "compiled Rust command/credential/file/HTTP paths through a loopback bridge to local Workerd/D1/R2; fixture approval, screening and idle clock; no TLS, Google or deployment claim",
      }),
    );
  } finally {
    bridge.closeAllConnections();
    await new Promise((resolve, reject) =>
      bridge.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
