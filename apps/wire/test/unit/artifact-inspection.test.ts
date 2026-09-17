import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "bun:test";
import {
  artifactSha256, inspectArtifact, ArtifactInspectionError,
} from "../../src/krater/artifact-inspection.ts";

const utf8 = (value: string) => new TextEncoder().encode(value);
const inspect = async (bytes: Uint8Array, encoding: "text" | "lake-archive" = "text") =>
  inspectArtifact(bytes, encoding, await artifactSha256(bytes));
async function refuses(bytes: Uint8Array, code: string, archive = false) {
  await assert.rejects(inspect(bytes, archive ? "lake-archive" : "text"), error =>
    error instanceof ArtifactInspectionError && error.code === code && error.message === code);
}

function tar(entries: { name: string; body?: string; kind?: string }[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const head = Buffer.alloc(512);
    head.write(entry.name, 0, 100, "utf8");
    head.write("0000644\0", 100);
    head.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    head.fill(32, 148, 156);
    head.write(entry.kind ?? "0", 156);
    head.write("ustar\0", 257); head.write("00", 263);
    const checksum = head.reduce((sum, byte) => sum + byte, 0);
    head.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(head, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
const archive = (entries: Parameters<typeof tar>[0]) => gzipSync(tar(entries), { level: 1 });

test("text verification computes byte identity, never scientific certification", async () => {
  const bytes = utf8("theorem sample : 1 + 1 = 2 := by decide\n");
  const result = await inspect(bytes);
  assert.equal(result.sha256, await artifactSha256(bytes));
  assert.equal(result.size, bytes.length);
  assert.equal(result.contentType, "text/plain; charset=utf-8");
  assert.equal(result.disposition, "attachment");
  assert.deepEqual(Object.keys(result).sort(), ["contentType", "disposition", "expandedBytes", "members", "sha256", "size"]);
});

test("JSON, UTF-8 math, source and logs stay inert text", async () => {
  for (const value of ["{\"a\":1}", "∀ n ∈ ℕ, n ≤ n\n", "console.log(1)", "warning: unable to prove\n"]) {
    assert.equal((await inspect(utf8(value))).contentType, "text/plain; charset=utf-8");
  }
});

test("a declared digest cannot label different bytes", async () => {
  await assert.rejects(inspectArtifact(utf8("wrong"), "text", "a".repeat(64)),
    /ARTIFACT_DIGEST_MISMATCH/);
});

test("zero-length and oversized source objects are refused", async () => {
  await refuses(new Uint8Array(), "ARTIFACT_TOO_LARGE");
  await refuses(new Uint8Array(5 * 1024 * 1024 + 1), "ARTIFACT_TOO_LARGE");
});

test("executable markup and binary pretending to be text are refused", async () => {
  for (const value of ["<!DOCTYPE html><script>x</script>", " <svg><script>x</script></svg>", "<?xml version='1.0'?>", "abc\0def"]) {
    await refuses(utf8(value), "ARTIFACT_TYPE_FORBIDDEN");
  }
  await refuses(new Uint8Array([0xff, 0xfe, 0x00]), "ARTIFACT_TYPE_FORBIDDEN");
});

test("policy refusal contains neither secret nor uploaded prose", async () => {
  for (const value of ["sk_live_" + "x".repeat(25), "-----BEGIN PRIVATE KEY-----", "researcher@example.com"]) {
    await refuses(utf8(value), "ARTIFACT_SECRET_SHAPED");
  }
});

test("portable USTAR lake source is inspected member-by-member without execution", async () => {
  const result = await inspect(archive([
    { name: "Project/", kind: "5" },
    { name: "Project/Main.lean", body: "theorem sample : True := by trivial\n" },
    { name: "Project/lakefile.toml", body: "name = \"sample\"\n" },
  ]), "lake-archive");
  assert.equal(result.members, 3); assert.equal(result.contentType, "application/gzip");
});

for (const name of ["../escape", "/root", "C:escape", "a\\b", "a/../b", "a//b", "a/./b", "NUL.txt", "a. "]) {
  test(`unsafe archive path is refused: ${JSON.stringify(name)}`, async () => {
    await refuses(archive([{ name, body: "safe" }]), "ARTIFACT_ARCHIVE_INVALID", true);
  });
}

test("links, devices and extended metadata cannot bypass source inspection", async () => {
  for (const kind of ["1", "2", "3", "4", "6", "x", "g", "L", "K", "S"]) {
    await refuses(archive([{ name: "safe", body: "hello", kind }]), "ARTIFACT_ARCHIVE_INVALID", true);
  }
});

test("overwriting and case-equivalent archive names are refused", async () => {
  for (const names of [["x", "x"], ["X", "x"], ["a", "a/b"], ["a/b", "a"]]) {
    await refuses(archive(names.map(name => ({ name, body: "ok" }))), "ARTIFACT_ARCHIVE_INVALID", true);
  }
});

test("secrets cannot hide in a compressed member", async () => {
  await refuses(archive([{ name: "Main.lean", body: "sk_live_" + "x".repeat(25) }]), "ARTIFACT_SECRET_SHAPED", true);
});

test("corrupt gzip, tar checksums and truncation are refused", async () => {
  const damaged = archive([{ name: "x", body: "hello" }]);
  damaged[damaged.length - 8] ^= 1;
  await refuses(damaged, "ARTIFACT_ARCHIVE_INVALID", true);
  const bad = tar([{ name: "x", body: "hello" }]); bad[0] ^= 1;
  await refuses(gzipSync(bad), "ARTIFACT_ARCHIVE_INVALID", true);
  await refuses(gzipSync(tar([{ name: "x", body: "hi" }]).subarray(0, 1024)), "ARTIFACT_ARCHIVE_INVALID", true);
});

test("hidden trailing archive members and non-zero padding are refused", async () => {
  await refuses(gzipSync(Buffer.concat([tar([{ name: "x", body: "ok" }]), utf8("hidden")])), "ARTIFACT_ARCHIVE_INVALID", true);
  const bad = tar([{ name: "x", body: "ok" }]); bad[515] = 1;
  await refuses(gzipSync(bad), "ARTIFACT_ARCHIVE_INVALID", true);
});

test("expansion bombs stop before complete materialization", async () => {
  await refuses(gzipSync(Buffer.alloc(8 * 1024 * 1024)), "ARTIFACT_ARCHIVE_INVALID", true);
});
