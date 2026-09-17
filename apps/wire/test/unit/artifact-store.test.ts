import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  ArtifactUploadError, declareArtifact, completeArtifact, readArtifactManifest,
  readVerifiedArtifact, type ArtifactActor, type ArtifactReplayCodec,
} from "../../src/krater/artifact-store.ts";
import { artifactSha256 } from "../../src/krater/artifact-inspection.ts";
import { artifactStagingKey } from "../../src/krater/artifact-presign.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const actor: ArtifactActor = { fellowId: "fellow-a", credentialId: "token-a", sponsorId: "usr_a" };
const other: ArtifactActor = { fellowId: "fellow-b", credentialId: "token-b", sponsorId: "usr_a" };
const config = { accountId: "a".repeat(32), bucket: "private-artifacts", accessKeyId: "b".repeat(32),
  secretAccessKey: "c".repeat(64), sponsorDailyBytes: 1024 ** 3, fellowDailyManifests: 100 };
const bytes = new TextEncoder().encode("theorem example : True := by trivial\n");

// Tests execute the new production migration and queries. Identity/session
// tables model the relevant shipped columns, not the entire migration chain.
async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, unlisted INTEGER);
    CREATE TABLE enrollment_fellows (fellow_id TEXT PRIMARY KEY, sponsor_id TEXT, status TEXT);
    CREATE TABLE fellow_tokens (credential_id TEXT PRIMARY KEY, fellow_id TEXT, sponsor_id TEXT,
      granted_scopes_json TEXT, granted_resources_json TEXT, issued_at INTEGER, expires_at INTEGER,
      revoked_at INTEGER, credential_profile TEXT);
    CREATE TABLE enrollment_grants (fellow_id TEXT PRIMARY KEY, sponsor_id TEXT,
      granted_scopes_json TEXT, granted_resources_json TEXT);
    CREATE TABLE enrollment_sponsor_security (sponsor_id TEXT PRIMARY KEY, panic_at INTEGER);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, fellow_id TEXT, problem_id TEXT,
      opened_at TEXT, idle_close_at TEXT, closed_at TEXT);
    CREATE TABLE problem_memberships (problem_id TEXT, fellow_id TEXT, role TEXT);
    CREATE TABLE events (writer_credential_id TEXT);
    CREATE TABLE public_cursor (cursor INTEGER);
    INSERT INTO public_cursor VALUES (7);
    INSERT INTO problems VALUES ('P-DEMO', 'private-draft', 1);`);
  for (const [fellow, credential, session] of [["fellow-a", "token-a", "S-a"], ["fellow-b", "token-b", "S-b"]]) {
    sql.query("INSERT INTO enrollment_fellows VALUES (?, 'usr_a', 'active')").run(fellow);
    sql.query(`INSERT INTO fellow_tokens VALUES (?, ?, 'usr_a', '["upload-artifacts"]', '{}', ?, ?, NULL, 'bearer')`)
      .run(credential, fellow, NOW - 10000, NOW + 7 * 86400000);
    sql.query(`INSERT INTO enrollment_grants VALUES (?, 'usr_a', '["upload-artifacts"]', '{}')`).run(fellow);
    sql.query("INSERT INTO sessions VALUES (?, ?, 'P-DEMO', ?, ?, NULL)").run(session, fellow, iso(-10000), iso(43200000));
    sql.query("INSERT INTO problem_memberships VALUES ('P-DEMO', ?, 'contributor')").run(fellow);
  }
  sql.exec(readFileSync(new URL("../../../../db/migrations/0069_artifact_uploads.sql", import.meta.url), "utf8"));
  let before: ((text: string) => void) | undefined;
  const prepare = (text: string) => {
    let binds: unknown[] = [];
    const execute = () => {
      before?.(text);
      return { results: sql.query(text).all(...binds as never[]), meta: {
        changes: (sql.query("SELECT changes() AS n").get() as { n: number }).n,
      } };
    };
    return { bind(...values: unknown[]) { binds = values; return this; },
      async first() { return execute().results[0] ?? null; }, async all() { return execute(); }, async run() { return execute(); } };
  };
  const db = { prepare } as unknown as D1Database;
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(19), "AES-GCM", false, ["encrypt", "decrypt"]);
  const codec: ArtifactReplayCodec = {
    async seal(value, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode(context) }, key, new TextEncoder().encode(value));
      return { ciphertext: Buffer.from(encrypted).toString("base64"), initializationVector: Buffer.from(iv).toString("base64") };
    },
    async open(value, context) {
      const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(value.initializationVector, "base64"),
        additionalData: new TextEncoder().encode(context) }, key, Buffer.from(value.ciphertext, "base64"));
      return new TextDecoder().decode(decoded);
    },
  };
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  let onGet: ((key: string) => void) | undefined;
  let onPut: ((key: string) => void) | undefined;
  const bucket = {
    async get(key: string) {
      const value = objects.get(key)?.slice(); onGet?.(key);
      return value === undefined ? null : { size: value.length,
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(value); c.close(); } }) };
    },
    async put(key: string, value: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentDisposition: string } }) {
      onPut?.(key);
      assert.equal(options.onlyIf.etagDoesNotMatch, "*");
      assert.equal(options.httpMetadata.contentDisposition, "attachment");
      if (objects.has(key)) return null;
      objects.set(key, value.slice()); writes.push(key); return { key };
    },
  } as unknown as R2Bucket;
  let instant = NOW;
  const clock = () => instant;
  const declaration = { sessionId: "S-a", sha256: await artifactSha256(bytes), size: bytes.length, encoding: "text" as const };
  const create = (key = "request-1", input = declaration, who = actor, settings = config) =>
    declareArtifact(db, codec, settings, who, input, key, clock);
  const complete = (id: string, who = actor) => completeArtifact(db, bucket, who, id, clock);
  const read = (id: string, who = actor) => readVerifiedArtifact(db, bucket, who, id, clock);
  const rows = () => sql.query("SELECT * FROM artifact_uploads ORDER BY upload_id").all() as Record<string, unknown>[];
  const audit = () => sql.query("SELECT state FROM artifact_upload_events ORDER BY seq").all() as { state: string }[];
  const grant = (resource: object) => {
    for (const table of ["fellow_tokens", "enrollment_grants"]) sql.query(`UPDATE ${table} SET granted_resources_json = ?`).run(JSON.stringify(resource));
  };
  return { sql, db, codec, bucket, objects, writes, declaration, create, complete, read, rows, audit, grant, clock,
    now: (value: number) => { instant = value; },
    before: (hook: ((text: string) => void) | undefined) => { before = hook; },
    onGet: (hook: ((key: string) => void) | undefined) => { onGet = hook; },
    onPut: (hook: ((key: string) => void) | undefined) => { onPut = hook; },
  };
}
async function using(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); try { await run(f); } finally { f.sql.close(); }
}
const failure = (code: string) => (error: unknown) => error instanceof ArtifactUploadError && error.code === code;

test("manifest reserves private storage and seals the PUT capability; no public event or cursor", async () => {
  await using(async f => {
    const receipt = await f.create();
    assert.equal(receipt.storage, "private"); assert.match(receipt.put.url, /X-Amz-Signature=/);
    assert.equal(f.rows().length, 1); assert.deepEqual(f.audit().map(x => x.state), ["presigned"]);
    assert.ok(!JSON.stringify(f.rows()).includes("X-Amz-Signature")); assert.equal(f.writes.length, 0);
    assert.equal((f.sql.query("SELECT cursor FROM public_cursor").get() as {cursor:number}).cursor, 7);
    assert.equal(f.sql.query("SELECT * FROM events").all().length, 0);
  });
});

test("thirty same-key admissions share one reservation and the original sealed URL", async () => {
  await using(async f => {
    const receipts = await Promise.all(Array.from({length:30}, () => f.create()));
    for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
    assert.equal(f.rows().length, 1); assert.equal(f.audit().length, 1);
    f.now(NOW + 60000); assert.deepEqual(await f.create(), receipts[0]);
  });
});

test("idempotency conflict does not mint a second manifest or extend its deadline", async () => {
  await using(async f => {
    await f.create();
    await assert.rejects(f.create("request-1", {...f.declaration, sha256:"a".repeat(64)}), failure("CONFLICT"));
    f.now(NOW + 86400000); await assert.rejects(f.create(), failure("EXPIRED"));
    assert.equal(f.rows().length, 1);
  });
});

for (const [name, mutation] of [
  ["revocation", "UPDATE fellow_tokens SET revoked_at = 1"],
  ["sponsor panic", `INSERT INTO enrollment_sponsor_security VALUES ('usr_a', ${NOW})`],
  ["suspicious account", "UPDATE enrollment_fellows SET status = 'suspicious_review'"],
  ["pause", "UPDATE enrollment_fellows SET status = 'paused'"],
  ["missing upload scope", `UPDATE fellow_tokens SET granted_scopes_json = '[]'; UPDATE enrollment_grants SET granted_scopes_json = '[]'`],
  ["closed session", `UPDATE sessions SET closed_at = '${iso()}'`],
  ["idle session", `UPDATE sessions SET idle_close_at = '${iso()}'`],
  ["removed membership", "DELETE FROM problem_memberships"],
] as const) test(`transactional admission refuses ${name}`, async () => {
  await using(async f => {
    f.sql.exec(mutation); await assert.rejects(f.create(), failure("NOT_ALLOWED"));
    assert.deepEqual(f.rows(), []); assert.deepEqual(f.audit(), []);
  });
});

test("grants constrain binding, expiry and event budget inside admission", async () => {
  for (const resource of [{problemBinding:"P-OTHER"}, {fellowGrantExpiresAt:NOW}, {eventBudget:0}]) {
    await using(async f => { f.grant(resource); await assert.rejects(f.create(), failure("NOT_ALLOWED")); });
  }
});

test("issued-byte budgets are atomic, include failed/pending bytes, and permit same-key replay", async () => {
  await using(async f => {
    f.grant({artifactBudgetBytes:bytes.length}); const first = await f.create();
    assert.deepEqual(await f.create(), first);
    await assert.rejects(f.create("request-2"), failure("BUDGET"));
    assert.equal(f.rows().length, 1);
  });
});

test("Fellow rotation and another Fellow cannot reset grant or sponsor budgets", async () => {
  await using(async f => {
    f.grant({artifactBudgetBytes:bytes.length}); await f.create();
    f.sql.exec("INSERT INTO fellow_tokens SELECT 'rotated', fellow_id, sponsor_id, granted_scopes_json, granted_resources_json, issued_at, expires_at, NULL, credential_profile FROM fellow_tokens WHERE credential_id = 'token-a'");
    await assert.rejects(f.create("request-2", f.declaration, {...actor,credentialId:"rotated"}), failure("BUDGET"));
    const cap = {...config,sponsorDailyBytes:bytes.length};
    await assert.rejects(f.create("other-1", {...f.declaration,sessionId:"S-b"}, other,cap), failure("BUDGET"));
  });
});

test("daily count and plan's 200 MiB limit stop unbounded capability issuance", async () => {
  await using(async f => {
    await f.create("r1", f.declaration, actor, {...config,fellowDailyManifests:1});
    await assert.rejects(f.create("r2", f.declaration, actor, {...config,fellowDailyManifests:1}), failure("BUDGET"));
  });
  await using(async f => {
    const big = {...f.declaration,encoding:"lake-archive" as const,size:20*1024*1024};
    for (let i=0;i<10;i++) await f.create(`r${i}`,big);
    await assert.rejects(f.create("too-many",big), failure("BUDGET"));
  });
});

test("uploaded bytes verify into private CAS, download by owner, and survive session close", async () => {
  await using(async f => {
    const receipt = await f.create(); f.objects.set(artifactStagingKey(receipt.upload_id), bytes);
    const result = await f.complete(receipt.upload_id); assert.equal(result.state, "verified");
    assert.equal(result.content_type, "text/plain; charset=utf-8");
    assert.deepEqual(f.audit().map(x=>x.state), ["presigned","verified"]);
    assert.deepEqual(await f.complete(receipt.upload_id), result);
    f.sql.exec(`UPDATE sessions SET closed_at = '${iso()}'`);
    assert.deepEqual((await f.read(receipt.upload_id)).bytes,bytes);
    assert.deepEqual(f.writes, [`cas/sha256/${receipt.sha256}`]);
  });
});

test("missing upload stays pending and a later upload can complete", async () => {
  await using(async f => {
    const receipt = await f.create();
    await assert.rejects(f.complete(receipt.upload_id), failure("NOT_UPLOADED"));
    assert.equal(f.rows()[0]?.state,"presigned"); assert.equal(f.rows()[0]?.lease_token,null);
    f.objects.set(artifactStagingKey(receipt.upload_id),bytes);
    assert.equal((await f.complete(receipt.upload_id)).state,"verified");
  });
});

test("size, digest and secret failures quarantine without publishing or retaining the secret in audit", async () => {
  for (const [body,code,matching] of [[new TextEncoder().encode("x"),"MISMATCH",false],
    [new Uint8Array(bytes.length).fill(65),"MISMATCH",false],
    [new TextEncoder().encode("sk_live_"+"x".repeat(30)),"CONTENT_REFUSED",true]] as const) {
    await using(async f => {
      const input = matching ? {...f.declaration,sha256:await artifactSha256(body),size:body.length} : f.declaration;
      const receipt=await f.create("request-1",input); f.objects.set(artifactStagingKey(receipt.upload_id),body);
      await assert.rejects(f.complete(receipt.upload_id),failure(code));
      assert.equal(f.rows()[0]?.state,"quarantined"); assert.equal(f.writes.length,0);
      assert.ok(!JSON.stringify(f.rows()).includes("sk_live_"));
      assert.deepEqual(f.audit().map(x=>x.state),["presigned","quarantined"]);
    });
  }
});

test("concurrent verification has one terminal transition and safely retries busy calls", async () => {
  await using(async f => {
    const receipt=await f.create(); f.objects.set(artifactStagingKey(receipt.upload_id),bytes);
    const results=await Promise.allSettled(Array.from({length:20},()=>f.complete(receipt.upload_id)));
    assert.ok(results.some(r=>r.status==="fulfilled"));
    for(const r of results) if(r.status==="rejected") assert.ok(failure("BUSY")(r.reason));
    assert.deepEqual(f.audit().map(x=>x.state),["presigned","verified"]);
    assert.equal((await f.complete(receipt.upload_id)).state,"verified");
  });
});

test("same verified bytes dedupe without exposing another Fellow's manifest", async () => {
  await using(async f => {
    const a=await f.create(); const b=await f.create("other",{...f.declaration,sessionId:"S-b"},other);
    f.objects.set(artifactStagingKey(a.upload_id),bytes); f.objects.set(artifactStagingKey(b.upload_id),bytes);
    await f.complete(a.upload_id); await f.complete(b.upload_id,other);
    assert.equal(f.writes.length,1);
    await assert.rejects(f.read(a.upload_id,other),failure("NOT_FOUND"));
    await assert.rejects(readArtifactManifest(f.db,other,a.upload_id,NOW),failure("NOT_FOUND"));
  });
});

test("corrupt existing CAS is operational failure, not a verdict against the new uploader", async () => {
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes);
    f.objects.set(`cas/sha256/${a.sha256}`,new Uint8Array([0]));
    await assert.rejects(f.complete(a.upload_id),failure("UNAVAILABLE"));
    assert.equal(f.rows()[0]?.state,"presigned"); assert.equal(f.audit().length,1);
  });
});

test("revocation during storage work prevents a verified manifest or readable private artifact", async () => {
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes);
    f.onPut(()=>f.sql.exec("UPDATE fellow_tokens SET revoked_at = 1"));
    await assert.rejects(f.complete(a.upload_id),failure("NOT_ALLOWED"));
    assert.equal(f.rows()[0]?.state,"presigned");
    await assert.rejects(f.read(a.upload_id),failure("NOT_FOUND"));
    assert.equal(f.audit().length,1);
  });
});

test("membership removal during download prevents returning already-read bytes", async () => {
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes); await f.complete(a.upload_id);
    f.onGet(()=>f.sql.exec("DELETE FROM problem_memberships"));
    await assert.rejects(f.read(a.upload_id),failure("NOT_FOUND"));
  });
});

test("a lost lease cannot finish or clear another verifier's ownership", async () => {
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes);
    f.onPut(()=> {
      f.now(NOW+60001);
      f.sql.query("UPDATE artifact_uploads SET lease_token = ?, lease_until = ?, updated_at = ? WHERE upload_id = ?")
        .run("f".repeat(32),NOW+120001,NOW+60001,a.upload_id);
    });
    await assert.rejects(f.complete(a.upload_id),failure("BUSY"));
    assert.equal(f.rows()[0]?.lease_token,"f".repeat(32)); assert.equal(f.rows()[0]?.state,"presigned");
  });
});

test("expiry preserves audit and refuses late completion instead of publishing stale capabilities", async () => {
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes);
    f.now(NOW+86400000); await assert.rejects(f.complete(a.upload_id),failure("EXPIRED"));
    assert.deepEqual(f.audit().map(x=>x.state),["presigned","expired"]); assert.equal(f.writes.length,0);
  });
});

test("audit failure rolls back manifest admission; terminal states and identity cannot be rewritten", async () => {
  await using(async f => {
    f.sql.exec("CREATE TRIGGER planted BEFORE INSERT ON artifact_upload_events BEGIN SELECT RAISE(ABORT,'planted'); END");
    await assert.rejects(f.create(),failure("UNAVAILABLE")); assert.equal(f.rows().length,0);
  });
  await using(async f => {
    const a=await f.create(); f.objects.set(artifactStagingKey(a.upload_id),bytes);
    assert.throws(()=>f.sql.exec("UPDATE artifact_uploads SET sha256 = '"+"f".repeat(64)+"'"));
    await f.complete(a.upload_id);
    assert.throws(()=>f.sql.exec("UPDATE artifact_uploads SET state = 'presigned'"));
    assert.throws(()=>f.sql.exec("UPDATE artifact_upload_events SET state = 'expired'"));
    assert.throws(()=>f.sql.exec("DELETE FROM artifact_uploads"));
  });
});

test("database constraints refuse incomplete verification and one-sided leases", async () => {
  await using(async f => {
    const a=await f.create();
    assert.throws(()=>f.sql.exec(`UPDATE artifact_uploads SET lease_token = '${"a".repeat(32)}'`));
    assert.throws(()=>f.sql.exec(`UPDATE artifact_uploads SET lease_until = ${NOW+1000}`));
    f.sql.exec(`UPDATE artifact_uploads SET lease_token = '${"a".repeat(32)}', lease_until = ${NOW+1000}`);
    assert.throws(()=>f.sql.exec(`UPDATE artifact_uploads SET state='verified',content_type='text/plain; charset=utf-8',lease_token=NULL,lease_until=NULL`));
    assert.equal(f.rows()[0]?.state,"presigned"); assert.ok(a.upload_id);
  });
});
