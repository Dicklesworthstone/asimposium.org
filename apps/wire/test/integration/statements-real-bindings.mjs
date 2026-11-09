import assert from "node:assert/strict";
import {
  StatementHistoryResponseSchema,
  StatementResponseSchema,
} from "@asimposium/contracts/statements";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Genuine local Workerd/D1/R2: author, sponsor and screening observations are
// fixtures. This proves the public product journey, not deployed OAuth/model use.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, reviseStatement, operatorCall, worker, fixtures, env, origin, userAgent }) => {
    const owner = "usr_statement_history_owner";
    const author = await enroll("statement-history-author", owner);
    const privateText = "A private preliminary tree formulation, never published.";
    const formulation = {
      statement: "Every finite tree has one fewer edge than vertices.",
      falsifier: "A finite tree with an edge count other than its vertex count minus one.",
      motivation: "Establish the connected-graph invariant. <script>unsafe()</script>",
    };
    const boundaries = {
      scope: "  Finite labelled undirected trees.\n",
      out_of_scope: "Infinite graphs, disconnected forests and graph enumeration.",
      success_criteria: "An independently reviewable proof or an explicit finite counterexample.",
    };
    const created = await call(
      "/v1/problems",
      {
        title: "Published tree formulation history",
        ...formulation,
        statement: privateText,
        ...boundaries,
        scope: "Private preliminary scope, never published.",
        areas: ["combinatorics"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    const lifecyclePath = `/v1/sponsors/problems/${problem}/lifecycle`;
    const govern = (body) => body.action === "revise-statement" && "statement" in body
      ? reviseStatement(problem, owner, author, body)
      : sponsorCall(owner, "POST", lifecyclePath, "problem-lifecycle", body);
    const read = async (path, init = {}) =>
      worker.fetch(`${origin}${path}`, {
        ...init,
        redirect: "manual",
        headers: { "User-Agent": userAgent, ...init.headers },
      });
    const history = async (query = "") =>
      StatementHistoryResponseSchema.parse(await call(`/p/${problem}/statements.json${query}`));
    const exact = async (version, query = "") =>
      StatementResponseSchema.parse(await call(`/p/${problem}/statements/${version}.json${query}`));

    await call(`/p/${problem}/statements.json`, undefined, undefined, 404);
    await call(`/p/${problem}/statements/1.json`, undefined, undefined, 404);
    const privateRevision = await govern({
      action: "revise-statement",
      ...formulation,
      ...boundaries,
    });
    assert.equal(privateRevision.problem.current_statement_version, 2);
    const preview = await sponsorCall(
      owner,
      "GET",
      `/v1/sponsors/problems/${problem}/publication-preview`,
      "problem-publication-preview",
    );
    await govern({
      action: "publish",
      reviewed_statement_version: 2,
      reviewed_digest: preview.review_digest,
    });
    const admitted = await exact(2);
    assert.equal(admitted.statement.scope, boundaries.scope);
    assert.equal(admitted.statement.source_fellow_id, created.problem.created_by_fellow_id);
    assert.deepEqual(admitted.statement.acting_principal, { type: "sponsor", id: owner });
    assert.equal(admitted.statement.publication.seq, admitted.cursor);
    await call(`/p/${problem}/statements/1.json`, undefined, undefined, 404);

    for (let version = 3; version <= 7; version++) {
      const revision = await govern({
        action: "revise-statement",
        ...formulation,
        ...boundaries,
        scope: `Finite trees within public boundary ${version}.`,
      });
      assert.equal(revision.problem.current_statement_version, version);
    }
    const first = await history();
    assert.deepEqual(
      first.statements.map((item) => item.version),
      [2, 3, 4, 5],
    );
    assert.equal(first.count, 4);
    assert.equal(first.next_after, first.statements.at(-1).publication.seq);
    assert.deepEqual(first.omitted, ["page_limit"]);
    assert.equal(JSON.stringify(first).includes(privateText), false);
    assert.equal(JSON.stringify(first).includes("Private preliminary scope"), false);
    await govern({
      action: "revise-statement",
      ...formulation,
      ...boundaries,
      scope: "A newer formulation outside the captured history.",
    });
    const next = await history(`?through=${first.cursor}&after=${first.next_after}`);
    assert.deepEqual(
      next.statements.map((item) => item.version),
      [6, 7],
    );
    assert.equal(next.next_after, null);
    assert.equal(next.cursor, first.cursor);
    assert.deepEqual((await exact(2, `?through=${admitted.cursor}`)).statement, admitted.statement);
    await call(
      `/p/${problem}/statements/3.json?through=${admitted.cursor}`,
      undefined,
      undefined,
      404,
    );
    assert.deepEqual((await history("?through=0")).statements, []);

    for (const format of ["json", "md"]) {
      const legacy = await read(`/p/${problem}.${format}?statement=2&through=${admitted.cursor}`);
      assert.equal(legacy.status, 308);
      assert.equal(
        legacy.headers.get("location"),
        `/p/${problem}/statements/2.${format}?through=${admitted.cursor}`,
      );
    }
    for (const query of [
      "through=01",
      `through=${first.cursor + 100}`,
      "through=1&through=2",
      "limit=200",
      "after=9007199254740992",
    ]) {
      await call(`/p/${problem}/statements.json?${query}`, undefined, undefined, 400);
    }
    for (const version of ["0", "01", "-1", "1e2", "9007199254740992"]) {
      await call(`/p/${problem}/statements/${version}.json`, undefined, undefined, 400);
    }

    for (const format of ["json", "md", "html"]) {
      for (const tail of ["statements", "statements/2"]) {
        const path = `/p/${problem}/${tail}.${format}?through=${first.cursor}`;
        const response = await read(path);
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(body.includes("Finite labelled undirected trees."));
        if (format === "html") {
          assert.equal(body.includes("<script>unsafe()</script>"), false);
          assert.ok(response.headers.get("content-security-policy").includes("default-src 'none'"));
        }
        const head = await read(path, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        assert.equal(head.headers.get("etag"), response.headers.get("etag"));
        assert.equal(
          (await read(path, { headers: { "if-none-match": response.headers.get("etag") } })).status,
          304,
        );
        if (tail === "statements") assert.ok(response.headers.get("link").includes('rel="next"'));
      }
    }

    const exactPath = `/p/${problem}/statements/2.json?through=${admitted.cursor}`;
    const exactBefore = await read(exactPath);
    const exactBytes = await exactBefore.text();
    const exactEtag = exactBefore.headers.get("etag");
    const control = (action) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: problem,
        target_kind: "problem",
        action,
        reason: "Verify exact historical statement availability.",
      });
    await control("hide");
    assert.equal((await read(exactPath, { headers: { "if-none-match": exactEtag } })).status, 404);
    assert.equal(
      (
        await read(`/p/${problem}/statements.json?through=${first.cursor}`, {
          headers: { "if-none-match": "*" },
        })
      ).status,
      404,
    );
    await control("restore");
    const restored = await read(exactPath);
    assert.equal(await restored.text(), exactBytes);
    assert.equal(restored.headers.get("etag"), exactEtag);

    const replay = await operatorCall(
      "GET",
      `/v1/operators/problems/${problem}/projections`,
      "operator.projections.read",
      undefined,
      200,
      "/v1/operators/problems/:problemId/projections",
    );
    assert.equal(replay.status, "consistent");
    assert.deepEqual(replay.drift, []);
    const historyPath = `/p/${problem}/statements.json?through=${first.cursor}`;
    const beforeRace = await read(historyPath);
    const historyEtag = beforeRace.headers.get("etag");
    const cursorBeforeRedaction = (
      await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problem).first()
    ).public_seq;
    // Withdraw the source after head capture but before the real read batch. A
    // historical request must apply present-day availability in that same batch.
    await fixtures.armRaceBeforeNextBatch(
      "UPDATE event_content SET payload_json='{\"control\":\"redacted\"}',redacted_at=?,redaction_reason='privacy' WHERE event_id=?",
      [new Date().toISOString(), admitted.statement.publication.event_id],
      "WITH selected AS",
    );
    const racing = await read(historyPath, { headers: { "if-none-match": historyEtag } });
    assert.equal(await fixtures.raceStillArmed(), false);
    assert.equal(racing.status, 200);
    const withdrawn = StatementHistoryResponseSchema.parse(await racing.json());
    assert.deepEqual(
      withdrawn.statements.map((item) => item.version),
      [3, 4, 5],
    );
    assert.ok(withdrawn.omitted.includes("content_unavailable"));
    assert.equal(withdrawn.next_after, first.next_after);
    assert.equal(withdrawn.cursor, first.cursor);
    assert.equal(JSON.stringify(withdrawn).includes(boundaries.scope.trim()), false);
    assert.equal((await read(exactPath, { headers: { "if-none-match": exactEtag } })).status, 404);
    assert.equal(
      (await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problem).first())
        .public_seq,
      cursorBeforeRedaction,
    );
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT scope FROM problem_statement_versions WHERE problem_id=? AND version=2",
        )
          .bind(problem)
          .first()
      ).scope,
      boundaries.scope,
    );
    assert.deepEqual(await history(`?through=${first.cursor}&after=${first.next_after}`), next);

    console.log(
      JSON.stringify({
        kind: "statements-real-bindings",
        status: "pass",
        scope:
          "real local Workerd/D1/R2; fixture identity and screening; no deployed or live-model proof",
        probes: [
          "private-drafts-never-published",
          "exact-published-formulation-and-boundaries",
          "recorded-authorship",
          "boundary-only-revision-history",
          "bounded-history-continuation",
          "frozen-cursor-after-later-revision",
          "truthful-legacy-statement-alias",
          "strict-cursor-and-version-decoding",
          "json-markdown-html-head-parity",
          "conditional-read-current-visibility",
          "source-redaction-at-read-batch",
          "withheld-history-continuation",
          "no-projection-resurrection",
        ],
      }),
    );
    return {
      projectionParityExpect: {
        [problem]: { status: "unreplayable", drift: ["problem_statement_versions:orphan_row:2"] },
      },
    };
  },
);
