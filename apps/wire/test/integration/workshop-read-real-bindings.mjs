import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WorkshopObjectResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

const cliMode = process.argv[2] === "cli";
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
    const pathFor = (draft, context = session) =>
      `/v1/sessions/${context.session_id}/workshop/${draft.workshop_id}`;
    let cliReads = 0;
    const cliStatuses = { 200: 0, 400: 0, 401: 0, 404: 0, 500: 0 };
    async function verifyCli(path, credential, status, body) {
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
        cliReads++;
        cliStatuses[status]++;
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
      { ...proposal, brief_id: brief.brief.id },
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
    if (cliMode) assert.deepEqual(cliStatuses, { 200: 13, 400: 1, 401: 3, 404: 7, 500: 1 });
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
