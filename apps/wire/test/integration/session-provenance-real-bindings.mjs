import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ContractProblemSchema,
  PackResponseSchema,
  SessionCloseResponseSchema,
  SessionOpenResponseSchema,
  SessionProvenanceSchema,
  SessionStatusResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §5.5 / ADR-24: a session freezes the approved self-declaration and
// exact served document pair. Enrollment approval and screening use fixture
// seams; session admission, HTTP reads/writes and immutable storage use real
// local Workerd/D1/R2. The one legacy NULL row is an explicit closed fixture,
// never a rewrite or backfill of a captured session.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const sponsor = "usr_session_provenance_owner";
    const owner = await enroll("session-provenance-owner", sponsor);
    const other = await enroll("session-provenance-other", "usr_session_provenance_other");
    const canary = "PRIVATE_SESSION_TOOLS_NOTE_CANARY";
    const declared = {
      model: "synthetic-problem-model",
      harness: "local-problem-lifecycle-proof",
      reasoning_effort: "high",
      tools_note: `${canary}: local arithmetic and source inspection. ${"🧮".repeat(350)}`,
    };
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const read = async (path, token, expected = 200) => {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: {
          "User-Agent": userAgent,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      assert.equal(response.status, expected, `GET ${path}`);
      return { response, raw: await response.text() };
    };
    const documents = {};
    for (const name of ["protocol", "policy"]) {
      const { raw } = await read(`/${name}.md`);
      const version = /\bversion ([0-9][A-Za-z0-9.-]*)\.\s/.exec(raw)?.[1];
      assert.ok(version, `${name} states its served version`);
      documents[name] = { version, digest: sha256(raw) };
    }
    documents.pair_digest = sha256(
      [
        "asimposium.protocol-pair.v1",
        `protocol ${documents.protocol.version} ${documents.protocol.digest}`,
        `policy ${documents.policy.version} ${documents.policy.digest}`,
        "",
      ].join("\n"),
    );

    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Session provenance for elementary parity work",
          statement: "Every integer in 0..20 has a square of the same parity.",
          falsifier: "An integer in 0..20 whose square has the opposite parity.",
          motivation: "Attribute work to its recorded session declaration and exact served rules.",
          areas: ["number-theory"],
        },
        owner,
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
    const reviewSession = (
      await call(
        "/v1/sessions",
        {
          problem_id: problem,
          intent: "review",
        },
        other,
        201,
      )
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "The integer domain and parity predicate are exact.",
      },
      other,
    );
    await call(
      `/v1/sessions/${reviewSession}/close`,
      { handback: "Statement reviewed." },
      other,
      201,
    );
    const fellow = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name=?")
      .bind("session-provenance-owner")
      .first();
    assert.ok(fellow);
    const admissionState = async () => ({
      sessions: (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE fellow_id=?")
          .bind(fellow.fellow_id)
          .first()
      ).n,
      replays: (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM session_write_replays WHERE principal_scope=?",
        )
          .bind(fellow.fellow_id)
          .first()
      ).n,
      memberships: (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM problem_memberships WHERE fellow_id=?")
          .bind(fellow.fellow_id)
          .first()
      ).n,
      cursor: (
        await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problem).first()
      ).public_seq,
    });
    const before = await admissionState();
    for (const field of ["model", "harness"]) {
      const refusal = await call(
        "/v1/sessions",
        {
          problem_id: problem,
          declared: { ...declared, [field]: "UNAPPROVED_RUNTIME_CANARY" },
        },
        owner,
        422,
        "session-provenance-open",
      );
      assert.equal(refusal.code, "SCHEMA_INVALID");
      assert.equal(refusal.rule, "A3");
      assert.match(refusal.fix_hint, /new Fellow/);
      assert.ok(!JSON.stringify(refusal).includes("UNAPPROVED_RUNTIME_CANARY"));
      assert.deepEqual(
        await admissionState(),
        before,
        "a mismatch grants nothing and retains no replay",
      );
    }

    const request = { problem_id: problem, intent: "prove", declared };
    const open = async (body = request, expected = 201) => {
      const response = await worker.fetch(`${origin}/v1/sessions`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${owner}`,
          "content-type": "application/json",
          "idempotency-key": "session-provenance-open",
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, expected);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return response.text();
    };
    const receipt = await open();
    const session = SessionOpenResponseSchema.parse(JSON.parse(receipt));
    const expected = {
      declared,
      attestation: "self_declared",
      observed: { opened_via: "explicit" },
      documents,
    };
    assert.deepEqual(
      session.provenance,
      expected,
      "the snapshot pins the actual served bytes and labels declarations honestly",
    );
    const path = `/v1/sessions/${session.session_id}`;
    const stored = async (id = session.session_id) =>
      env.DB.prepare(
        "SELECT session_id, fellow_id, provenance_json, last_heartbeat_at, closed_at FROM sessions WHERE session_id=?",
      )
        .bind(id)
        .first();
    const admitted = await stored();
    assert.deepEqual(SessionProvenanceSchema.parse(JSON.parse(admitted.provenance_json)), expected);
    const status = async (id = session.session_id) => {
      const { response, raw } = await read(`/v1/sessions/${id}`, owner);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return SessionStatusResponseSchema.parse(JSON.parse(raw));
    };
    assert.deepEqual((await status()).provenance, expected);
    assert.ok(!(await status()).omitted.includes("session_identity_metadata"));
    assert.ok(
      (await status()).omitted.includes("protocol_policy_ack"),
      "recording served versions does not fabricate acknowledgement",
    );
    // This published problem has no claims yet. A recoverable missing review
    // target must remain a valid teaching refusal, not fail its own envelope
    // validator and become an opaque 500. The private session note stays out.
    const emptyReview = await read(`${path}/pack?profile=review&max_tokens=8000`, owner, 400);
    const missingTarget = ContractProblemSchema.parse(JSON.parse(emptyReview.raw));
    assert.equal(missingTarget.code, "SCHEMA_INVALID");
    assert.equal(missingTarget.rule, "A5");
    assert.deepEqual(missingTarget.example, { profile: "review", target: "C-1@1" });
    assert.equal(emptyReview.response.headers.get("cache-control"), "private, no-store");
    assert.equal(emptyReview.response.headers.get("retry-after"), null);
    assert.ok(!emptyReview.raw.includes(canary));
    assert.equal(await open(request, 200), receipt, "an exact retry returns the original bytes");
    const changedRetry = JSON.parse(
      await open(
        {
          ...request,
          declared: { ...declared, reasoning_effort: "low" },
        },
        409,
      ),
    );
    assert.equal(changedRetry.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await admissionState()).sessions, before.sessions + 1);

    // A direct publication joins the explicit session and exercises public
    // projections that could accidentally copy its private tools note.
    const explicitClaim = await call(
      `/v1/p/${problem}/claims`,
      {
        kind: "conjecture",
        statement: "Zero squared is even.",
        falsifier: "Zero squared is odd.",
      },
      owner,
      201,
    );
    const publication = await env.DB.prepare(
      "SELECT actor_session_id FROM events WHERE problem_id=? AND object_id=? AND type='claim.created'",
    )
      .bind(problem, explicitClaim.claim_id)
      .first();
    assert.equal(publication.actor_session_id, session.session_id);
    assert.equal((await stored()).provenance_json, admitted.provenance_json);

    const { tools_note: _privateTools, ...packDeclared } = declared;
    for (const profile of ["working", "full"]) {
      for (const budget of [800, 8000]) {
        const { response, raw } = await read(
          `${path}/pack?profile=${profile}&max_tokens=${budget}`,
          owner,
        );
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const pack = PackResponseSchema.parse(JSON.parse(raw));
        assert.deepEqual(pack.provenance, { ...expected, declared: packDeclared });
        assert.ok(
          pack.omitted.some(
            (item) =>
              item.reason === "session_provenance_detail" &&
              item.detail ===
                `The declared tools note is available from the owning GET ${path} status read.`,
          ),
        );
        assert.ok(!raw.includes(canary));
        assert.ok(!Object.hasOwn(pack.provenance.declared, "tools_note"));
        assert.ok(pack.tokens_estimate <= budget);
        assert.ok(
          Math.ceil(Buffer.byteLength(raw) / 4) <= budget,
          `${profile} counts the snapshot and omission disclosure in its actual byte budget`,
        );
        if (profile === "full") {
          const page = pack.items.find((item) => item.id === "SYS-full-page");
          assert.ok(page);
          assert.ok(JSON.parse(page.body).records > 0, "a small full page still makes progress");
        }
      }
    }
    for (const target of [path, `${path}/pack?profile=working`, `${path}/pack?profile=full`]) {
      const { response, raw } = await read(target, other, 404);
      assert.ok(response.headers.get("cache-control")?.includes("no-store"));
      assert.equal(JSON.parse(raw).code, "SESSION_NOT_FOUND");
      assert.ok(!raw.includes(canary));
    }
    for (const target of [
      `/p/${problem}.md`,
      `/p/${problem}.json`,
      `/p/${problem}/events.json`,
      `/p/${problem}/claims/${explicitClaim.claim_id}@1.md`,
      `/p/${problem}/claims/${explicitClaim.claim_id}@1.json`,
    ]) {
      assert.ok(!(await read(target)).raw.includes(canary), `public ${target} keeps tools private`);
    }
    const publicLeak = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events e JOIN event_content c ON c.event_id=e.id WHERE e.problem_id=? AND instr(c.payload_json, ?) > 0",
    )
      .bind(problem, canary)
      .first();
    assert.equal(publicLeak.n, 0, "no public event body stores the session tools note");

    await call(`${path}/heartbeat`, {}, owner);
    assert.equal((await stored()).provenance_json, admitted.provenance_json);
    assert.deepEqual((await status()).provenance, expected);
    for (const replacement of [null, JSON.stringify({ ...expected, attestation: "verified" })]) {
      await assert.rejects(
        env.DB.prepare("UPDATE sessions SET provenance_json=? WHERE session_id=?")
          .bind(replacement, session.session_id)
          .run(),
        /SESSION_PROVENANCE_IMMUTABLE/,
      );
    }
    SessionCloseResponseSchema.parse(
      await call(
        `${path}/close`,
        {
          handback: "The parity claim and exact session attribution are recorded.",
        },
        owner,
        201,
      ),
    );
    assert.notEqual((await status()).closed_at, null);
    assert.deepEqual((await status()).provenance, expected);
    assert.equal((await stored()).provenance_json, admitted.provenance_json);
    assert.equal(
      await open(request, 200),
      receipt,
      "replay after close cannot rewrite or reopen the session",
    );
    assert.notEqual((await stored()).closed_at, null);

    // With no open owner session, the normal direct-claim route must create,
    // attribute, and close an implicit session with its own immutable snapshot.
    const implicitClaim = await call(
      `/v1/p/${problem}/claims`,
      {
        kind: "conjecture",
        statement: "One squared is odd.",
        falsifier: "One squared is even.",
      },
      owner,
      201,
    );
    const implicitEvent = await env.DB.prepare(
      "SELECT actor_session_id FROM events WHERE problem_id=? AND object_id=? AND type='claim.created'",
    )
      .bind(problem, implicitClaim.claim_id)
      .first();
    assert.ok(implicitEvent.actor_session_id);
    assert.notEqual(implicitEvent.actor_session_id, session.session_id);
    const implicit = await stored(implicitEvent.actor_session_id);
    const implicitExpected = {
      declared: { model: declared.model, harness: declared.harness },
      attestation: "self_declared",
      observed: { opened_via: "implicit" },
      documents,
    };
    assert.deepEqual(
      SessionProvenanceSchema.parse(JSON.parse(implicit.provenance_json)),
      implicitExpected,
    );
    assert.deepEqual((await status(implicit.session_id)).provenance, implicitExpected);
    assert.notEqual(implicit.closed_at, null);
    await assert.rejects(
      env.DB.prepare("UPDATE sessions SET provenance_json=NULL WHERE session_id=?")
        .bind(implicit.session_id)
        .run(),
      /SESSION_PROVENANCE_IMMUTABLE/,
    );

    const legacy = `S-${"L".repeat(26)}`;
    await env.DB.prepare(`INSERT INTO sessions
    (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, closed_at, provenance_json)
    VALUES (?, ?, ?, 'explore', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z',
      '2026-08-18T12:00:00.000Z', '2026-08-18T01:00:00.000Z', NULL)`)
      .bind(legacy, fellow.fellow_id, problem)
      .run();
    const legacyStatus = await status(legacy);
    assert.equal(legacyStatus.provenance, null);
    assert.ok(legacyStatus.omitted.includes("session_identity_metadata"));
    await assert.rejects(
      env.DB.prepare("UPDATE sessions SET provenance_json=? WHERE session_id=?")
        .bind(admitted.provenance_json, legacy)
        .run(),
      /SESSION_PROVENANCE_IMMUTABLE/,
    );
    assert.equal(
      (await stored(legacy)).provenance_json,
      null,
      "reading a historical session does not manufacture today's terms for it",
    );

    console.log(
      JSON.stringify({
        kind: "session-provenance-real-bindings",
        status: "pass",
        scope:
          "real local Workerd/D1/R2; fixture enrollment approval and screening; no deployed or model attestation claim",
        probes: [
          "served-document-digests",
          "immutable-version-pair",
          "explicit-declaration",
          "mismatch-no-write",
          "owner-recovery",
          "bounded-working-full-packs",
          "private-tools-note",
          "cross-owner-isolation",
          "exact-replay",
          "heartbeat-and-close",
          "implicit-direct-claim",
          "real-d1-immutability",
          "legacy-null-no-backfill",
        ],
      }),
    );
  },
);
