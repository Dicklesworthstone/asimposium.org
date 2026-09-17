/** AWS Signature V4 query signing for one private R2 upload key. The only
 * operation is PUT, never a client-selected method, host, bucket or path.
 * https://developers.cloudflare.com/r2/api/s3/presigned-urls/
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */
export const ARTIFACT_PUT_TTL_SECONDS = 15 * 60;
export interface ArtifactSigningConfig {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sponsorDailyBytes: number;
  readonly fellowDailyManifests: number;
}
export interface ArtifactPutGrant {
  readonly method: "PUT";
  readonly url: string;
  readonly expires_at: number;
  readonly headers: {
    readonly "content-type": "application/octet-stream";
    readonly "content-length": string;
    readonly "if-none-match": "*";
  };
}

export function artifactSigningConfig(value: string | undefined): ArtifactSigningConfig | undefined {
  if (value === undefined || value.length > 4096) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const c = parsed as Record<string, unknown>;
  const fields = ["accountId", "bucket", "accessKeyId", "secretAccessKey", "sponsorDailyBytes", "fellowDailyManifests"];
  if (Object.keys(c).length !== fields.length || fields.some(key => !(key in c)) ||
    typeof c.accountId !== "string" || !/^[a-f0-9]{32}$/.test(c.accountId) ||
    typeof c.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket) ||
    typeof c.accessKeyId !== "string" || !/^[A-Za-z0-9]{16,128}$/.test(c.accessKeyId) ||
    typeof c.secretAccessKey !== "string" || !/^[a-f0-9]{64}$/.test(c.secretAccessKey) ||
    typeof c.sponsorDailyBytes !== "number" || !Number.isSafeInteger(c.sponsorDailyBytes) ||
    c.sponsorDailyBytes < 1 || c.sponsorDailyBytes > 10 * 1024 ** 3 ||
    typeof c.fellowDailyManifests !== "number" || !Number.isSafeInteger(c.fellowDailyManifests) ||
    c.fellowDailyManifests < 1 || c.fellowDailyManifests > 1000) return undefined;
  return c as unknown as ArtifactSigningConfig;
}

export function artifactStagingKey(id: string): string {
  if (!/^AU-[0-9a-f]{32}$/.test(id)) throw new Error("ARTIFACT_UPLOAD_ID_INVALID");
  return `incoming/artifacts/${id}`;
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes),
  byte => byte.toString(16).padStart(2, "0")).join("");
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const utf8 = new TextEncoder();
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, utf8.encode(value)));
}

export async function presignArtifactPut(
  config: ArtifactSigningConfig,
  uploadId: string,
  size: number,
  createdAt: number,
): Promise<ArtifactPutGrant> {
  if (artifactSigningConfig(JSON.stringify(config)) === undefined ||
    !Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024 ||
    !Number.isSafeInteger(createdAt) || createdAt < 1 || createdAt > 8_640_000_000_000_000) {
    throw new Error("ARTIFACT_SIGNING_INPUT_INVALID");
  }
  const instant = Math.floor(createdAt / 1000) * 1000;
  const timestamp = new Date(instant).toISOString().replace(/[:-]|\.000/g, "");
  const day = timestamp.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucket}/${artifactStagingKey(uploadId)}`;
  const signedHeaders = "content-length;content-type;host;if-none-match";
  const parameters: readonly [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(ARTIFACT_PUT_TTL_SECONDS)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const query = parameters.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const canonicalHeaders = `content-length:${size}\ncontent-type:application/octet-stream\nhost:${host}\nif-none-match:*\n`;
  const canonicalRequest = `PUT\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const requestDigest = hex(await crypto.subtle.digest("SHA-256", utf8.encode(canonicalRequest)));
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${requestDigest}`;
  const dateKey = await hmac(utf8.encode(`AWS4${config.secretAccessKey}`), day);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex((await hmac(signingKey, toSign)).buffer as ArrayBuffer);
  return {
    method: "PUT", url: `https://${host}${path}?${query}&X-Amz-Signature=${signature}`,
    expires_at: instant + ARTIFACT_PUT_TTL_SECONDS * 1000,
    headers: { "content-type": "application/octet-stream", "content-length": String(size), "if-none-match": "*" },
  };
}
