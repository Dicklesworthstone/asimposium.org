import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "bun:test";
import { artifactSigningConfig, artifactStagingKey, presignArtifactPut } from "../../src/krater/artifact-presign.ts";

const config = { accountId: "a".repeat(32), bucket: "asimp-private", accessKeyId: "b".repeat(32),
  secretAccessKey: "c".repeat(64), sponsorDailyBytes: 1024 ** 3, fellowDailyManifests: 100 };
const id = `AU-${"d".repeat(32)}`;
const now = Date.parse("2026-09-17T12:00:00.789Z");

// Independent Node crypto implementation reconstructs the request from the
// returned URL and required headers, not the signer's intermediate strings.
function verify(url: string, headers: Record<string, string>, method = "PUT"): string {
  const u = new URL(url);
  const signature = u.searchParams.get("X-Amz-Signature");
  u.searchParams.delete("X-Amz-Signature");
  const names = (u.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
  const canonical = names.map(name => `${name}:${name === "host" ? u.host : headers[name]}\n`).join("");
  const digest = createHash("sha256").update(`${method}\n${u.pathname}\n${u.search.slice(1)}\n${canonical}\n${names.join(";")}\nUNSIGNED-PAYLOAD`).digest("hex");
  const date = u.searchParams.get("X-Amz-Date") ?? "";
  let key: Buffer = Buffer.from(`AWS4${config.secretAccessKey}`);
  for (const step of [date.slice(0, 8), "auto", "s3", "aws4_request"]) key = createHmac("sha256", key).update(step).digest();
  const expected = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${date.slice(0, 8)}/auto/s3/aws4_request\n${digest}`).digest("hex");
  return signature === expected ? "valid" : "invalid";
}

test("issues a fifteen-minute PUT with exact size and create-only conditions signed", async () => {
  const grant = await presignArtifactPut(config, id, 1234, now);
  assert.equal(grant.expires_at, Math.floor(now / 1000) * 1000 + 900000);
  assert.equal(grant.method, "PUT");
  assert.equal(verify(grant.url, grant.headers), "valid");
  assert.equal(new URL(grant.url).pathname, `/asimp-private/incoming/artifacts/${id}`);
  assert.equal(grant.headers["if-none-match"], "*");
  assert.equal(grant.url.includes(config.secretAccessKey), false);
});

test("same manifest recreates identical signing bytes rather than extending expiry", async () => {
  assert.deepEqual(await presignArtifactPut(config, id, 5, now), await presignArtifactPut(config, id, 5, now));
});

test("changing bytes allowed, content type, method, key or expiry invalidates the signature", async () => {
  const grant = await presignArtifactPut(config, id, 1234, now);
  assert.equal(verify(grant.url, { ...grant.headers, "content-length": "9999999999" }), "invalid");
  assert.equal(verify(grant.url, { ...grant.headers, "content-type": "text/html" }), "invalid");
  assert.equal(verify(grant.url, { ...grant.headers, "if-none-match": "" }), "invalid");
  assert.equal(verify(grant.url, grant.headers, "GET"), "invalid");
  assert.equal(verify(grant.url.replace(id, `AU-${"e".repeat(32)}`), grant.headers), "invalid");
  assert.equal(verify(grant.url.replace("X-Amz-Expires=900", "X-Amz-Expires=9000"), grant.headers), "invalid");
});

test("signing configuration cannot select an external host or unbounded budget", () => {
  assert.deepEqual(artifactSigningConfig(JSON.stringify(config)), config);
  for (const extra of [{ accountId: "evil.test/path" }, { bucket: "../public" },
    { sponsorDailyBytes: Infinity }, { fellowDailyManifests: 0 }, { extra: "unknown" },
    { secretAccessKey: "bad" }]) assert.equal(artifactSigningConfig(JSON.stringify({ ...config, ...extra })), undefined);
  assert.equal(artifactSigningConfig(undefined), undefined);
});

test("a digest or user filename cannot become a writable CAS key", async () => {
  for (const value of ["a".repeat(64), "../cas/sha256/abc", `${id}/x`, id.toUpperCase()]) {
    assert.throws(() => artifactStagingKey(value));
    await assert.rejects(presignArtifactPut(config, value, 10, now));
  }
});
