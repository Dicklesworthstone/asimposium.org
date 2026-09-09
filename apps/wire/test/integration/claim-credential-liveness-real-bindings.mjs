import assert from "node:assert/strict";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(
  async ({ call, enroll, fixtures, env, sponsorCall, worker, origin, userAgent }) => {
    for (const mode of ["active", "pause", "expiry"]) {
      for (const action of ["promote", "revise"]) {
        const sponsor = `usr_live_${mode}_${action}`;
        let token = await enroll(`live-${mode}-${action}`, sponsor);
        if (mode === "expiry") {
          const invitation = await sponsorCall(
            sponsor,
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
              name: `expires-${action}`,
              model: "expiry-proof",
              harness: "local-proof",
            },
            undefined,
            202,
          );
          await fixtures.approve(sponsor, invitation.enrollment_id);
          token = (await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle })).token;
        }
        // The active problem is an explicit fixture. All credential and claim writes use real routes.
        const problem = `P-LIVE${mode.toUpperCase()}${action.toUpperCase()}`;
        await fixtures.seedProblem(problem, sponsor);
        const session = await call(
          "/v1/sessions",
          { problem_id: problem, intent: "explore" },
          token,
          201,
        );
        const draft = await call(
          `/v1/sessions/${session.session_id}/workshop`,
          {
            type: "draft",
            title: "Finite path check",
            body_md: "A deliberate finite path conjecture.",
            relates_to: [],
          },
          token,
          201,
        );
        let body = {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement:
            "For every finite simple path, the number of vertices is one plus the number of edges.",
          falsifier: "A finite simple path with a different number of vertices.",
        };
        if (action === "revise") {
          const claim = await call(`/v1/sessions/${session.session_id}/promote`, body, token, 201);
          body = {
            claim_id: claim.claim_id,
            base_version: 1,
            kind: "conjecture",
            statement:
              "For every nonempty finite simple path with k edges, there are exactly k + 1 vertices.",
            falsifier: "A nonempty finite simple path with a vertex count different from k + 1.",
          };
        }
        const fellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
          .bind(session.session_id)
          .first();
        async function state() {
          const result = {};
          for (const [name, sql] of Object.entries({
            problem: "SELECT * FROM problems WHERE id = ?",
            events: "SELECT * FROM events WHERE problem_id = ? ORDER BY seq",
            content:
              "SELECT * FROM event_content WHERE event_id IN (SELECT id FROM events WHERE problem_id = ?) ORDER BY event_id",
            claims: "SELECT * FROM claims WHERE problem_id = ? ORDER BY id",
            versions:
              "SELECT * FROM claim_versions WHERE problem_id = ? ORDER BY claim_id, version",
            projections: "SELECT * FROM claim_projections WHERE problem_id = ? ORDER BY claim_id",
            keys: "SELECT * FROM idempotency WHERE problem_id = ? ORDER BY idempotency_key",
            checkpoints:
              "SELECT * FROM integrity_checkpoints WHERE problem_id = ? ORDER BY checkpoint_seq",
            // Delivery may proceed independently; compare the immutable publication footprint.
            outbox:
              "SELECT id, event_id, kind, dedupe_key, payload_sha256 FROM outbox WHERE problem_id = ? ORDER BY id",
          }))
            result[name] = (await env.DB.prepare(sql).bind(problem).all()).results;
          result.replays = (
            await env.DB.prepare(
              "SELECT * FROM session_write_replays WHERE principal_scope = ? ORDER BY scope, idempotency_key",
            )
              .bind(fellow.fellow_id)
              .all()
          ).results;
          result.cursor = await env.DB.prepare(
            "SELECT cursor FROM public_cursor WHERE singleton = 1",
          ).first();
          return result;
        }
        const route = `/v1/sessions/${session.session_id}/${action}`;
        const write = () =>
          worker.fetch(`${origin}${route}`, {
            method: "POST",
            headers: {
              "User-Agent": userAgent,
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "Idempotency-Key": `${mode}-${action}-stable`,
            },
            body: JSON.stringify(body),
          });
        const before = await state();
        const screens = await fixtures.screeningCalls();
        if (mode !== "active") await fixtures.pauseScreening(mode === "expiry" ? 6000 : 2000);
        const pending = write();
        if (mode !== "active") {
          for (let i = 0; i < 100 && (await fixtures.screeningCalls()) === screens; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(
            await fixtures.screeningCalls(),
            screens + 1,
            "The request must authenticate and enter screening before the lifecycle change",
          );
        }
        if (mode === "pause") {
          await sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
            fellow_id: fellow.fellow_id,
            status: "paused",
            confirm: "change-fellow-lifecycle",
            step_up_authenticated_at: Math.floor(Date.now() / 1000),
          });
        }
        const response = await pending;
        await fixtures.resumeScreening();
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const raw = await response.text();
        if (mode === "active") {
          assert.equal(response.status, 201);
          assert.equal(typeof JSON.parse(raw).claim_id, "string");
          const committed = await state();
          assert.equal(committed.events.length, before.events.length + 1);
          assert.equal(committed.cursor.cursor, before.cursor.cursor + 1);
          assert.equal(committed.problem[0].public_seq, before.problem[0].public_seq + 1);
          const repeated = await write();
          assert.equal(repeated.status, 200);
          assert.equal(
            await repeated.text(),
            raw,
            "A lost-response retry must return the sealed original bytes",
          );
          assert.equal(
            await fixtures.screeningCalls(),
            screens + 1,
            "Replay must not charge another screen",
          );
          assert.deepEqual(await state(), committed);
        } else {
          assert.equal(response.status, 403, `${action}/${mode} must refuse at commit`);
          const refusal = ProblemDocumentSchema.parse(JSON.parse(raw));
          assert.equal(refusal.code, "WRITE_REFUSED");
          assert.deepEqual(
            await state(),
            before,
            "Late lifecycle refusal must roll back every public effect and replay",
          );
          assert.equal(await fixtures.screeningCalls(), screens + 1);
        }
        console.log(
          JSON.stringify({ kind: "claim-credential-liveness-case", action, mode, status: "pass" }),
        );
      }
    }
    console.log(
      JSON.stringify({
        kind: "claim-credential-liveness-real-bindings",
        status: "pass",
        cases: 6,
        boundary:
          "Actual local Workerd/D1/R2 and signed sponsor enrollment/pause; seeded active problems and synthetic classifier timing; no OAuth or deployment claim",
      }),
    );
  },
);
