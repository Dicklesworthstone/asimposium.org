import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  CheckpointSignaturesResponseSchema,
  checkpointSignatureMessage,
} from "@asimposium/contracts";
import { verifyExportOffline } from "../../../../scripts/verify-export.ts";
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
    const pinned = [{ key_id: CHECKPOINT_KEY_ID, public_key: CHECKPOINT_PUBLIC_KEY_HEX }];
    const download = async () => {
      const response = await worker.fetch(`${origin}/p/${problem}/export.jsonl.gz`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-asimposium-export-format"),
        "asimposium.problem-export.v5",
      );
      return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
    };
    const unsignedExport = await download();
    const unsignedHeader = JSON.parse(unsignedExport.split("\n")[0]);
    assert.equal(unsignedHeader.format, "asimposium.problem-export.v5");
    assert.deepEqual(unsignedHeader.checkpoint_signatures.signatures, []);
    const unsignedVerification = await verifyExportOffline({
      ndjson: unsignedExport,
      trustedKeys: pinned,
    });
    assert.equal(unsignedVerification.ok, false);
    assert.equal(unsignedVerification.chainLinkageValid, true);
    assert.equal(unsignedVerification.payloadCommitmentRecomputed, true);
    assert.equal(unsignedVerification.checkpointSignaturesValid, null);
    assert.equal(unsignedVerification.signatureCoverage, "none");
    assert.equal(unsignedVerification.authenticated, false);

    // Two consumers can observe the same unsigned rows. Report only actual
    // insertions; ON CONFLICT no-ops are not newly signed checkpoints.
    const signatureCount = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS total FROM checkpoint_signatures").first()).total;
    const countBefore = await signatureCount();
    const ticks = await Promise.all([
      fixtures.signCheckpointsTick(),
      fixtures.signCheckpointsTick(),
    ]);
    assert.ok(ticks.every((tick) => tick.enabled && tick.signed <= 200));
    assert.equal(
      ticks.reduce((total, tick) => total + tick.signed, 0),
      (await signatureCount()) - countBefore,
    );
    assert.ok(ticks.reduce((total, tick) => total + tick.signed, 0) >= before.unsigned);
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
    const ndjson = gunzipSync(Buffer.from(await exported.arrayBuffer())).toString("utf8");
    const header = JSON.parse(ndjson.split("\n")[0]);
    assert.equal(header.format, "asimposium.problem-export.v5");
    assert.equal(header.checkpoint_signatures.problem_id, problem);
    assert.equal(header.checkpoint_signatures.through, header.checkpoints.at(-1).checkpoint_seq);
    assert.deepEqual(header.checkpoint_signatures.keys, before.keys);
    assert.equal(
      header.checkpoint_signatures.signatures.length,
      1,
      "one terminal signature authenticates this key's complete chain prefix",
    );
    const embedded = await verifyExportOffline({ ndjson, trustedKeys: pinned });
    assert.equal(embedded.ok, true, JSON.stringify(embedded.failures));
    assert.equal(embedded.authenticated, true);
    assert.equal(embedded.authenticationScope, "original-event-chain-only");
    assert.equal(embedded.trustedThrough, header.checkpoint_signatures.through);
    assert.equal(embedded.checkpointSignatureCount, 1);
    assert.equal(embedded.signatureCoverage, "complete");
    assert.equal(embedded.publicationContextAssurance, "export-self-consistency-only");
    const untrustedEmbedded = await verifyExportOffline({ ndjson, trustedKeys: [] });
    assert.equal(untrustedEmbedded.ok, false);
    assert.equal(untrustedEmbedded.checkpointSignaturesValid, true);
    assert.equal(untrustedEmbedded.authenticated, false);
    const signedBySeq = new Map(after.signatures.map((s) => [s.checkpoint_seq, s]));
    for (const checkpoint of header.checkpoints) {
      const signature = signedBySeq.get(checkpoint.checkpoint_seq);
      assert.ok(signature, `export checkpoint ${checkpoint.checkpoint_seq} is signed`);
      assert.equal(signature.root_chain_digest, checkpoint.root_chain_digest);
      assert.equal(signature.checkpoint_digest, checkpoint.checkpoint_digest);
    }

    // Offline verification (scripts/verify-export.ts): the real export and
    // signatures verify under the independently pinned key; tampered bytes, a
    // foreign key, or no pinned key fail.
    const good = await verifyExportOffline({ ndjson, signatures: after, trustedKeys: pinned });
    assert.equal(good.ok, true, JSON.stringify(good.failures));
    assert.equal(good.format, header.format);
    assert.equal(good.publicationContextAssurance, "export-self-consistency-only");
    assert.equal(good.publicationContextSha256, header.publication_context_sha256);
    assert.equal(good.publicationNoticeCount, JSON.parse(ndjson.split("\n")[1]).notices.length);
    assert.equal(good.signed, header.checkpoints.length);
    const lines = ndjson.split("\n");
    const target = lines.findIndex((line, i) => i > 0 && line.includes("squared"));
    assert.ok(target > 0, "an event line carries claim text");
    const tampered = lines
      .map((line, i) => (i === target ? line.replace("squared", "squaref") : line))
      .join("\n");
    assert.notEqual(tampered, ndjson);
    assert.equal(
      (await verifyExportOffline({ ndjson: tampered, signatures: after, trustedKeys: pinned })).ok,
      false,
      "tampered export bytes fail",
    );
    const foreign = [{ key_id: CHECKPOINT_KEY_ID, public_key: "ab".repeat(32) }];
    assert.equal(
      (await verifyExportOffline({ ndjson, signatures: after, trustedKeys: foreign })).ok,
      false,
      "a foreign key fails",
    );
    assert.equal(
      (await verifyExportOffline({ ndjson, signatures: after, trustedKeys: [] })).ok,
      false,
      "served keys alone are never trusted",
    );

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

    const laterDraft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Later draft", body_md: "Private later work." },
      author,
      201,
    );
    await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: laterDraft.workshop_id,
        kind: "conjecture",
        statement: "Four squared is even.",
        falsifier: "A counterexample in range.",
      },
      author,
      201,
    );
    const withTail = await download();
    const tail = await verifyExportOffline({ ndjson: withTail, trustedKeys: pinned });
    assert.equal(
      tail.ok,
      false,
      "a newly committed unsigned tail cannot inherit older authentication",
    );
    assert.equal(tail.chainLinkageValid, true);
    assert.equal(tail.checkpointSignaturesValid, true);
    assert.equal(tail.signatureCoverage, "prefix");
    assert.equal(tail.trustedThrough, embedded.trustedThrough);
    assert.equal(tail.authenticated, false);

    // A shape-correct but invalid recorded signature must not be shipped as a
    // successful download. This is a deliberate corruption in the local D1.
    const tailHeader = JSON.parse(withTail.split("\n")[0]);
    await env.DB.prepare(`INSERT INTO checkpoint_signatures
      (problem_id, checkpoint_seq, key_id, algorithm, signature, signed_at)
      VALUES (?, ?, ?, 'Ed25519', ?, '2026-11-06T00:00:00.000Z')`)
      .bind(problem, tailHeader.checkpoint_signatures.through, CHECKPOINT_KEY_ID, "ab".repeat(64))
      .run();
    const corruptExport = await worker.fetch(`${origin}/p/${problem}/export.jsonl.gz`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(corruptExport.status, 500, "invalid stored checkpoint signature fails closed");

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
