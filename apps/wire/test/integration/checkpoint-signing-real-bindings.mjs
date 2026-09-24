import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  CheckpointSignaturesResponseSchema,
  checkpointSignatureMessage,
} from "@asimposium/contracts";
import {
  CHECKPOINT_KEY_ID,
  CHECKPOINT_PUBLIC_KEY_HEX,
  runLocalWorkerJourney,
} from "./problem-lifecycle-real-bindings.mjs";

// Signed integrity checkpoints (ADR-23, bead asimposiumorg-10lz) on real
// Workerd HTTP, D1 and R2. The signer runs as one cron tick of the production
// consumer. The journey verifies signatures with the published public key only.
async function verify(problemId, signature, publicKeyHex) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKeyHex, "hex"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Buffer.from(signature.signature, "hex"),
    new TextEncoder().encode(
      checkpointSignatureMessage({
        problemId,
        checkpointSeq: signature.checkpoint_seq,
        rootChainDigest: signature.root_chain_digest,
        checkpointDigest: signature.checkpoint_digest,
      }),
    ),
  );
}

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures, env, worker, origin, userAgent }) => {
    const author = await enroll("checkpoint-author", "usr_checkpoint_author");
    const reviewer = await enroll("checkpoint-reviewer", "usr_checkpoint_reviewer");
    const created = await call(
      "/v1/problems",
      {
        title: "Checkpointed parity problem",
        statement: "Every integer in 0..50 has a square of the same parity.",
        falsifier: "An integer in 0..50 whose square has the opposite parity.",
        motivation: "Exercise signed integrity checkpoints.",
        areas: ["number-theory"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    await sponsorCall(
      "usr_checkpoint_author",
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const reviewSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: reviewSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "Exact range.",
      },
      reviewer,
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    for (const statement of ["Zero squared is even.", "One squared is odd."]) {
      const draft = await call(
        `/v1/sessions/${session}/workshop`,
        { type: "claim-draft", title: "Draft", body_md: "Private." },
        author,
        201,
      );
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A counterexample in range.",
        },
        author,
        201,
      );
    }

    const face = async () =>
      CheckpointSignaturesResponseSchema.parse(await call(`/p/${problem}/checkpoints.json`));
    const before = await face();
    assert.deepEqual(before.keys, [
      { key_id: CHECKPOINT_KEY_ID, algorithm: "Ed25519", public_key: CHECKPOINT_PUBLIC_KEY_HEX },
    ]);
    assert.equal(before.signatures.length, 0);
    assert.ok(before.unsigned >= 4, "unsigned checkpoints are disclosed before signing");

    const tick = await fixtures.signCheckpointsTick();
    assert.equal(tick.enabled, true);
    assert.ok(tick.signed >= before.unsigned);
    const after = await face();
    assert.equal(after.unsigned, 0);
    assert.equal(after.signatures.length, before.unsigned);
    for (const signature of after.signatures) {
      assert.equal(signature.key_id, CHECKPOINT_KEY_ID);
      assert.equal(await verify(problem, signature, CHECKPOINT_PUBLIC_KEY_HEX), true);
    }
    // Tampering with any signed field breaks verification.
    const [first] = after.signatures;
    const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    assert.equal(
      await verify(
        problem,
        { ...first, checkpoint_digest: flip(first.checkpoint_digest) },
        CHECKPOINT_PUBLIC_KEY_HEX,
      ),
      false,
    );
    assert.equal(
      await verify(
        problem,
        { ...first, signature: flip(first.signature) },
        CHECKPOINT_PUBLIC_KEY_HEX,
      ),
      false,
    );
    assert.equal(await verify("P-OTHER", first, CHECKPOINT_PUBLIC_KEY_HEX), false);

    // A second tick signs nothing new.
    assert.equal((await fixtures.signCheckpointsTick()).signed, 0);

    // Signatures bind the exact checkpoints the public export carries.
    const exported = await worker.fetch(`${origin}/p/${problem}/export.jsonl.gz`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(exported.status, 200);
    const header = JSON.parse(
      gunzipSync(Buffer.from(await exported.arrayBuffer()))
        .toString("utf8")
        .split("\n")[0],
    );
    const signedBySeq = new Map(after.signatures.map((s) => [s.checkpoint_seq, s]));
    for (const checkpoint of header.checkpoints) {
      const signature = signedBySeq.get(checkpoint.checkpoint_seq);
      assert.ok(signature, `export checkpoint ${checkpoint.checkpoint_seq} is signed`);
      assert.equal(signature.root_chain_digest, checkpoint.root_chain_digest);
      assert.equal(signature.checkpoint_digest, checkpoint.checkpoint_digest);
    }

    // Conditional GET and the Markdown face.
    const json = await worker.fetch(`${origin}/p/${problem}/checkpoints.json`, {
      headers: { "User-Agent": userAgent },
    });
    const etag = json.headers.get("etag");
    assert.ok(etag);
    const conditional = await worker.fetch(`${origin}/p/${problem}/checkpoints.json`, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag },
    });
    assert.equal(conditional.status, 304);
    const markdown = await (
      await worker.fetch(`${origin}/p/${problem}/checkpoints.md`, {
        headers: { "User-Agent": userAgent },
      })
    ).text();
    assert.ok(markdown.includes(CHECKPOINT_PUBLIC_KEY_HEX) && markdown.includes(first.signature));

    // Signatures are append-only in D1.
    await assert.rejects(
      env.DB.prepare("UPDATE checkpoint_signatures SET signature = ? WHERE problem_id = ?")
        .bind("0".repeat(128), problem)
        .run(),
    );
    await assert.rejects(
      env.DB.prepare("DELETE FROM checkpoint_signatures WHERE problem_id = ?").bind(problem).run(),
    );

    console.log(
      JSON.stringify({
        stage: "checkpoint-signing-journey-passed",
        kind: "checkpoint-signing-real-bindings",
        status: "pass",
        signed: after.signatures.length,
        boundary: "local Workerd/D1/R2; signer run as one cron-tick call; per-run local key",
      }),
    );
  },
);
