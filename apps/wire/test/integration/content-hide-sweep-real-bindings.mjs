import assert from "node:assert/strict";
import {
  ClaimFaceResponseSchema,
  ProblemNextResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// asimposiumorg-f3v1: an operator (or community) hide of a claim or a whole
// problem must withhold its text from every public face and from every pack
// another sponsor's Fellow can read, not only from the claim face. Each
// surface or its offered canonical read first carries the canary, withholds
// it while hidden, and carries it again after restore. Move prose stays trusted
// and source-free; retained links prove withdrawal also applies to old cuts.
// Not covered: staging, Agora pages (they read these Worker faces), search
// and event tails (asserted by the moderation lane).

// Deliberately false calibration statement: n=1 is an actual counterexample.
// Its disputed standing is earned by HTTP evidence/review, never seeded.
const CLAIM_CANARY = "Quokkafrabjous conjecture: for all natural n, n plus zero equals zero.";
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
    const author = await enroll("hide-sweep-author", OWNER, {
      model: "openai/gpt-5.6",
      harness: "codex",
    });
    const other = await enroll("hide-sweep-other", "usr_hide_sweep_other");
    const reviewer = await enroll("hide-sweep-reviewer", "usr_hide_sweep_reviewer", {
      model: "anthropic/claude-3.7",
      harness: "claude-code",
    });
    const enrolledAuthor = (await call("/v1/hello", undefined, author)).fellow;
    assert.equal(enrolledAuthor.model, "openai/gpt-5.6");
    assert.equal(enrolledAuthor.harness, "codex");
    const enrolledReviewer = (await call("/v1/hello", undefined, reviewer)).fellow;
    assert.equal(enrolledReviewer.model, "anthropic/claude-3.7");
    assert.equal(enrolledReviewer.harness, "claude-code");
    const enrolledDefault = (await call("/v1/hello", undefined, other)).fellow;
    assert.equal(enrolledDefault.model, "synthetic-problem-model");
    assert.equal(enrolledDefault.harness, "local-problem-lifecycle-proof");
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
          falsifier: "A natural n for which n plus zero is not zero.",
          scientific_provenance: {
            model_family_self_declared: "gpt",
            method: {
              category: "deductive",
              procedure: "Propose the identity for an independent check.",
              evidence: [],
            },
          },
        },
        author,
        201,
      )
    ).claim_id;
    // A verified incoming dependency makes the canary load-bearing. Current
    // formalization also requires its own corroborated/disputed standing.
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
        statement: "A consequence: every positive natural number equals zero.",
        falsifier: "A positive natural number that is not zero.",
        depends_on: [claim],
      },
      author,
      201,
    );
    assert.equal(1 + 0, 1, "the calibration counterexample is evaluated in this harness");
    const counterexample = await call(
      `/v1/sessions/${statementSession}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim,
        bears_on_version: 1,
        direction: "refutes",
        kind: "argument",
        mode: "confirmatory",
        source: {
          kind: "locator",
          locator: "https://example.invalid/hide-sweep/n1",
          excerpt: "At n=1, n+0=1, which differs from zero.",
        },
        body_md:
          "Take the natural number n=1. Then n+0=1, not zero. This is a counterexample to the stated universal identity.",
      },
      reviewer,
      201,
    );
    const counterFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${claim}@1.json`),
    );
    const counterItem = counterFace.items.find((item) => item.id === counterexample.evidence_id);
    assert.ok(counterItem, "the published counterexample is present in the exact claim face");
    const counterReference = {
      evidence_id: counterexample.evidence_id,
      digest: JSON.parse(counterItem.body).content_digest,
    };
    const review = await call(
      `/v1/sessions/${statementSession}/review`,
      {
        target_claim_id: claim,
        target_version: 1,
        verdict: "refute",
        basis: "Evaluated the n=1 case against the exact universal identity.",
        capable_of_failure: "If 1+0 were zero, this example would not refute the claim.",
        scientific_provenance: {
          model_family_self_declared: "claude",
          method: {
            category: "deductive",
            procedure: "Evaluate the published n=1 counterexample.",
            evidence: [counterReference],
          },
        },
        body_md:
          "The published counterexample uses n=1 and ordinary natural-number addition: 1+0=1 differs from zero.",
      },
      reviewer,
      201,
    );
    assert.equal(
      review.tier,
      "T2",
      "the recorded review has a different sponsor and declared family",
    );
    const reviewedFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${claim}@1.json`),
    );
    assert.equal(reviewedFace.claim_state.disposition, "disputed");
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
      // The public review queue (asimposiumorg-1rtq).
      "/reviews",
      "/reviews.md",
      "/reviews.json",
      "/reviews.html",
      `/reviews.json?problem=${problem}`,
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
    let packSession;
    const retainedPackPaths = new Map();
    const packText = async (profile) => {
      if (packSession === undefined) {
        const opened = await call(
          "/v1/sessions",
          { problem_id: problem, intent: "review" },
          other,
          201,
        );
        assert.equal(typeof opened.session_id, "string");
        packSession = opened.session_id;
      }
      if (!retainedPackPaths.has(profile)) {
        retainedPackPaths.set(profile, `/v1/sessions/${packSession}/pack?profile=${profile}`);
      }
      return raw(retainedPackPaths.get(profile), other);
    };
    const sweep = async (paths, canary, expectVisible, label) => {
      for (const path of paths) {
        const { status, text } = await raw(path);
        if (expectVisible) {
          assert.equal(status, 200, `${label}: ${path} serves before the hide`);
          assert.ok(text.includes(canary), `${label}: ${path} carries the canary before the hide`);
        } else {
          assertHiddenResponse({ status, text }, canary, label, path);
        }
      }
    };
    const sweepPacks = async (canary, expectVisible, label) => {
      for (const profile of packProfiles) {
        const { status, text } = await packText(profile);
        const code = status === 200 ? "none" : JSON.parse(text).code;
        const hiddenPublicArchive = profile === "full" && hiddenTargets.has(`problem:${problem}`);
        assert.equal(
          status,
          hiddenPublicArchive ? 404 : 200,
          `${label}: pack ${profile} serves or refuses its unavailable public scope; code=${code}`,
        );
        if (hiddenPublicArchive) assert.equal(code, "PROBLEM_NOT_FOUND");
        if (expectVisible) {
          assert.ok(
            text.includes(canary),
            `${label}: pack ${profile} carries the claim before the hide`,
          );
        } else {
          assert.ok(!text.includes(canary), `${label}: pack ${profile} still carries hidden text`);
          if (hiddenTargets.has(`problem:${problem}`)) {
            assert.ok(
              !text.includes(TITLE_CANARY),
              `${label}: pack ${profile} withholds the hidden title`,
            );
          }
        }
      }
    };

    // Authenticated surfaces a Fellow reads (asimposiumorg-gyue).
    const claimMoveFaces = [
      `/v1/p/${problem}/next`,
      `/v1/p/${problem}/next.md`,
      "/v1/triage",
      "/v1/triage.md",
    ];
    // A second, still-sharpening problem another sponsor's Fellow works on:
    // its sharpen move, the one triage picks, links to the published statement
    // (asimposiumorg-exqt).
    const SHARPENER_OWNER = "usr_hide_sweep_sharpener";
    const sharpener = await enroll("hide-sweep-sharpener", SHARPENER_OWNER);
    const STATEMENT_CANARY = "Wombatquill statement: every natural number is at least zero.";
    const sharpening = (
      await call(
        "/v1/problems",
        {
          title: "Sharpening hide sweep problem",
          statement: STATEMENT_CANARY,
          falsifier: "A natural number below zero.",
          motivation: "Prove that a hidden problem yields no moves.",
          areas: ["number-theory"],
        },
        sharpener,
        201,
      )
    ).problem.id;
    await sponsorCall(
      SHARPENER_OWNER,
      "POST",
      `/v1/sponsors/problems/${sharpening}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    await call("/v1/sessions", { problem_id: sharpening, intent: "prove" }, sharpener, 201);
    // A member Fellow of another sponsor reads the claim's moves (gyue).
    const claimWatcher = await enroll("hide-sweep-claim-watcher", "usr_hide_sweep_claim_watcher");
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, claimWatcher, 201);
    // A Fellow of a third sponsor working on the same problem (exqt).
    const watcher = await enroll("hide-sweep-watcher", "usr_hide_sweep_watcher");
    await call("/v1/sessions", { problem_id: sharpening, intent: "prove" }, watcher, 201);
    const titleFellowFaces = [
      `/v1/problems/${problem}`,
      "/v1/hello",
      // triage.md renders no problem titles, so it has none to withhold.
      "/v1/triage",
    ];
    const triageFaces = ["/v1/triage", "/v1/triage.md"];
    const sweepAuthenticated = async (paths, canary, expectVisible, label, reader = author) => {
      if (Array.isArray(reader)) {
        for (const one of reader)
          await sweepAuthenticated(paths, canary, expectVisible, label, one);
        return;
      }
      for (const path of paths) {
        const { status, text } = await raw(path, reader);
        if (expectVisible) {
          assert.equal(status, 200, `${label}: ${path} serves before the hide`);
          assert.ok(text.includes(canary), `${label}: ${path} carries the canary before the hide`);
        } else {
          assertHiddenResponse({ status, text }, canary, label, path);
        }
      }
    };

    // Move text is server-authored. Scientific statements live behind the
    // offered canonical reads, not in trusted recommendation prose. Retain
    // the reads that actually exposed the canary so a hidden response cannot
    // pass merely by selecting a different move or a different cursor.
    const retainedMoveReads = [];
    const hiddenTargets = new Set();
    function assertHiddenResponse(response, canary, label, path) {
      assert.ok(
        !response.text.includes(canary),
        `${label}: every response, including refusals, withholds protected bytes`,
      );
      if (response.status === 200) return;
      const refusal = JSON.parse(response.text);
      const pathname = decodeURIComponent(new URL(path, origin).pathname);
      const hiddenProblemFace = [...hiddenTargets].some(
        (target) =>
          target.startsWith("problem:") &&
          (pathname === `/p/${target.slice(8)}.md` ||
            pathname === `/v1/problems/${target.slice(8)}`),
      );
      // The problem reader filters hidden problems in its SQL before the
      // outer 200/304 content-control guard; this exact face refuses404.
      if (hiddenProblemFace && response.status === 404) {
        assert.equal(refusal.code, "PROBLEM_NOT_FOUND");
      } else {
        assert.equal(
          response.status,
          403,
          `${label}: unexpected hidden-read status on ${pathname}`,
        );
        assert.equal(refusal.code, "CONTENT_HIDDEN");
      }
    }
    const candidates = (path, text) => {
      if (path.endsWith(".md")) {
        const contracts = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
          JSON.parse(match[1]),
        );
        const refs = [...text.matchAll(/^- \*\*Refs\*\*: (.+)$/gm)].map((match) =>
          match[1] === "none" ? [] : match[1].split(", "),
        );
        assert.equal(
          contracts.length,
          refs.length,
          "each Markdown contract has its displayed references",
        );
        return contracts.map((contract, index) => ({
          move: contract.move,
          refs: refs[index],
          contract,
        }));
      }
      if (path.includes("/next")) {
        const face = ProblemNextResponseSchema.parse(JSON.parse(text));
        return [face.primary_move, ...face.alternatives].filter(Boolean);
      }
      const face = TriageResponseSchema.parse(JSON.parse(text));
      return face.move === null ? [] : [face.move];
    };
    const reads = (moves) =>
      moves.flatMap((move) => {
        const preparation = move.contract.preparation;
        return ["read_first", "read_prioritized_claim", "read_limiting_premise"].flatMap((key) => {
          const read = preparation?.[key];
          if (read === undefined) return [];
          assert.equal(read.method, "GET", "recommendation reads are never writes");
          assert.equal(typeof read.path, "string");
          const url = new URL(read.path, origin);
          assert.equal(
            url.origin,
            origin,
            "the recommendation stays on the canonical agent origin",
          );
          assert.ok(url.pathname.startsWith("/p/"), "scientific reads use public canonical faces");
          if (["formalize", "sharpen-statement", "review", "add-refuter"].includes(move.move)) {
            assert.ok(Number.isSafeInteger(preparation.captured_cursor));
            assert.equal(
              url.searchParams.get("through"),
              String(preparation.captured_cursor),
              "the offered read carries the selector's captured cut",
            );
          }
          return [url.pathname + url.search];
        });
      });
    const assertReadableState = async (path, reader, canary, visible, label) => {
      const response = await raw(path, reader);
      if (visible) {
        assert.equal(response.status, 200, `${label}: the retained canonical read serves`);
        assert.ok(
          response.text.includes(canary),
          `${label}: the retained read is sensitive to the canary`,
        );
      } else {
        assertHiddenResponse(response, canary, label, path);
      }
      return response;
    };
    const sweepMoveReads = async (paths, canary, visible, label, readers, requiredMove) => {
      for (const reader of readers) {
        for (const path of paths) {
          const response = await raw(path, reader);
          assert.ok(
            !response.text.includes(canary),
            `${label}: trusted moves do not inline scientific text`,
          );
          let currentReads = [];
          if (response.status === 200) {
            const moves = candidates(path, response.text);
            if (visible && (requiredMove !== "formalize" || path.includes("/next"))) {
              assert.ok(
                moves.some((move) => move.move === requiredMove),
                `${label}: the real ledger yields the intended ${requiredMove} recommendation`,
              );
            }
            currentReads = [...new Set(reads(moves))];
            for (const target of hiddenTargets) {
              const [kind, id] = target.split(":");
              assert.ok(
                !moves.some((move) =>
                  kind === "problem"
                    ? move.refs.includes(id)
                    : move.refs.includes(problem) &&
                      move.refs.some((ref) => ref.split("@")[0] === claim),
                ),
                `${label}: a new recommendation never targets a protected hidden object`,
              );
              assert.ok(
                !currentReads.some((read) => {
                  const pathname = decodeURIComponent(new URL(read, origin).pathname);
                  return kind === "problem"
                    ? pathname.startsWith(`/p/${id}.`) || pathname.startsWith(`/p/${id}/`)
                    : pathname.startsWith(`/p/${problem}/claims/${claim}@`);
                }),
                `${label}: new preparation links never target protected hidden content`,
              );
            }
          } else {
            assert.equal(
              response.status,
              403,
              `${label}: only the explicit problem hide refuses the move face`,
            );
            assert.equal(JSON.parse(response.text).code, "CONTENT_HIDDEN");
            assert.equal(visible, false);
          }
          let retained = retainedMoveReads.find(
            (value) => value.reader === reader && value.surface === path && value.canary === canary,
          );
          if (visible) {
            const sensitive = [];
            for (const read of currentReads) {
              const result = await raw(read, reader);
              assert.equal(result.status, 200, `${label}: offered canonical reads actually work`);
              if (result.text.includes(canary)) sensitive.push(read);
            }
            assert.ok(
              sensitive.length > 0,
              `${label}: this move face offers a read that exposes the canary before hiding`,
            );
            if (retained === undefined) {
              retained = { reader, surface: path, canary, paths: sensitive };
              retainedMoveReads.push(retained);
            }
          }
          assert.ok(retained, `${label}: a pre-hide sensitive read must already be retained`);
          for (const read of new Set([...retained.paths, ...(visible ? [] : currentReads)])) {
            await assertReadableState(read, reader, canary, visible, label);
          }
        }
      }
    };

    // 1. Sensitivity: every surface or offered canonical read carries its canary.
    await sweepMoveReads(
      claimMoveFaces,
      CLAIM_CANARY,
      true,
      "visible",
      [author, claimWatcher],
      "formalize",
    );
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, true, "visible");
    await sweepMoveReads(
      triageFaces,
      STATEMENT_CANARY,
      true,
      "visible",
      [sharpener, watcher],
      "sharpen-statement",
    );
    await sweep(claimFaces, CLAIM_CANARY, true, "visible");
    await sweep(titleFaces, TITLE_CANARY, true, "visible");
    await sweepPacks(CLAIM_CANARY, true, "visible");

    // 2. A claim hide withholds the statement everywhere.
    const control = async (action, target_kind, target_id) => {
      const result = await operatorCall(
        "POST",
        "/v1/operators/content-control",
        "operator.content.control",
        {
          target_id,
          target_kind,
          action,
          reason: `Hide sweep: ${action} of the ${target_kind}.`,
        },
      );
      const target = `${target_kind}:${target_id}`;
      if (action === "hide") hiddenTargets.add(target);
      else hiddenTargets.delete(target);
      return result;
    };
    await control("hide", "claim", `${problem}/${claim}`);
    await sweep(claimFaces, CLAIM_CANARY, false, "claim hidden");
    await sweepMoveReads(claimMoveFaces, CLAIM_CANARY, false, "claim hidden", [
      author,
      claimWatcher,
    ]);
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
    await sweepPacks(CLAIM_CANARY, true, "claim restored");
    await sweepMoveReads(
      claimMoveFaces,
      CLAIM_CANARY,
      true,
      "claim restored",
      [author, claimWatcher],
      "formalize",
    );
    assert.equal((await raw(exportPath)).status, 200, "the archive returns after restore");

    // 3. A problem hide withholds its title and its claims off /p/ as well.
    await control("hide", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, false, "problem hidden");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, false, "problem hidden");
    await sweepPacks(CLAIM_CANARY, false, "problem hidden");
    await sweepMoveReads(claimMoveFaces, CLAIM_CANARY, false, "problem hidden", [
      author,
      claimWatcher,
    ]);
    await sweep(claimFaces, CLAIM_CANARY, false, "problem hidden");
    await control("restore", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, true, "problem restored");
    await sweep(claimFaces, CLAIM_CANARY, true, "problem restored");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, true, "problem restored");
    await sweepPacks(CLAIM_CANARY, true, "problem restored");
    await sweepMoveReads(
      claimMoveFaces,
      CLAIM_CANARY,
      true,
      "problem restored",
      [author, claimWatcher],
      "formalize",
    );
    await control("hide", "problem", sharpening);
    await sweepMoveReads(triageFaces, STATEMENT_CANARY, false, "sharpening hidden", [
      sharpener,
      watcher,
    ]);
    await control("restore", "problem", sharpening);
    await sweepMoveReads(
      triageFaces,
      STATEMENT_CANARY,
      true,
      "sharpening restored",
      [sharpener, watcher],
      "sharpen-statement",
    );

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
    assert.equal(retainedPackPaths.size, packProfiles.length);
    await call(
      `/v1/sessions/${packSession}/close`,
      { handback: "Hide and restore reads verified." },
      other,
      201,
    );

    console.log(
      JSON.stringify({
        kind: "content-hide-sweep-real-bindings",
        status: "pass",
        claim_faces: claimFaces.length,
        title_faces: titleFaces.length,
        pack_profiles: packProfiles.length,
        retained_move_read_sets: retainedMoveReads.length,
        retained_sensitive_reads: retainedMoveReads.reduce(
          (count, entry) => count + entry.paths.length,
          0,
        ),
        calibration_disposition: reviewedFace.claim_state.disposition,
        synthetic_review_tier: review.tier,
      }),
    );
  },
);
