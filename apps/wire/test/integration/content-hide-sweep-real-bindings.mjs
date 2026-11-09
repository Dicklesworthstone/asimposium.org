import assert from "node:assert/strict";
import {
  ClaimFaceResponseSchema,
  PackResponseSchema,
  ProblemNextResponseSchema,
  PublicMovesResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { ClaimsListResponseSchema } from "@asimposium/contracts/claims-list";
import { parseClaimsListToon } from "@asimposium/render/claims-list";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// asimposiumorg-aucv / f3v1: an operator hide of a claim or a whole
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
  async ({ call, enroll, sponsorCall, operatorCall, worker, env, origin, userAgent }) => {
    const raw = async (path, token, conditional = {}) => {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: {
          "User-Agent": userAgent,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...conditional,
        },
      });
      const text = await response.text();
      if (new URL(path, origin).searchParams.get("format") === "toon" && response.status === 200) {
        assert.equal(response.headers.get("content-type"), "text/toon; charset=utf-8");
        const canonicalUrl = new URL(path, origin);
        canonicalUrl.pathname += ".json";
        canonicalUrl.searchParams.delete("format");
        const canonical = await worker.fetch(canonicalUrl, {
          headers: {
            "User-Agent": userAgent,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        assert.equal(canonical.status, 200);
        assert.deepEqual(
          parseClaimsListToon(text),
          ClaimsListResponseSchema.parse(await canonical.json()),
        );
      }
      return {
        status: response.status,
        text,
        etag: response.headers.get("etag"),
      };
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
    const sweepPacks = async (canary, expectVisible, label, hiddenProblem = false) => {
      for (const profile of packProfiles) {
        const { status, text } = await packText(profile);
        const wholeProblemHidden = hiddenProblem || hiddenTargets.has(`problem:${problem}`);
        // Full packs traverse a contiguous public event window. A whole
        // hidden scope has no readable public source, so no truthful page or
        // continuation can be emitted; its exact refusal matches event tails.
        if (wholeProblemHidden && profile === "full") {
          assert.equal(status, 404, `${label}: full pack withholds its public source`);
          assert.equal(JSON.parse(text).code, "PROBLEM_NOT_FOUND");
          assert.ok(!text.includes(canary));
          assert.ok(!text.includes(TITLE_CANARY));
          continue;
        }
        assert.equal(status, 200, `${label}: pack ${profile} serves`);
        PackResponseSchema.parse(JSON.parse(text));
        if (expectVisible) {
          assert.ok(
            text.includes(canary),
            `${label}: pack ${profile} carries the claim before the hide`,
          );
        } else {
          assert.ok(!text.includes(canary), `${label}: pack ${profile} still carries hidden text`);
          if (wholeProblemHidden)
            assert.ok(
              !text.includes(TITLE_CANARY),
              `${label}: pack ${profile} still carries the hidden title`,
            );
        }
      }
    };
    let publicPackEtag;
    const sweepPublicPack = async (expectVisible, label, hiddenProblem = false) => {
      const path = `/p/${problem}/full.md`;
      for (const reader of [undefined, author, other]) {
        const response = await raw(path, reader);
        assert.equal(
          response.status,
          hiddenProblem ? 404 : 200,
          `${label}: public full pack has its exact expected response`,
        );
        assert.equal(
          response.text.includes(CLAIM_CANARY),
          expectVisible,
          `${label}: public full pack observes claim visibility`,
        );
        if (hiddenProblem) {
          assert.equal(JSON.parse(response.text).code, "PROBLEM_NOT_FOUND");
          assert.ok(!response.text.includes(TITLE_CANARY));
        }
        if (expectVisible) {
          assert.ok(response.etag, "the visible public full pack has an ETag");
          publicPackEtag = response.etag;
        } else {
          assert.ok(
            publicPackEtag,
            "conditional withholding starts with a proven visible full pack",
          );
          const conditional = await raw(path, reader, { "if-none-match": publicPackEtag });
          assert.equal(
            conditional.status,
            hiddenProblem ? 404 : 200,
            `${label}: prior full-pack ETag does not validate withdrawn content`,
          );
          assert.ok(!conditional.text.includes(CLAIM_CANARY));
          if (hiddenProblem) assert.equal(JSON.parse(conditional.text).code, "PROBLEM_NOT_FOUND");
        }
      }
    };

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
            pathname === `/v1/problems/${target.slice(8)}` ||
            ["", ".md", ".json", ".html"].some(
              (suffix) => pathname === `/p/${target.slice(8)}/claims${suffix}`,
            ) ||
            (pathname.startsWith(`/p/${target.slice(8)}/statements/`) &&
              /^[1-9][0-9]*\.md$/.test(
                pathname.slice(`/p/${target.slice(8)}/statements/`.length),
              ))),
      );
      // The problem reader filters hidden problems in its SQL before the
      // outer 200/304 content-control guard; this exact face refuses404.
      if (hiddenProblemFace) {
        assert.equal(response.status, 404, `${label}: hidden collection/problem is not found`);
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
        // Triage preserves the hello continuation before its move. Validate
        // that one named block separately; every remaining JSON block must
        // still pair with exactly one displayed move reference.
        const actionBlocks = [...text.matchAll(/^## Next actions\n\n```json\n([\s\S]*?)\n```\n/gm)];
        assert.ok(actionBlocks.length <= 1, "at most one hello continuation block");
        let moveText = text;
        if (actionBlocks.length === 1) {
          assert.ok(path.includes("/triage"), "only triage carries the hello continuation");
          TriageResponseSchema.shape.hello.shape.next_actions.parse(JSON.parse(actionBlocks[0][1]));
          moveText = text.replace(actionBlocks[0][0], "");
        }
        const contracts = [...moveText.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
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

    const recordedReads = new Map();
    const checkRemainingMoveReads = async (moves, canary, label, reader) => {
      const paths = new Set();
      for (const move of moves) {
        for (const [key, read] of Object.entries(move.contract.preparation ?? {})) {
          if (key.startsWith("read_") && read?.method === "GET") paths.add(read.path);
        }
      }
      for (const path of paths) {
        const url = new URL(path, origin);
        assert.equal(url.origin, origin, "recommended scientific reads stay on this Worker");
        const response = await raw(path, reader);
        assert.equal(
          response.status,
          200,
          `${label}: remaining recommendation has a readable scientific target`,
        );
        assert.ok(
          !response.text.includes(canary),
          `${label}: a remaining recommendation leaks withdrawn text through a related read`,
        );
      }
    };
    const expectedMoveReadPath = (scope, target, move, readUrl) => {
      if (target.startsWith("C-")) return `/p/${scope}/claims/${target}.md`;
      assert.match(target, /^S@[1-9][0-9]*$/);
      const preparation = move.contract.preparation;
      assert.equal(preparation.statement_version, Number(target.slice(2)));
      assert.ok(Number.isSafeInteger(preparation.captured_cursor));
      assert.ok(preparation.captured_cursor >= 0);
      assert.equal(readUrl.search, `?through=${preparation.captured_cursor}`);
      return `/p/${scope}/statements/${target.slice(2)}.md`;
    };
    const checkMoves = async (
      scope,
      target,
      canary,
      visible,
      label,
      readers,
      wholeProblem = false,
    ) => {
      for (const reader of readers) {
        for (const path of [`/v1/p/${scope}/next`, "/v1/triage"]) {
          const json = await raw(path, reader);
          const markdown = await raw(`${path}.md`, reader);
          if (!visible && wholeProblem && path.startsWith("/v1/p/")) {
            for (const response of [json, markdown]) {
              assert.equal(
                response.status,
                403,
                `${label}: hidden per-problem guidance is withheld`,
              );
              assert.equal(JSON.parse(response.text).code, "CONTENT_HIDDEN");
              assert.ok(!response.text.includes(canary));
            }
            continue;
          }
          assert.equal(json.status, 200, `${label}: JSON guidance is available`);
          assert.equal(markdown.status, 200, `${label}: Markdown guidance is available`);
          const face =
            path === "/v1/triage"
              ? TriageResponseSchema.parse(JSON.parse(json.text))
              : ProblemNextResponseSchema.parse(JSON.parse(json.text));
          const moves =
            path === "/v1/triage"
              ? [face.move].filter(Boolean)
              : [face.primary_move, ...face.alternatives].filter(Boolean);
          assert.ok(
            !json.text.includes(canary),
            `${label}: recommendations do not quote untrusted bodies`,
          );
          assert.ok(
            !markdown.text.includes(canary),
            `${label}: Markdown recommendations do not quote untrusted bodies`,
          );
          const relevant = moves.filter(
            (move) => move.refs.includes(scope) && move.refs.includes(target),
          );
          if (!visible) {
            assert.equal(
              relevant.length,
              0,
              `${label}: hidden scientific target is not recommended`,
            );
            await checkRemainingMoveReads(moves, canary, label, reader);
            continue;
          }
          assert.ok(
            relevant.length > 0,
            `${label}: a selected recommendation references the actual canary target`,
          );
          if (target === `${claim}@1` && reader === author)
            assert.ok(
              relevant.some((move) => move.move === "formalize"),
              "the author receives an eligible load-bearing formalization target",
            );
          for (const move of relevant) {
            const read = move.contract.preparation?.read_first;
            assert.equal(read?.method, "GET");
            const readUrl = new URL(read.path, origin);
            assert.equal(readUrl.origin, origin, "move references stay on this Worker");
            assert.equal(readUrl.pathname, expectedMoveReadPath(scope, target, move, readUrl));
            assert.ok(
              markdown.text.includes(read.path),
              "both move faces retain the actual read reference",
            );
            let etag;
            for (const token of [undefined, reader]) {
              const resolved = await raw(read.path, token);
              assert.equal(resolved.status, 200, `${label}: selected read reference resolves`);
              assert.ok(
                resolved.text.includes(canary),
                `${label}: selected reference resolves to the canary`,
              );
              assert.ok(resolved.etag, "selected public read has an ETag");
              etag = resolved.etag;
            }
            recordedReads.set(read.path, { scope, canary, etag });
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
    const checkRecordedReads = async (scope, canary, visible, label, readers) => {
      const references = [...recordedReads].filter(
        ([, item]) => item.scope === scope && item.canary === canary,
      );
      assert.ok(references.length > 0, "the hidden-read check has a proven positive reference");
      for (const [path, item] of references) {
        // The formulation reader omits a hidden problem at its SQL boundary.
        // Exact claim reads instead return the explicit content-control refusal.
        const pathname = new URL(path, origin).pathname;
        const formulation =
          pathname === `/p/${scope}.md` ||
          (pathname.startsWith(`/p/${scope}/statements/`) &&
            /^[1-9][0-9]*\.md$/.test(pathname.slice(`/p/${scope}/statements/`.length)));
        const hiddenStatus = formulation ? 404 : 403;
        const hiddenCode = formulation ? "PROBLEM_NOT_FOUND" : "CONTENT_HIDDEN";
        for (const reader of [undefined, ...readers]) {
          const response = await raw(path, reader);
          assert.equal(
            response.status,
            visible ? 200 : hiddenStatus,
            `${label}: saved historical read observes current visibility`,
          );
          assert.equal(
            response.text.includes(canary),
            visible,
            `${label}: saved read content follows current visibility`,
          );
          if (!visible) assert.equal(JSON.parse(response.text).code, hiddenCode);
          if (!visible) {
            const conditional = await raw(path, reader, { "if-none-match": item.etag });
            assert.equal(
              conditional.status,
              hiddenStatus,
              `${label}: prior ETag cannot validate withheld content`,
            );
            assert.equal(JSON.parse(conditional.text).code, hiddenCode);
            assert.ok(!conditional.text.includes(canary));
          }
        }
      }
    };
    const checkPublicMoves = async (
      scope,
      target,
      canary,
      visible,
      label,
      wholeProblem = false,
    ) => {
      for (const [path, markdownPath] of [
        ["/moves", "/moves.md"],
        ["/moves.json", "/moves.md"],
        [`/p/${scope}/moves`, `/p/${scope}/moves.md`],
        [`/p/${scope}/moves.json`, `/p/${scope}/moves.md`],
      ]) {
        const response = await raw(path);
        const markdown = await raw(markdownPath);
        const problemScoped = path.startsWith("/p/");
        if (!visible && wholeProblem && problemScoped) {
          for (const face of [response, markdown]) {
            assert.equal(face.status, 404, `${label}: public discovery omits the hidden scope`);
            assert.equal(JSON.parse(face.text).code, "PROBLEM_NOT_FOUND");
            assert.ok(!face.text.includes(canary));
          }
          continue;
        }
        assert.equal(response.status, 200, `${label}: public move discovery is available`);
        assert.equal(markdown.status, 200, `${label}: public Markdown discovery is available`);
        assert.ok(
          !response.text.includes(canary),
          "public recommendations carry references instead of untrusted bodies",
        );
        assert.ok(
          !markdown.text.includes(canary),
          "public Markdown recommendations do not inline untrusted bodies",
        );
        const json = JSON.parse(response.text);
        const scopes = problemScoped
          ? [ProblemNextResponseSchema.parse(json)]
          : PublicMovesResponseSchema.parse(json).discovery.problems;
        assert.ok(
          Array.isArray(scopes),
          "global discovery exposes bounded problem-scoped selections",
        );
        const selectedScope = scopes.find((item) => item.problem_id === scope);
        if (!visible && wholeProblem) {
          assert.equal(selectedScope, undefined, "global needs discovery omits the hidden problem");
          continue;
        }
        assert.ok(
          selectedScope,
          `${label}: global and scoped discovery examine the visible problem`,
        );
        assert.equal(selectedScope.viewer.role, "none");
        assert.ok(
          Object.entries(selectedScope.viewer.effective_permissions).every(([name, allowed]) =>
            name === "read" ? allowed : !allowed,
          ),
          "anonymous needs discovery grants no write authority",
        );
        const moves = [selectedScope.primary_move, ...selectedScope.alternatives].filter(Boolean);
        const relevant = moves.filter(
          (move) => move.refs.includes(scope) && move.refs.includes(target),
        );
        if (!visible) {
          assert.equal(relevant.length, 0, "public discovery does not recommend a hidden claim");
          await checkRemainingMoveReads(moves, canary, label);
          continue;
        }
        assert.ok(
          relevant.length > 0,
          `${label}: public discovery has a sensitive target recommendation`,
        );
        for (const move of relevant) {
          const read = move.contract.preparation?.read_first;
          assert.equal(read?.method, "GET");
          const readUrl = new URL(read.path, origin);
          assert.equal(readUrl.origin, origin);
          assert.equal(readUrl.pathname, expectedMoveReadPath(scope, target, move, readUrl));
          assert.ok(
            markdown.text.includes(read.path),
            "public faces agree on the actionable read reference",
          );
          const resolved = await raw(read.path);
          assert.equal(resolved.status, 200);
          assert.ok(
            resolved.text.includes(canary),
            "the public recommendation resolves to the canary",
          );
          assert.ok(resolved.etag, "public recommendation read has an ETag");
          recordedReads.set(read.path, { scope, canary, etag: resolved.etag });
        }
      }
    };

    // 1. Sensitivity: every surface carries the canaries while visible.
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "visible", [author, claimWatcher]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "visible");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, true, "visible");
    await checkMoves(sharpening, "S@1", STATEMENT_CANARY, true, "visible", [sharpener, watcher]);
    await checkPublicMoves(sharpening, "S@1", STATEMENT_CANARY, true, "visible");
    await sweep(claimFaces, CLAIM_CANARY, true, "visible");
    await sweep(titleFaces, TITLE_CANARY, true, "visible");
    await sweepPacks(CLAIM_CANARY, true, "visible");
    await sweepPublicPack(true, "visible");

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
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "claim hidden", [
      author,
      claimWatcher,
    ]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "claim hidden");
    await checkRecordedReads(problem, CLAIM_CANARY, false, "claim hidden", [author, claimWatcher]);
    await sweepPacks(CLAIM_CANARY, false, "claim hidden");
    await sweepPublicPack(false, "claim hidden");
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
    await sweepPublicPack(true, "claim restored");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "claim restored", [
      author,
      claimWatcher,
    ]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "claim restored");
    await checkRecordedReads(problem, CLAIM_CANARY, true, "claim restored", [author, claimWatcher]);
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
    await checkMoves(
      problem,
      `${claim}@1`,
      CLAIM_CANARY,
      false,
      "problem hidden",
      [author, claimWatcher],
      true,
    );
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "problem hidden", true);
    await checkRecordedReads(problem, CLAIM_CANARY, false, "problem hidden", [
      author,
      claimWatcher,
    ]);
    await sweepPublicPack(false, "problem hidden", true);
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
    await sweepPublicPack(true, "problem restored");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "problem restored", [
      author,
      claimWatcher,
    ]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "problem restored");
    await checkRecordedReads(problem, CLAIM_CANARY, true, "problem restored", [
      author,
      claimWatcher,
    ]);
    await control("hide", "problem", sharpening);
    await sweepMoveReads(triageFaces, STATEMENT_CANARY, false, "sharpening hidden", [
      sharpener,
      watcher,
    ]);
    await checkMoves(
      sharpening,
      "S@1",
      STATEMENT_CANARY,
      false,
      "sharpening hidden",
      [sharpener, watcher],
      true,
    );
    await checkPublicMoves(sharpening, "S@1", STATEMENT_CANARY, false, "sharpening hidden", true);
    await checkRecordedReads(sharpening, STATEMENT_CANARY, false, "sharpening hidden", [
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
    await checkMoves(sharpening, "S@1", STATEMENT_CANARY, true, "sharpening restored", [
      sharpener,
      watcher,
    ]);
    await checkPublicMoves(sharpening, "S@1", STATEMENT_CANARY, true, "sharpening restored");
    await checkRecordedReads(sharpening, STATEMENT_CANARY, true, "sharpening restored", [
      sharpener,
      watcher,
    ]);

    // 4. Hypotheses now have public readers that enforce content controls.
    // Prove their real report action hides bytes, then retain 5s97's legacy
    // unsupported-kind invariant with an explicitly stored historical fixture.
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
    const hypothesisPath = `/p/${problem}/hypotheses/${hypothesis}.json`;
    const hypothesisBefore = await raw(hypothesisPath);
    assert.equal(hypothesisBefore.status, 200);
    assert.ok(hypothesisBefore.text.includes("Hide sweep hypothesis."));
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
      newEntries.some((entry) => entry.action === "hidden"),
      "a supported hypothesis hide is recorded",
    );
    const hypothesisAfter = await raw(hypothesisPath);
    assert.equal(hypothesisAfter.status, 404);
    assert.ok(!hypothesisAfter.text.includes("Hide sweep hypothesis."));
    assert.equal(JSON.parse(hypothesisAfter.text).code, "PROBLEM_NOT_FOUND");
    const hiddenHypotheses = await call(`/p/${problem}/hypotheses.json`);
    const hiddenHypothesis = hiddenHypotheses.hypotheses.find(
      (item) => item.hypothesis_id === hypothesis,
    );
    assert.ok(hiddenHypothesis, "the hidden publication retains its admission envelope");
    assert.equal(hiddenHypothesis.content, null);
    assert.ok(hiddenHypotheses.omitted.includes("content_unavailable"));

    // This is legacy report state, not a report admitted by today's intake or
    // a scientific publication fixture. Null source pins are allowed for old
    // reports; the operator must resolve them without inventing a content hide.
    const legacyReportId = `RP-${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`;
    const legacyTarget = "legacy-unsupported-hide-sweep";
    const legacy = await env.DB.prepare(`INSERT INTO reports
      (report_id,problem_id,target_kind,target_ref,reason,reporter_class,
       reporter_fellow_id,reporter_sponsor_id,status,created_at)
      SELECT ?,problem_id,'legacy-unsupported',?,reason,reporter_class,
        reporter_fellow_id,reporter_sponsor_id,'pending',created_at
      FROM reports WHERE report_id=?`)
      .bind(legacyReportId, legacyTarget, report.report_id)
      .run();
    assert.equal(legacy.meta.changes, 1);
    const legacyLogBefore = JSON.parse((await raw("/moderation/log.json")).text).entries.length;
    await operatorCall(
      "POST",
      "/v1/operators/reports/resolution",
      "operator.reports.resolve",
      {
        report_id: legacyReportId,
        resolution: "uphold",
        reason: "Hide sweep: resolve a historical unsupported-kind report.",
      },
      200,
    );
    const legacyEntries = JSON.parse((await raw("/moderation/log.json")).text).entries.slice(
      legacyLogBefore,
    );
    assert.ok(legacyEntries.some((entry) => entry.action === "report-upheld"));
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT status,source_event_id,source_digest,source_ref FROM reports WHERE report_id=?",
      )
        .bind(legacyReportId)
        .first(),
      { status: "upheld", source_event_id: null, source_digest: null, source_ref: null },
    );
    assert.ok(
      !legacyEntries.some((entry) => entry.action === "hidden"),
      "no hide is claimed for a kind no face hides",
    );
    assert.equal(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM content_controls WHERE problem_id=? AND target_ref=?",
        )
          .bind(problem, legacyTarget)
          .first()
      ).n,
      0,
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
        reference_reads: recordedReads.size,
      }),
    );
  },
);
