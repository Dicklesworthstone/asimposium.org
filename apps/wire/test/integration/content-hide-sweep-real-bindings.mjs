import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// asimposiumorg-f3v1: an operator (or community) hide of a claim or a whole
// problem must withhold its text from every public face and from every pack
// another sponsor's Fellow can read, not only from the claim face. Each
// surface is first shown to carry the canary (so the sweep is sensitive),
// then must not serve it while hidden, and carries it again after restore.
// Not covered: staging, Agora pages (they read these Worker faces), search
// and event tails (asserted by the moderation lane).

const CLAIM_CANARY = "Quokkafrabjous conjecture: for all natural n, n times zero equals zero.";
const TITLE_CANARY = "Zanzibarquux hide sweep problem";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, worker, origin, userAgent }) => {
    const raw = async (path, token) => {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: {
          "User-Agent": userAgent,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      return { status: response.status, text: await response.text() };
    };
    const OWNER = "usr_hide_sweep_owner";
    const author = await enroll("hide-sweep-author", OWNER);
    const other = await enroll("hide-sweep-other", "usr_hide_sweep_other");
    const reviewer = await enroll("hide-sweep-reviewer", "usr_hide_sweep_reviewer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: TITLE_CANARY,
          statement: "For all natural numbers n, n + 0 = n.",
          falsifier: "A natural number n such that n + 0 differs from n.",
          motivation: "Prove that hides reach every face.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const statementSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: statementSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "The statement is exact.",
      },
      reviewer,
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
    const claim = (
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: CLAIM_CANARY,
          falsifier: "A counterexample.",
        },
        author,
        201,
      )
    ).claim_id;
    // A claim that depends on the canary claim makes it load-bearing, so
    // the formalize move quotes it (asimposiumorg-gyue).
    const dependentDraft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Dependent", body_md: "Private." },
      author,
      201,
    );
    await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: dependentDraft.workshop_id,
        kind: "conjecture",
        statement: "A consequence: zero times any natural number is zero as well.",
        falsifier: "A natural number n with zero times n nonzero.",
        depends_on: [claim],
      },
      author,
      201,
    );
    const authorFellow = (await call("/v1/hello", undefined, author)).fellow;

    // Public faces that can carry the claim's statement.
    const claimFaces = [
      `/p/${problem}/claims`,
      `/p/${problem}/claims.md`,
      `/p/${problem}/claims.json`,
      `/p/${problem}/claims.html`,
      `/p/${problem}/claims?format=toon`,
      `/fellows/${authorFellow.fellow_id}`,
      `/fellows/${authorFellow.fellow_id}.md`,
      `/fellows/${authorFellow.fellow_id}.json`,
      `/a/${authorFellow.name}`,
      `/a/${authorFellow.name}.md`,
      `/a/${authorFellow.name}.json`,
    ];
    // Public faces that can carry the problem's title.
    const titleFaces = [
      "/problems.json",
      "/problems.md",
      "/problems.toon",
      "/area/number-theory.json",
      "/area/number-theory.md",
    ];
    // Packs another sponsor's Fellow reads, including target-pinned ones.
    const packProfiles = [
      "working",
      "full",
      "review-queue",
      `claim&target=${claim}@1`,
      `review&target=${claim}@1`,
    ];
    const packText = async (profile) => {
      const opened = await call(
        "/v1/sessions",
        { problem_id: problem, intent: "review" },
        other,
        null,
      );
      assert.ok(
        opened.session_id,
        `review session opened: ${JSON.stringify(opened).slice(0, 160)}`,
      );
      const pack = await raw(`/v1/sessions/${opened.session_id}/pack?profile=${profile}`, other);
      await call(`/v1/sessions/${opened.session_id}/close`, { handback: "sweep" }, other, null);
      return pack;
    };
    const sweep = async (paths, canary, expectVisible, label) => {
      for (const path of paths) {
        const { status, text } = await raw(path);
        if (expectVisible) {
          assert.equal(status, 200, `${label}: ${path} serves before the hide`);
          assert.ok(text.includes(canary), `${label}: ${path} carries the canary before the hide`);
        } else if (status === 200) {
          assert.ok(!text.includes(canary), `${label}: ${path} still serves hidden text`);
        }
      }
    };
    const sweepPacks = async (canary, expectVisible, label) => {
      for (const profile of packProfiles) {
        const { status, text } = await packText(profile);
        assert.equal(status, 200, `${label}: pack ${profile} serves`);
        if (expectVisible) {
          assert.ok(
            text.includes(canary),
            `${label}: pack ${profile} carries the claim before the hide`,
          );
        } else {
          assert.ok(!text.includes(canary), `${label}: pack ${profile} still carries hidden text`);
        }
      }
    };

    // Authenticated surfaces a Fellow reads (asimposiumorg-gyue).
    const claimMoveFaces = [`/v1/p/${problem}/next`, `/v1/p/${problem}/next.md`];
    const titleFellowFaces = [
      `/v1/problems/${problem}`,
      "/v1/hello",
      // triage.md renders no problem titles, so it has none to withhold.
      "/v1/triage",
    ];
    const sweepAuthenticated = async (paths, canary, expectVisible, label) => {
      for (const path of paths) {
        const { status, text } = await raw(path, author);
        if (expectVisible) {
          assert.equal(status, 200, `${label}: ${path} serves before the hide`);
          assert.ok(text.includes(canary), `${label}: ${path} carries the canary before the hide`);
        } else if (status === 200) {
          assert.ok(!text.includes(canary), `${label}: ${path} still serves hidden text`);
        }
      }
    };

    // 1. Sensitivity: every surface carries the canaries while visible.
    await sweepAuthenticated(claimMoveFaces, CLAIM_CANARY, true, "visible");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, true, "visible");
    await sweep(claimFaces, CLAIM_CANARY, true, "visible");
    await sweep(titleFaces, TITLE_CANARY, true, "visible");
    await sweepPacks(CLAIM_CANARY, true, "visible");

    // 2. A claim hide withholds the statement everywhere.
    const control = (action, target_kind, target_id) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id,
        target_kind,
        action,
        reason: `Hide sweep: ${action} of the ${target_kind}.`,
      });
    await control("hide", "claim", `${problem}/${claim}`);
    await sweep(claimFaces, CLAIM_CANARY, false, "claim hidden");
    await sweepAuthenticated(claimMoveFaces, CLAIM_CANARY, false, "claim hidden");
    await sweepPacks(CLAIM_CANARY, false, "claim hidden");
    const board = JSON.parse((await raw(`/p/${problem}/claims.json`)).text);
    assert.ok(
      board.omitted.some((entry) => entry.includes("unavailable")),
      "the board says a claim is withheld",
    );
    // asimposiumorg-azxu: the archive is withheld by policy, never a 500.
    const exportPath = `/p/${problem}/export.jsonl.gz`;
    const withheldExport = await raw(exportPath);
    assert.equal(withheldExport.status, 409, "a hidden claim withholds the archive (409)");
    assert.equal(JSON.parse(withheldExport.text).code, "PUBLIC_EXPORT_CONTENT_WITHHELD");
    assert.ok(!withheldExport.text.includes(CLAIM_CANARY));
    await control("restore", "claim", `${problem}/${claim}`);
    await sweep(claimFaces, CLAIM_CANARY, true, "claim restored");
    assert.equal((await raw(exportPath)).status, 200, "the archive returns after restore");

    // 3. A problem hide withholds its title and its claims off /p/ as well.
    await control("hide", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, false, "problem hidden");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, false, "problem hidden");
    await sweepAuthenticated(claimMoveFaces, CLAIM_CANARY, false, "problem hidden");
    await sweep(
      claimFaces.filter((path) => !path.startsWith("/p/")),
      CLAIM_CANARY,
      false,
      "problem hidden",
    );
    await control("restore", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, true, "problem restored");

    // 4. asimposiumorg-5s97: upholding a report on a kind no face can hide
    //    (a hypothesis) is recorded as upheld, never logged as a hide.
    const hypothesis = (
      await call(
        `/v1/sessions/${session}/hypotheses`,
        {
          route: "Hide sweep route",
          mechanism: "Multiplication by zero",
          falsifier: "An n with n times zero nonzero.",
          origin: "proposed",
          body_md: "Hide sweep hypothesis.",
        },
        author,
        201,
      )
    ).hypothesis_id;
    const report = await call(
      "/v1/reports",
      { problem_id: problem, target: hypothesis, reason: "spam" },
      other,
      201,
    );
    const logBefore = JSON.parse((await raw("/moderation/log.json")).text).entries.length;
    await operatorCall(
      "POST",
      "/v1/operators/reports/resolution",
      "operator.reports.resolve",
      {
        report_id: report.report_id,
        resolution: "uphold",
        reason: "Hide sweep: uphold a hypothesis report.",
      },
      200,
    );
    const newEntries = JSON.parse((await raw("/moderation/log.json")).text).entries.slice(
      logBefore,
    );
    assert.ok(
      newEntries.some((entry) => entry.action === "report-upheld"),
      "the uphold is recorded",
    );
    assert.ok(
      !newEntries.some((entry) => entry.action === "hidden"),
      "no hide is claimed for a kind no face hides",
    );

    console.log(
      JSON.stringify({
        kind: "content-hide-sweep-real-bindings",
        status: "pass",
        claim_faces: claimFaces.length,
        title_faces: titleFaces.length,
        pack_profiles: packProfiles.length,
      }),
    );
  },
);
