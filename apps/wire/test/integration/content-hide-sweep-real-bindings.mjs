import assert from "node:assert/strict";
import {
  ClaimFaceResponseSchema,
  PackResponseSchema,
  ProblemNextResponseSchema,
  PublicMovesResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// asimposiumorg-aucv / f3v1: an operator hide of a claim or a whole
// problem must withhold its text from every public face and from every pack
// another sponsor's Fellow can read, not only from the claim face. Each
// surface is first shown to carry the canary (so the sweep is sensitive),
// then must not serve it while hidden, and carries it again after restore.
// Moves carry server-authored instructions and canonical read references,
// not quoted claim text. Establish scientific eligibility through real HTTP
// writes, then follow the actual selected reference before and after hiding.
// An old captured cursor never bypasses current content controls.
// Not covered: staging, Agora pages (they read these Worker faces), search
// and event tails (asserted by the moderation lane).

const CLAIM_CANARY = "Quokkafrabjous conjecture: for all natural n, n times zero equals zero.";
const TITLE_CANARY = "Zanzibarquux hide sweep problem";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, worker, origin, userAgent }) => {
    const raw = async (path, token, conditional = {}) => {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: {
          "User-Agent": userAgent,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...conditional,
        },
      });
      return { status: response.status, text: await response.text(), etag: response.headers.get("etag") };
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
          scientific_provenance: {
            model_family_self_declared: "gpt",
            method: { category: "deductive", procedure: "Definition of multiplication by zero.", evidence: [] },
          },
        },
        author,
        201,
      )
    ).claim_id;
    // A verified publication pin makes the canary claim load-bearing. A pin
    // alone is insufficient: the formalize selector also requires the
    // target's own corroborated/disputed scientific standing.
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
    const proof = await call(
      `/v1/sessions/${session}/evidence`,
      {
        bears_on_kind: "claim", bears_on_id: claim, bears_on_version: 1,
        direction: "supports", kind: "argument", mode: "confirmatory",
        source: {
          kind: "locator", locator: "https://example.invalid/hide-sweep/zero",
          excerpt: "Multiplication by zero returns zero by its defining recursion.",
        },
        body_md: "The recursion defining multiplication gives n times zero equal to zero.",
      },
      author,
      201,
    );
    const targetPack = PackResponseSchema.parse(await call(
      `/v1/sessions/${statementSession}/pack?profile=review&target=${claim}@1&max_tokens=8000`,
      undefined,
      reviewer,
    ));
    const detail = JSON.parse(targetPack.items.find((item) => item.kind === "claim-detail").body);
    assert.equal(detail.statement, CLAIM_CANARY);
    const proofRef = {
      evidence_id: proof.evidence_id,
      digest: JSON.parse(targetPack.items.find((item) => item.id === proof.evidence_id).body).content_digest,
    };
    await call(
      `/v1/sessions/${statementSession}/review`,
      {
        target_claim_id: claim, target_version: 1, verdict: "confirm",
        basis: "Checked the defining recursion and its natural-number domain.",
        capable_of_failure: "A nonzero result of multiplication by zero would invalidate the check.",
        scientific_provenance: {
          model_family_self_declared: "claude",
          method: { category: "deductive", procedure: "Independent check of the defining recursion.", evidence: [proofRef] },
        },
        body_md: "The recursion has a zero base case for each natural first operand.",
      },
      reviewer,
      201,
    );
    await call(
      `/v1/sessions/${statementSession}/evidence`,
      {
        bears_on_kind: "claim", bears_on_id: claim, bears_on_version: 1,
        direction: "informs", kind: "computation", mode: "confirmatory",
        source: {
          kind: "locator", locator: "https://example.invalid/hide-sweep/falsification",
          excerpt: "The finite check found no nonzero product in its declared domain.",
        },
        computation_domain_or_floor: "Natural n in [0, 10000]",
        falsification_check: {
          target_digest: detail.content_digest,
          attempted_falsifier: "A natural n with n times zero nonzero.",
          capable_of_failure: "Any nonzero product in the checked range.",
          result: "survived", evidence: [proofRef],
        },
        body_md: "The finite falsification attempt over 0..10000 found no nonzero product. It does not exhaust all natural numbers.",
      },
      reviewer,
      201,
    );
    const standing = ClaimFaceResponseSchema.parse(await call(`/p/${problem}/claims/${claim}@1.json`));
    assert.equal(standing.claim_state.disposition, "corroborated", "real independent review and grounded refutation attempt establish eligibility");
    assert.equal(standing.claim_state.recorded_refutation_attempts, 1);
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
    // Keep the same foreign-sponsor session through the visibility changes.
    // Opening fresh sessions while a problem is hidden is not the pack-read
    // boundary, and closing between reads would mutate the selector's input.
    const otherSession = (await call(
      "/v1/sessions", { problem_id: problem, intent: "review" }, other, 201,
    )).session_id;
    const packText = (profile) => raw(
      `/v1/sessions/${otherSession}/pack?profile=${profile}&max_tokens=8000`, other,
    );
    const sweep = async (paths, canary, expectVisible, label) => {
      for (const path of paths) {
        const { status, text } = await raw(path);
        if (expectVisible) {
          assert.equal(status, 200, `${label}: ${path} serves before the hide`);
          assert.ok(text.includes(canary), `${label}: ${path} carries the canary before the hide`);
        } else {
          assert.equal(status, 200, `${label}: ${path} remains a healthy collection`);
          assert.ok(!text.includes(canary), `${label}: ${path} still serves hidden text`);
        }
      }
    };
    const sweepPacks = async (canary, expectVisible, label, hiddenProblem = false) => {
      for (const profile of packProfiles) {
        const { status, text } = await packText(profile);
        // Full packs traverse a contiguous public event window. A whole
        // hidden scope has no readable public source, so no truthful page or
        // continuation can be emitted; its exact refusal matches event tails.
        if (hiddenProblem && profile === "full") {
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
          if (hiddenProblem) assert.ok(!text.includes(TITLE_CANARY), `${label}: pack ${profile} still carries the hidden title`);
        }
      }
    };
    let publicPackEtag;
    const sweepPublicPack = async (expectVisible, label, hiddenProblem = false) => {
      const path = `/p/${problem}/full.md`;
      for (const reader of [undefined, author, other]) {
        const response = await raw(path, reader);
        assert.equal(response.status, hiddenProblem ? 404 : 200, `${label}: public full pack has its exact expected response`);
        assert.equal(response.text.includes(CLAIM_CANARY), expectVisible, `${label}: public full pack observes claim visibility`);
        if (hiddenProblem) {
          assert.equal(JSON.parse(response.text).code, "PROBLEM_NOT_FOUND");
          assert.ok(!response.text.includes(TITLE_CANARY));
        }
        if (expectVisible) {
          assert.ok(response.etag, "the visible public full pack has an ETag");
          publicPackEtag = response.etag;
        } else {
          assert.ok(publicPackEtag, "conditional withholding starts with a proven visible full pack");
          const conditional = await raw(path, reader, { "if-none-match": publicPackEtag });
          assert.equal(conditional.status, hiddenProblem ? 404 : 200, `${label}: prior full-pack ETag does not validate withdrawn content`);
          assert.ok(!conditional.text.includes(CLAIM_CANARY));
          if (hiddenProblem) assert.equal(JSON.parse(conditional.text).code, "PROBLEM_NOT_FOUND");
        }
      }
    };

    // A second, still-sharpening problem another sponsor's Fellow works on:
    // its sharpen move points to the published formulation, without quoting
    // the untrusted statement in the trusted recommendation.
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
          const hiddenProblemRoute = path.startsWith(`/v1/problems/${problem}`);
          assert.equal(status, hiddenProblemRoute ? 404 : 200, `${label}: ${path} has its exact expected response`);
          if (hiddenProblemRoute) assert.equal(JSON.parse(text).code, "PROBLEM_NOT_FOUND");
          assert.ok(!text.includes(canary), `${label}: ${path} still serves hidden text`);
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
        assert.equal(response.status, 200, `${label}: remaining recommendation has a readable scientific target`);
        assert.ok(!response.text.includes(canary), `${label}: a remaining recommendation leaks withdrawn text through a related read`);
      }
    };
    const checkMoves = async (scope, target, canary, visible, label, readers, wholeProblem = false) => {
      for (const reader of readers) {
        for (const path of [`/v1/p/${scope}/next`, "/v1/triage"]) {
          const json = await raw(path, reader);
          const markdown = await raw(`${path}.md`, reader);
          if (!visible && wholeProblem && path.startsWith("/v1/p/")) {
            for (const response of [json, markdown]) {
              assert.equal(response.status, 403, `${label}: hidden per-problem guidance is withheld`);
              assert.equal(JSON.parse(response.text).code, "CONTENT_HIDDEN");
              assert.ok(!response.text.includes(canary));
            }
            continue;
          }
          assert.equal(json.status, 200, `${label}: JSON guidance is available`);
          assert.equal(markdown.status, 200, `${label}: Markdown guidance is available`);
          const face = path === "/v1/triage"
            ? TriageResponseSchema.parse(JSON.parse(json.text))
            : ProblemNextResponseSchema.parse(JSON.parse(json.text));
          const moves = path === "/v1/triage"
            ? [face.move].filter(Boolean)
            : [face.primary_move, ...face.alternatives].filter(Boolean);
          assert.ok(!json.text.includes(canary), `${label}: recommendations do not quote untrusted bodies`);
          assert.ok(!markdown.text.includes(canary), `${label}: Markdown recommendations do not quote untrusted bodies`);
          const relevant = moves.filter((move) => move.refs.includes(scope) && move.refs.includes(target));
          if (!visible) {
            assert.equal(relevant.length, 0, `${label}: hidden scientific target is not recommended`);
            await checkRemainingMoveReads(moves, canary, label, reader);
            continue;
          }
          assert.ok(relevant.length > 0, `${label}: a selected recommendation references the actual canary target`);
          if (target === `${claim}@1` && reader === author)
            assert.ok(relevant.some((move) => move.move === "formalize"), "the author receives an eligible load-bearing formalization target");
          for (const move of relevant) {
            const read = move.contract.preparation?.read_first;
            assert.equal(read?.method, "GET");
            const readUrl = new URL(read.path, origin);
            assert.equal(readUrl.origin, origin, "move references stay on this Worker");
            assert.equal(readUrl.pathname, target.startsWith("C-")
              ? `/p/${scope}/claims/${target}.md` : `/p/${scope}.md`);
            assert.ok(markdown.text.includes(read.path), "both move faces retain the actual read reference");
            let etag;
            for (const token of [undefined, reader]) {
              const resolved = await raw(read.path, token);
              assert.equal(resolved.status, 200, `${label}: selected read reference resolves`);
              assert.ok(resolved.text.includes(canary), `${label}: selected reference resolves to the canary`);
              assert.ok(resolved.etag, "selected public read has an ETag");
              etag = resolved.etag;
            }
            recordedReads.set(read.path, { scope, canary, etag });
          }
        }
      }
    };
    const checkRecordedReads = async (scope, canary, visible, label, readers) => {
      const references = [...recordedReads].filter(([, item]) => item.scope === scope && item.canary === canary);
      assert.ok(references.length > 0, "the hidden-read check has a proven positive reference");
      for (const [path, item] of references) {
        // The formulation reader omits a hidden problem at its SQL boundary.
        // Exact claim reads instead return the explicit content-control refusal.
        const formulation = new URL(path, origin).pathname === `/p/${scope}.md`;
        const hiddenStatus = formulation ? 404 : 403;
        const hiddenCode = formulation ? "PROBLEM_NOT_FOUND" : "CONTENT_HIDDEN";
        for (const reader of [undefined, ...readers]) {
          const response = await raw(path, reader);
          assert.equal(response.status, visible ? 200 : hiddenStatus, `${label}: saved historical read observes current visibility`);
          assert.equal(response.text.includes(canary), visible, `${label}: saved read content follows current visibility`);
          if (!visible) assert.equal(JSON.parse(response.text).code, hiddenCode);
          if (!visible) {
            const conditional = await raw(path, reader, { "if-none-match": item.etag });
            assert.equal(conditional.status, hiddenStatus, `${label}: prior ETag cannot validate withheld content`);
            assert.equal(JSON.parse(conditional.text).code, hiddenCode);
            assert.ok(!conditional.text.includes(canary));
          }
        }
      }
    };
    const checkPublicMoves = async (scope, target, canary, visible, label, wholeProblem = false) => {
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
        assert.ok(!response.text.includes(canary), "public recommendations carry references instead of untrusted bodies");
        assert.ok(!markdown.text.includes(canary), "public Markdown recommendations do not inline untrusted bodies");
        const json = JSON.parse(response.text);
        const scopes = problemScoped
          ? [ProblemNextResponseSchema.parse(json)]
          : PublicMovesResponseSchema.parse(json).discovery.problems;
        assert.ok(Array.isArray(scopes), "global discovery exposes bounded problem-scoped selections");
        const selectedScope = scopes.find((item) => item.problem_id === scope);
        if (!visible && wholeProblem) {
          assert.equal(selectedScope, undefined, "global needs discovery omits the hidden problem");
          continue;
        }
        assert.ok(selectedScope, `${label}: global and scoped discovery examine the visible problem`);
        assert.equal(selectedScope.viewer.role, "none");
        assert.ok(Object.entries(selectedScope.viewer.effective_permissions).every(([name, allowed]) => name === "read" ? allowed : !allowed), "anonymous needs discovery grants no write authority");
        const moves = [selectedScope.primary_move, ...selectedScope.alternatives].filter(Boolean);
        const relevant = moves.filter((move) => move.refs.includes(scope) && move.refs.includes(target));
        if (!visible) {
          assert.equal(relevant.length, 0, "public discovery does not recommend a hidden claim");
          await checkRemainingMoveReads(moves, canary, label);
          continue;
        }
        assert.ok(relevant.length > 0, `${label}: public discovery has a sensitive target recommendation`);
        for (const move of relevant) {
          const read = move.contract.preparation?.read_first;
          assert.equal(read?.method, "GET");
          const readUrl = new URL(read.path, origin);
          assert.equal(readUrl.origin, origin);
          assert.equal(readUrl.pathname, target.startsWith("C-")
            ? `/p/${scope}/claims/${target}.md` : `/p/${scope}.md`);
          assert.ok(markdown.text.includes(read.path), "public faces agree on the actionable read reference");
          const resolved = await raw(read.path);
          assert.equal(resolved.status, 200);
          assert.ok(resolved.text.includes(canary), "the public recommendation resolves to the canary");
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
    const control = (action, target_kind, target_id) =>
      operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id,
        target_kind,
        action,
        reason: `Hide sweep: ${action} of the ${target_kind}.`,
      });
    await control("hide", "claim", `${problem}/${claim}`);
    await sweep(claimFaces, CLAIM_CANARY, false, "claim hidden");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "claim hidden", [author, claimWatcher]);
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
    await sweepPublicPack(true, "claim restored");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "claim restored", [author, claimWatcher]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "claim restored");
    await checkRecordedReads(problem, CLAIM_CANARY, true, "claim restored", [author, claimWatcher]);
    assert.equal((await raw(exportPath)).status, 200, "the archive returns after restore");

    // 3. A problem hide withholds its title and its claims off /p/ as well.
    await control("hide", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, false, "problem hidden");
    await sweepAuthenticated(titleFellowFaces, TITLE_CANARY, false, "problem hidden");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "problem hidden", [author, claimWatcher], true);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, false, "problem hidden", true);
    await checkRecordedReads(problem, CLAIM_CANARY, false, "problem hidden", [author, claimWatcher]);
    await sweepPacks(CLAIM_CANARY, false, "problem hidden", true);
    await sweepPublicPack(false, "problem hidden", true);
    await sweep(
      claimFaces.filter((path) => !path.startsWith("/p/")),
      CLAIM_CANARY,
      false,
      "problem hidden",
    );
    await control("restore", "problem", problem);
    await sweep(titleFaces, TITLE_CANARY, true, "problem restored");
    await sweepPacks(CLAIM_CANARY, true, "problem restored");
    await sweepPublicPack(true, "problem restored");
    await checkMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "problem restored", [author, claimWatcher]);
    await checkPublicMoves(problem, `${claim}@1`, CLAIM_CANARY, true, "problem restored");
    await checkRecordedReads(problem, CLAIM_CANARY, true, "problem restored", [author, claimWatcher]);
    await control("hide", "problem", sharpening);
    await checkMoves(sharpening, "S@1", STATEMENT_CANARY, false, "sharpening hidden", [sharpener, watcher], true);
    await checkPublicMoves(sharpening, "S@1", STATEMENT_CANARY, false, "sharpening hidden", true);
    await checkRecordedReads(sharpening, STATEMENT_CANARY, false, "sharpening hidden", [sharpener, watcher]);
    await control("restore", "problem", sharpening);
    await checkMoves(sharpening, "S@1", STATEMENT_CANARY, true, "sharpening restored", [sharpener, watcher]);
    await checkPublicMoves(sharpening, "S@1", STATEMENT_CANARY, true, "sharpening restored");
    await checkRecordedReads(sharpening, STATEMENT_CANARY, true, "sharpening restored", [sharpener, watcher]);

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
        reference_reads: recordedReads.size,
      }),
    );
  },
);
