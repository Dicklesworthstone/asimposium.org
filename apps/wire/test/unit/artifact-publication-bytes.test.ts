import assert from "node:assert/strict";
import { test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  artifactSha256, ArtifactInspectionError, inspectArtifact,
  inspectArtifactForPublication, MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES,
} from "../../src/krater/artifact-inspection.ts";
import {
  artifactPublicationOrigin, ArtifactPublicationStorageError, PUBLIC_ARTIFACT_CACHE_CONTROL,
  publicArtifactKey, putPublicArtifact, readPublicationBytes,
} from "../../src/krater/artifact-publication-bytes.ts";

const enc = new TextEncoder();
const textBytes = enc.encode("theorem example : True := by trivial\n");
interface Member { name: string; text?: string; directory?: boolean; user?: string; group?: string }
function tar(members: readonly Member[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const m of members) {
    const body = enc.encode(m.text ?? "");
    const h = Buffer.alloc(512);
    h.write(m.name, 0, 100, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.fill(32, 148, 156); h[156] = m.directory ? 53 : 48;
    h.write("ustar\0", 257); h.write("00", 263);
    h.write(m.user ?? "researcher", 265, 32); h.write(m.group ?? "research", 297, 32);
    h.write(h.reduce((sum, n) => sum + n, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, new Uint8Array((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, new Uint8Array(1024)]);
}
function archive(members: readonly Member[], metadata = false): Uint8Array {
  const gz = gzipSync(tar(members));
  if (!metadata) return gz;
  const h = Uint8Array.from(gz.subarray(0, 10)); h[3] = 24;
  return Buffer.concat([h, enc.encode("source.tar\0a deliberate source archive\0"), gz.subarray(10)]);
}
const inspect = async (bytes: Uint8Array, encoding: "text" | "lake-archive" = "text") =>
  inspectArtifactForPublication(bytes, encoding, await artifactSha256(bytes));
const failure = (code: string) => (error: unknown) => error instanceof ArtifactInspectionError && error.code === code;

test("publication inspection binds the complete source, not a prefix or scientific verdict", async () => {
  const result = await inspect(textBytes);
  const document = JSON.parse(result.screeningBody);
  assert.equal(document.items[0].text, new TextDecoder().decode(textBytes));
  assert.equal(result.artifact.sha256, await artifactSha256(textBytes));
  assert.equal(result.screeningSha256, await artifactSha256(enc.encode(result.screeningBody)));
  assert.equal("certified" in result, false);
  assert.deepEqual(await inspect(textBytes), result);
});
test("all archive bodies, names, owners, groups and gzip comments are screened", async () => {
  const bytes = archive([
    {name:"Lake/",directory:true}, {name:"Lake/Main.lean",text:"-- Δ\ntheorem x : True := by trivial"},
    {name:"lakefile.toml",text:'name = "Example"\n',user:"Builder",group:"Authors"},
  ], true);
  const result = await inspect(bytes, "lake-archive");
  const items = JSON.parse(result.screeningBody).items;
  assert.equal(items.length, 5);
  assert.deepEqual(items[0], {kind:"gzip-name",text:"source.tar"});
  assert.deepEqual(items[1], {kind:"gzip-comment",text:"a deliberate source archive"});
  assert.equal(items[2].kind, "directory");
  assert.equal(items[3].name, "Lake/Main.lean");
  assert.match(items[3].text, /Δ/);
  assert.equal(items[4].user, "Builder");
  assert.equal(items[4].group, "Authors");
  assert.equal(result.artifact.members, 3);
});
test("UTF-8 and JSON escaping count against the exact whole-document ceiling", async () => {
  const overhead = enc.encode((await inspect(enc.encode("x"))).screeningBody).length - 1;
  const full = enc.encode("x".repeat(MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES - overhead));
  assert.equal(enc.encode((await inspect(full)).screeningBody).length, MAX_ARTIFACT_PUBLICATION_SCREEN_BYTES);
  await assert.rejects(inspect(Buffer.concat([full, enc.encode("x")])), failure("ARTIFACT_PUBLICATION_TOO_LARGE"));
  await assert.rejects(inspect(enc.encode("😀".repeat(20_000))), failure("ARTIFACT_PUBLICATION_TOO_LARGE"));
  await assert.rejects(inspect(enc.encode('"'.repeat(40_000))), failure("ARTIFACT_PUBLICATION_TOO_LARGE"));
});
test("publication limits do not reduce private upload admission", async () => {
  const bytes = enc.encode("x".repeat(80_000));
  assert.equal((await inspectArtifact(bytes, "text", await artifactSha256(bytes))).size, bytes.length);
  await assert.rejects(inspect(bytes), failure("ARTIFACT_PUBLICATION_TOO_LARGE"));
});
test("no document is returned after a late bad archive member or trailer", async () => {
  const invalid = archive([{name:"ok.txt",text:"fine"},{name:"secret.txt",text:"person@example.org"}]);
  await assert.rejects(inspect(invalid, "lake-archive"), failure("ARTIFACT_SECRET_SHAPED"));
  const badCrc = Uint8Array.from(archive([{name:"good.txt",text:"fine"}])); badCrc[badCrc.length - 8] ^= 1;
  await assert.rejects(inspect(badCrc, "lake-archive"), failure("ARTIFACT_ARCHIVE_INVALID"));
});
test("a later gzip member cannot escape publication screening", async () => {
  const two = Buffer.concat([archive([{name:"a.txt",text:"fine"}]), gzipSync(enc.encode("hidden"))]);
  await assert.rejects(inspect(two, "lake-archive"), failure("ARTIFACT_ARCHIVE_INVALID"));
});
test("invalid digest, active markup and secrets remain byte-admission refusals", async () => {
  await assert.rejects(inspectArtifactForPublication(textBytes, "text", "0".repeat(64)), failure("ARTIFACT_DIGEST_MISMATCH"));
  for (const source of ["<svg></svg>", "<!doctype html><html></html>", "\0bad"]) {
    await assert.rejects(inspect(enc.encode(source)), failure("ARTIFACT_TYPE_FORBIDDEN"));
  }
  await assert.rejects(inspect(enc.encode("-----BEGIN PRIVATE KEY-----")), failure("ARTIFACT_SECRET_SHAPED"));
});
test("only canonical deployment origins mint direct public URLs", () => {
  assert.equal(artifactPublicationOrigin("https://a.asimposium.org"), "https://artifacts.asimposium.org");
  assert.equal(artifactPublicationOrigin("https://a-staging.asimposium.org"), "https://artifacts-staging.asimposium.org");
  for (const origin of [undefined,"http://127.0.0.1:8787","https://a.asimposium.org/","https://evil.test"]) {
    assert.equal(artifactPublicationOrigin(origin), undefined);
  }
  assert.equal(publicArtifactKey("a".repeat(64)), `sha256/${"a".repeat(64)}`);
  assert.throws(() => publicArtifactKey("../private"), ArtifactPublicationStorageError);
});

/** Unit-test storage port, not a deployed D1/R2 integration claim. */
function memoryBucket() {
  const objects = new Map<string, {bytes:Uint8Array; httpMetadata:Record<string,string>}>();
  let writes = 0;
  const port = {
    async get(key:string) {
      const item = objects.get(key); if (!item) return null;
      return {size:item.bytes.length,httpMetadata:item.httpMetadata,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(item.bytes.slice());c.close();}})};
    },
    async put(key:string, bytes:Uint8Array, options: {sha256:string;onlyIf:{etagDoesNotMatch:string};httpMetadata:Record<string,string>}) {
      assert.equal(options.onlyIf.etagDoesNotMatch,"*");
      assert.equal(options.sha256,await artifactSha256(bytes));
      if (objects.has(key)) return null;
      writes++;
      objects.set(key,{bytes:bytes.slice(),httpMetadata:{...options.httpMetadata}});
      return {size:bytes.length};
    },
  };
  return {bucket:port as unknown as R2Bucket, port, objects, writes:()=>writes};
}
async function stored() {
  const privateStore=memoryBucket(), publicStore=memoryBucket();
  const sha256=await artifactSha256(textBytes);
  privateStore.objects.set(`cas/sha256/${sha256}`,{bytes:textBytes,httpMetadata:{}});
  const content=await readPublicationBytes(privateStore.bucket,{sha256,size_bytes:textBytes.length,encoding:"text"});
  return {privateStore,publicStore,content,sha256};
}
test("direct public delivery uses immutable attachments and no private metadata", async () => {
  const f=await stored(); await putPublicArtifact(f.publicStore.bucket,f.content);
  const obj=f.publicStore.objects.get(`sha256/${f.sha256}`)!;
  assert.deepEqual(obj.bytes,textBytes);
  assert.deepEqual(obj.httpMetadata,{contentType:"text/plain; charset=utf-8",contentDisposition:"attachment",cacheControl:PUBLIC_ARTIFACT_CACHE_CONTROL});
  assert.equal(f.privateStore.writes(),0);
});
test("deduplicated delivery verifies prior bytes without overwriting them", async () => {
  const f=await stored();
  await Promise.all(Array.from({length:8},()=>putPublicArtifact(f.publicStore.bucket,f.content)));
  assert.equal(f.publicStore.writes(),1);
});
test("pre-existing corruption and unsafe metadata fail closed without repair overwrites", async () => {
  for (const corrupt of ["body","type","disposition","cache"] as const) {
    const f=await stored(); await putPublicArtifact(f.publicStore.bucket,f.content);
    const obj=f.publicStore.objects.get(`sha256/${f.sha256}`)!;
    if(corrupt === "body") obj.bytes=Uint8Array.from(textBytes,x=>x===10?10:65);
    if(corrupt === "type") obj.httpMetadata.contentType="text/html";
    if(corrupt === "disposition") obj.httpMetadata.contentDisposition="inline";
    if(corrupt === "cache") obj.httpMetadata.cacheControl="private";
    await assert.rejects(putPublicArtifact(f.publicStore.bucket,f.content),ArtifactPublicationStorageError);
    assert.equal(f.publicStore.writes(),1);
  }
});
test("mutating inspected bytes does not publish under the old digest", async () => {
  const f=await stored(); f.content.bytes[0]^=1;
  await assert.rejects(putPublicArtifact(f.publicStore.bucket,f.content),ArtifactPublicationStorageError);
  assert.equal(f.publicStore.writes(),0);
});
test("missing or wrong-sized private bytes do not return a publication input", async () => {
  const f=await stored(); f.privateStore.objects.clear();
  await assert.rejects(readPublicationBytes(f.privateStore.bucket,{sha256:f.sha256,size_bytes:textBytes.length,encoding:"text"}),ArtifactPublicationStorageError);
  f.privateStore.objects.set(`cas/sha256/${f.sha256}`,{bytes:enc.encode("short"),httpMetadata:{}});
  await assert.rejects(readPublicationBytes(f.privateStore.bucket,{sha256:f.sha256,size_bytes:textBytes.length,encoding:"text"}),ArtifactPublicationStorageError);
});
test("a stalled private stream is timed out and cancelled", async () => {
  let cancelled=false;
  const f=await stored();
  const bucket={async get(){return {size:textBytes.length,body:new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}})};}} as unknown as R2Bucket;
  await assert.rejects(readPublicationBytes(bucket,{sha256:f.sha256,size_bytes:textBytes.length,encoding:"text"},5),ArtifactPublicationStorageError);
  assert.equal(cancelled,true);
});
test("late GET bodies are cancelled after the deadline", async () => {
  let finish!: (v:unknown)=>void, cancelled=false;
  const f=await stored();
  const bucket={get(){return new Promise(resolve=>{finish=resolve;});}} as unknown as R2Bucket;
  await assert.rejects(readPublicationBytes(bucket,{sha256:f.sha256,size_bytes:textBytes.length,encoding:"text"},5),ArtifactPublicationStorageError);
  finish({size:textBytes.length,body:new ReadableStream({cancel(){cancelled=true;}})});
  await new Promise(resolve=>setTimeout(resolve,1)); assert.equal(cancelled,true);
});
test("an ambiguous late PUT stays recoverable rather than overwriting bytes", async () => {
  const f=await stored(); const original=f.publicStore.port.put;
  let finish!:()=>void;
  f.publicStore.port.put=async (...args)=>{const result=await original(...args);await new Promise<void>(r=>{finish=r;});return result;};
  await assert.rejects(putPublicArtifact(f.publicStore.bucket,f.content,5),ArtifactPublicationStorageError);
  finish(); f.publicStore.port.put=original;
  await putPublicArtifact(f.publicStore.bucket,f.content);
  assert.equal(f.publicStore.writes(),1);
});
