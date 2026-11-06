import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { checkpointSignatureMessage } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import { readExportCheckpointBundle } from "../../src/krater/export-signatures.ts";
import { checkpointDigest, sha256Hex } from "../../src/krater/krater.ts";

/** Query/crypto unit proof. The integration lane separately runs the real
 * Worker read, signer and D1 tables; this fixture makes selection edges cheap. */
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE checkpoint_chain_v2 (
      problem_id TEXT, checkpoint_seq INTEGER, root_chain_digest TEXT,
      checkpoint_digest TEXT, chain_version INTEGER, PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE integrity_checkpoints (
      problem_id TEXT, checkpoint_seq INTEGER, checkpoint_version INTEGER,
      checkpoint_mode TEXT, PRIMARY KEY(problem_id,checkpoint_seq));
    CREATE TABLE checkpoint_signatures (
      problem_id TEXT, checkpoint_seq INTEGER, key_id TEXT, algorithm TEXT,
      signature TEXT, signed_at TEXT, PRIMARY KEY(problem_id,checkpoint_seq,key_id));`);
  const a = await checkpointSigningKey(JSON.stringify({ kid: "key-a", seedHex: "11".repeat(32) }));
  const b = await checkpointSigningKey(JSON.stringify({ kid: "key-b", seedHex: "22".repeat(32) }));
  if (!a || !b) throw new Error("test keys unavailable");
  const defaultKey = a;
  const keys = [a, b];
  const raw = JSON.stringify(keys.map((key) => ({ kid: key.kid, publicKeyHex: key.publicKeyHex })));
  for (const problem of ["P-EXPORT", "P-OTHER"]) {
    for (const seq of [1, 2, 3, 4]) {
      const root = await sha256Hex(`${problem}/${seq}`);
      sql
        .query("INSERT INTO checkpoint_chain_v2 VALUES(?,?,?,?,2)")
        .run(problem, seq, root, await checkpointDigest(problem, seq, root));
      sql.query("INSERT INTO integrity_checkpoints VALUES(?,?,1,'unsigned-v0')").run(problem, seq);
    }
  }
  async function sign(seq: number, key = defaultKey, problem = "P-EXPORT", invalid = false) {
    const checkpoint = sql
      .query("SELECT * FROM checkpoint_chain_v2 WHERE problem_id=? AND checkpoint_seq=?")
      .get(problem, seq) as { root_chain_digest: string; checkpoint_digest: string };
    const signature = invalid
      ? "ab".repeat(64)
      : Buffer.from(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            key.privateKey,
            new TextEncoder().encode(
              checkpointSignatureMessage({
                problemId: problem,
                checkpointSeq: seq,
                rootChainDigest: checkpoint.root_chain_digest,
                checkpointDigest: checkpoint.checkpoint_digest,
              }),
            ),
          ),
        ).toString("hex");
    sql
      .query(
        "INSERT INTO checkpoint_signatures VALUES(?,?,?,'Ed25519',?,'2026-11-06T00:00:00.000Z')",
      )
      .run(problem, seq, key.kid, signature);
  }
  await sign(2, a);
  await sign(4, a);
  await sign(3, b);
  await sign(3, a, "P-OTHER");
  let reads = 0;
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number)[]) {
          return {
            all: async () => {
              reads++;
              return { success: true, results: sql.query(query).all(...values) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sql, db, raw, keys, sign, reads: () => reads };
}

test("export signatures select one verified prefix per rotated key at the captured cut", async () => {
  const f = await fixture();
  try {
    const cut = await readExportCheckpointBundle(f.db, f.raw, "P-EXPORT", 3);
    expect(cut.through).toBe(3);
    expect(cut.signatures.map((signature) => [signature.checkpoint_seq, signature.key_id])).toEqual(
      [
        [2, "key-a"],
        [3, "key-b"],
      ],
    );
    expect(cut.keys.map((key) => key.key_id)).toEqual(["key-a", "key-b"]);
    expect(f.reads()).toBe(1);
    const later = await readExportCheckpointBundle(f.db, f.raw, "P-EXPORT", 4);
    expect(
      later.signatures.map((signature) => [signature.checkpoint_seq, signature.key_id]),
    ).toEqual([
      [3, "key-b"],
      [4, "key-a"],
    ]);
    expect(f.reads()).toBe(2);
    const beforeSigning = await readExportCheckpointBundle(f.db, f.raw, "P-EXPORT", 1);
    expect(beforeSigning.signatures).toEqual([]);
  } finally {
    f.sql.close();
  }
});

test("public export never falls back past a corrupted latest signature or ambiguous key configuration", async () => {
  const f = await fixture();
  try {
    await f.sign(3, f.keys[0], "P-EXPORT", true);
    await expect(readExportCheckpointBundle(f.db, f.raw, "P-EXPORT", 3)).rejects.toThrow(
      "EXPORT_CHECKPOINT_SIGNATURE_INVALID",
    );
    const ambiguous = JSON.stringify([
      { kid: "key-a", publicKeyHex: f.keys[0]!.publicKeyHex },
      { kid: "key-a", publicKeyHex: f.keys[1]!.publicKeyHex },
    ]);
    await expect(readExportCheckpointBundle(f.db, ambiguous, "P-EXPORT", 3)).rejects.toThrow(
      "EXPORT_CHECKPOINT_KEYS_AMBIGUOUS",
    );
  } finally {
    f.sql.close();
  }
});

test("unconfigured signing and empty history are explicit and perform no signature-table reads", async () => {
  const f = await fixture();
  try {
    for (const [raw, through] of [
      [undefined, 3],
      [f.raw, 0],
    ] as const) {
      const bundle = await readExportCheckpointBundle(f.db, raw, "P-EXPORT", through);
      expect(bundle.signatures).toEqual([]);
      expect(bundle.keys).toEqual([]);
      expect(bundle.key_trust).toBe("independently-pinned-keys-required");
    }
    expect(f.reads()).toBe(0);
  } finally {
    f.sql.close();
  }
});
