import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PackResponseSchema,
  SessionCloseResponseSchema,
  SingleSynthesisResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Enrollment and classifier responses use the established fixture seam. Every
// session, source publication, close transaction and pack crosses real Workerd
// HTTP and D1; private workshop bodies also cross the private R2 binding.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

const receipt = await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent }) => {
    const sponsor = "usr_shared_handoff_author";
    const author = await enroll("shared-handoff-author", sponsor);
    const reader = await enroll("shared-handoff-reader", "usr_shared_handoff_reader");
    const newcomer = await enroll("shared-handoff-newcomer", "usr_shared_handoff_newcomer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Finite residue methods for integer squares",
          statement: "The square of every odd integer has residue one modulo eight.",
          falsifier: "An odd integer whose square has a different residue modulo eight.",
          motivation:
            "Carry a public research boundary across sessions without disclosing private notes.",
          areas: ["number-theory"],
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
    const open = async (token, intent = "explore") =>
      (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
    const one = (sql, ...bindings) =>
      env.DB.prepare(sql)
        .bind(...bindings)
        .first();
    const sessionState = (session) =>
      one(
        "SELECT fellow_id, closed_at, handback, shared_handoff_json FROM sessions WHERE session_id = ?",
        session,
      );
    const publicState = () =>
      one(
        `SELECT public_seq, chain_digest,
        (SELECT COUNT(*) FROM events WHERE problem_id = p.id) AS events,
        (SELECT COUNT(*) FROM claims WHERE problem_id = p.id) AS claims,
        (SELECT COUNT(*) FROM outbox WHERE problem_id = p.id) AS outbox
       FROM problems p WHERE id = ?`,
        problem,
      );
    const close = async (session, token, key, body, expected = 201) => {
      const response = await worker.fetch(`${origin}/v1/sessions/${session}/close`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      const data = JSON.parse(raw);
      assert.equal(response.status, expected, data.code ?? "session close status");
      assert.ok(response.headers.get("cache-control")?.includes("no-store"));
      if (expected === 200 || expected === 201) SessionCloseResponseSchema.parse(data);
      return { raw, data };
    };
    const pack = async (session, token, profile = "working") =>
      PackResponseSchema.parse(
        await call(
          `/v1/sessions/${session}/pack?profile=${profile}&max_tokens=8000`,
          undefined,
          token,
        ),
      );
    const share = (synthesis) => ({
      synthesis_id: synthesis.synthesis_id,
      event_id: synthesis.event_id,
    });
    const privateAuthor = "PRIVATE_AUTHOR_HANDBACK: retain the unshared failed calculation.";
    const privateReader = "PRIVATE_READER_HANDBACK: my minority boundary needs examination.";
    const privateWorkshop =
      "PRIVATE_WORKSHOP_CALCULATION: intermediate notes remain private.\n".repeat(40);
    const readerPrior = await open(reader, "review");
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: readerPrior,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "The domain, residue predicate and counterexample are explicit.",
      },
      reader,
    );
    await close(readerPrior, reader, "reader-private-close", { handback: privateReader });

    const draft = async (session, statement, falsifier) =>
      call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "claim-draft",
          title: "A bounded integer calculation",
          body_md: privateWorkshop,
          ledger_intent: { kind: "create", target_kind: "claim" },
          publication: {
            kind: "conjecture",
            statement,
            falsifier,
            depends_on: [],
            relates_to: [],
          },
        },
        author,
        201,
      );
    const firstSession = await open(author);
    assert.equal(
      (await sessionState(firstSession)).shared_handoff_json,
      null,
      "migration 0154 is applied",
    );
    const firstDraft = await draft(
      firstSession,
      "The square of an odd integer has residue one modulo eight.",
      "An odd integer whose square has a residue other than one modulo eight.",
    );
    const privateHead = await one(
      "SELECT cas_hash FROM workshop_objects WHERE workshop_id = ?",
      firstDraft.workshop_id,
    );
    assert.ok(privateHead.cas_hash, "the journey exercises private R2 storage");
    const privateKey = `cas/sha256/${privateHead.cas_hash.slice("sha256:".length)}`;
    assert.equal(await (await env.ARTIFACTS.get(privateKey)).text(), privateWorkshop);
    assert.equal(await env.PUBLIC_ARTIFACTS.get(privateKey), null);
    const claim = await call(
      `/v1/sessions/${firstSession}/promote`,
      { workshop_id: firstDraft.workshop_id, expected_workshop_version: 1 },
      author,
      201,
    );
    const synthesize = async (session, body) =>
      call(
        `/v1/sessions/${session}/synthesize`,
        {
          covers_through: (await publicState()).public_seq,
          body_md: body,
          anchors: [{ target_kind: "claim", target_id: claim.claim_id, target_version: 1 }],
          omitted: [],
          selection_policy: "Retain the recorded conjecture and its unresolved independent check.",
        },
        author,
        201,
      );
    const firstSynthesis = await synthesize(
      firstSession,
      "PUBLIC_HANDOFF_FIRST: reduce the odd integers to their four residue classes; independent checking remains open.",
    );
    const firstRequest = { handback: privateAuthor, shared_handoff: share(firstSynthesis) };
    const beforePlainClose = await publicState();
    const first = await close(firstSession, author, "shared-first-close", firstRequest);
    assert.deepEqual(
      await publicState(),
      beforePlainClose,
      "designation appends no synthetic science event",
    );
    const source = await one(
      "SELECT payload_sha256 FROM events WHERE id = ?",
      firstSynthesis.event_id,
    );
    assert.deepEqual(first.data.shared_handoff, {
      ...share(firstSynthesis),
      seq: firstSynthesis.sequence,
      payload_sha256: source.payload_sha256,
      read_url: `/p/${problem}/syntheses/${firstSynthesis.synthesis_id}.json`,
    });
    const firstClosed = await sessionState(firstSession);
    assert.equal(firstClosed.handback, privateAuthor);
    const { read_url: _readUrl, ...storedPin } = first.data.shared_handoff;
    assert.deepEqual(JSON.parse(firstClosed.shared_handoff_json), storedPin);
    assert.ok(!firstClosed.shared_handoff_json.includes("PUBLIC_HANDOFF_FIRST"));

    const readerSession = await open(reader);
    const newcomerSession = await open(newcomer);
    const assertShared = (projection, synthesis) => {
      const shared = projection.items.filter((item) => item.kind === "shared-handoff");
      assert.equal(shared.length, 1);
      assert.equal(shared[0].id, synthesis.synthesis_id);
      assert.equal(shared[0].untrusted, true);
      const content = JSON.parse(shared[0].body);
      assert.equal(content.publication_event_id, synthesis.event_id);
      assert.equal(content.synthesis.seq, synthesis.sequence);
      assert.ok(content.coordination.includes("not frozen at the ledger cursor"));
      assert.ok(!JSON.stringify(projection).includes(privateAuthor));
      assert.ok(!JSON.stringify(projection).includes("PRIVATE_WORKSHOP_CALCULATION"));
      return shared[0];
    };
    for (const profile of ["orient", "working"]) {
      const arriving = await pack(newcomerSession, newcomer, profile);
      assertShared(arriving, firstSynthesis);
      assert.ok(!JSON.stringify(arriving).includes(privateReader));
      const resumed = await pack(readerSession, reader, profile);
      assertShared(resumed, firstSynthesis);
      const own = resumed.items.findIndex(
        (item) => item.kind === "handback" && item.body.includes(privateReader),
      );
      const shared = resumed.items.findIndex((item) => item.kind === "shared-handoff");
      assert.ok(
        own >= 0 && own < shared,
        "own minority finding is included before shared narrative",
      );
    }
    for (const profile of ["review", "full"]) {
      const projection = await pack(readerSession, reader, profile);
      assert.ok(!projection.items.some((item) => item.kind === "shared-handoff"));
      assert.ok(!JSON.stringify(projection).includes(privateAuthor));
    }
    const beforeForeignClose = await sessionState(readerSession);
    const foreign = await close(
      readerSession,
      reader,
      "foreign-shared-close",
      { handback: privateReader, shared_handoff: share(firstSynthesis) },
      422,
    );
    assert.equal(foreign.data.code, "SESSION_CLOSE_BODY_INVALID");
    assert.deepEqual(await sessionState(readerSession), beforeForeignClose);

    // The second selection is committed with a genuine close-time publication.
    const secondSession = await open(author);
    const secondSynthesis = await synthesize(
      secondSession,
      "PUBLIC_HANDOFF_LATEST: the four odd residue classes remain the complete finite check; do not mistake the conjecture for independent validation.",
    );
    const secondDraft = await draft(
      secondSession,
      "The square of every even integer is divisible by four.",
      "An even integer whose square is not divisible by four.",
    );
    const secondRequest = {
      handback: privateAuthor,
      shared_handoff: share(secondSynthesis),
      promote: [secondDraft.workshop_id],
    };
    const beforeInvalid = await publicState();
    const secondBefore = await sessionState(secondSession);
    const screensBeforeInvalid = await fixtures.screeningCalls();
    const invalid = await close(
      secondSession,
      author,
      "invalid-shared-promotion-close",
      {
        ...secondRequest,
        shared_handoff: { ...share(secondSynthesis), event_id: "E-NOT-THE-SOURCE" },
      },
      422,
    );
    assert.equal(invalid.data.code, "SESSION_CLOSE_BODY_INVALID");
    assert.deepEqual(await sessionState(secondSession), secondBefore);
    assert.deepEqual(await publicState(), beforeInvalid);
    assert.equal(await fixtures.screeningCalls(), screensBeforeInvalid);
    assert.equal(
      await one(
        "SELECT 1 AS present FROM session_write_replays WHERE idempotency_key = ?",
        "invalid-shared-promotion-close",
      ),
      null,
      "invalid source is refused before creating a close reservation",
    );
    const second = await close(secondSession, author, "shared-promoting-close", secondRequest);
    assert.equal(second.data.promoted.length, 1);
    assert.equal(second.data.shared_handoff.event_id, secondSynthesis.event_id);
    assert.equal((await publicState()).public_seq, beforeInvalid.public_seq + 1);
    assert.equal(
      (
        await one(
          "SELECT state FROM workshop_objects WHERE workshop_id = ?",
          secondDraft.workshop_id,
        )
      ).state,
      "archived",
    );
    assertShared(await pack(readerSession, reader), secondSynthesis);
    const exact = SingleSynthesisResponseSchema.parse(
      await call(second.data.shared_handoff.read_url),
    );
    assert.equal(exact.synthesis.body_md.startsWith("PUBLIC_HANDOFF_LATEST"), true);
    assert.ok(!JSON.stringify(exact).includes(privateAuthor));
    const eventBody = await one(
      "SELECT payload_json FROM event_content WHERE event_id = ?",
      secondSynthesis.event_id,
    );
    assert.equal(
      createHash("sha256").update(eventBody.payload_json).digest("hex"),
      second.data.shared_handoff.payload_sha256,
    );

    const assertReplay = async () => {
      const before = await publicState();
      const screens = await fixtures.screeningCalls();
      const replay = await close(
        secondSession,
        author,
        "shared-promoting-close",
        secondRequest,
        200,
      );
      assert.equal(
        replay.raw,
        second.raw,
        "the sealed receipt replays byte-for-byte after source visibility changes",
      );
      assert.deepEqual(await publicState(), before);
      assert.equal(await fixtures.screeningCalls(), screens);
    };
    const control = async (visibility, version) => {
      await env.DB.prepare(
        `INSERT INTO content_controls(control_id, problem_id, target_kind, target_ref,
        visibility, source, reason_category, actor, reason, version, created_at)
       VALUES (?, ?, 'ledger-object', ?, ?, 'operator', 'privacy',
        'native-negative-test', 'Local shared handoff visibility proof.', ?, ?)`,
      )
        .bind(
          `CC-SHARED-${version}`,
          problem,
          secondSynthesis.synthesis_id,
          visibility,
          version,
          new Date().toISOString(),
        )
        .run();
    };
    const assertUnavailable = async () => {
      for (const profile of ["orient", "working"]) {
        const projection = await pack(readerSession, reader, profile);
        assert.ok(!projection.items.some((item) => item.kind === "shared-handoff"));
        assert.ok(projection.omitted.some((item) => item.reason === "shared_handoff_unavailable"));
        assert.ok(
          !projection.items.some((item) => item.id === firstSynthesis.synthesis_id),
          "a withheld latest handoff never falls back to an older selection",
        );
        assert.ok(!JSON.stringify(projection).includes("PUBLIC_HANDOFF_LATEST"));
        assert.ok(!JSON.stringify(projection).includes(privateAuthor));
      }
    };
    await control("hidden", 1);
    await assertUnavailable();
    await assertReplay();
    await control("visible", 2);
    assertShared(await pack(readerSession, reader), secondSynthesis);

    // A lawful source redaction during screening must roll back the complete
    // promoting close, including its private handback, workshop and lease effects.
    const raceSession = await open(author);
    const raceDraft = await draft(
      raceSession,
      "Among three consecutive integers, exactly one is divisible by three.",
      "Three consecutive integers containing zero or two multiples of three.",
    );
    const lease = await call(
      `/v1/sessions/${raceSession}/leases`,
      {
        object: claim.claim_id,
        objective: "Check finite residues",
        deliverable: "A bounded residue table",
        ttl_seconds: 1800,
      },
      author,
      201,
    );
    const beforeRace = await publicState();
    const raceBefore = await sessionState(raceSession);
    const draftBefore = await one(
      "SELECT state, current_version FROM workshop_objects WHERE workshop_id = ?",
      raceDraft.workshop_id,
    );
    await fixtures.redactOnNextScreen(secondSynthesis.event_id);
    const refused = await close(
      raceSession,
      author,
      "shared-source-redaction-race",
      {
        handback: "PRIVATE_RACE_HANDBACK: must not be committed.",
        shared_handoff: share(secondSynthesis),
        promote: [raceDraft.workshop_id],
      },
      409,
    );
    assert.ok(["OBJECT_VERSION_CONFLICT", "SCREENING_CONTEXT_STALE"].includes(refused.data.code));
    assert.deepEqual(await publicState(), beforeRace);
    assert.deepEqual(await sessionState(raceSession), raceBefore);
    assert.deepEqual(
      await one(
        "SELECT state, current_version FROM workshop_objects WHERE workshop_id = ?",
        raceDraft.workshop_id,
      ),
      draftBefore,
    );
    assert.equal(
      (await one("SELECT status FROM leases WHERE lease_id = ?", lease.lease.lease_id)).status,
      "active",
    );
    assert.ok(
      (
        await one(
          "SELECT redacted_at FROM event_content WHERE event_id = ?",
          secondSynthesis.event_id,
        )
      ).redacted_at,
    );
    await assertUnavailable();
    await assertReplay();
    const firstReplay = await close(firstSession, author, "shared-first-close", firstRequest, 200);
    assert.equal(firstReplay.raw, first.raw);
    const conflict = await close(
      secondSession,
      author,
      "shared-promoting-close",
      { ...secondRequest, shared_handoff: share(firstSynthesis) },
      409,
    );
    assert.equal(conflict.data.code, "IDEMPOTENCY_CONFLICT");
    return {
      private_handback_and_workshop_isolation: true,
      own_handback_before_cross_fellow_shared_context: true,
      exact_source_pin_and_read_receipt: true,
      plain_and_promoting_close: true,
      invalid_and_foreign_source_leave_session_open: true,
      source_redaction_rolls_back_publication_and_private_close: true,
      latest_hidden_or_redacted_source_has_no_older_fallback: true,
      exact_replay_after_hide_and_redaction: true,
    };
  },
);

console.log(
  JSON.stringify({ stage: "session-shared-handoff-journey-passed", status: "pass", receipt }),
);
