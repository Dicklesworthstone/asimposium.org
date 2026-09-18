import type { R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import {
  type ArtifactEncoding,
  artifactSha256,
  inspectArtifactForPublication,
  type PublicationInspection,
} from "./artifact-inspection.ts";

export const PUBLIC_ARTIFACT_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PUBLIC_ARTIFACT_STORAGE_TIMEOUT_MS = 15_000;
export class ArtifactPublicationStorageError extends Error {
  constructor() {
    super("ARTIFACT_PUBLICATION_STORAGE_UNAVAILABLE");
  }
}
export interface PublicationBytes extends PublicationInspection {
  readonly bytes: Uint8Array;
}
const unavailable = (): never => {
  throw new ArtifactPublicationStorageError();
};
const validDigest = (value: string): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Direct-R2 keys differ from the private CAS prefix. No request selects a key. */
export function publicArtifactKey(sha256: string): string {
  if (!validDigest(sha256)) return unavailable();
  return `sha256/${sha256}`;
}
export function artifactPublicationOrigin(stoaOrigin: string | undefined): string | undefined {
  if (stoaOrigin === "https://a.asimposium.org") return "https://artifacts.asimposium.org";
  if (stoaOrigin === "https://a-staging.asimposium.org")
    return "https://artifacts-staging.asimposium.org";
  // Loopback must not mint a production URL for local, unpublished bytes.
  return undefined;
}

type StreamReader = {
  read(): Promise<{ done: boolean; value?: any }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

async function readExact(
  bucket: R2Bucket,
  key: string,
  size: number,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; object: R2ObjectBody }> {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 20 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PUBLIC_ARTIFACT_STORAGE_TIMEOUT_MS
  )
    return unavailable();
  let reader: StreamReader | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      try {
        void reader?.cancel().catch(() => undefined);
      } catch {
        /* best effort */
      }
      reject(new ArtifactPublicationStorageError());
    }, timeoutMs);
  });
  try {
    const pending = bucket.get(key);
    void pending
      .then(
        (object) => {
          if (expired) void object?.body.cancel().catch(() => undefined);
        },
        () => undefined,
      )
      .catch(() => undefined);
    const object = await Promise.race([pending, deadline]);
    if (!object) return unavailable();
    if (object.size !== size) {
      void object.body.cancel().catch(() => undefined);
      return unavailable();
    }
    const activeReader = object.body.getReader();
    reader = activeReader;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (;;) {
      const next = await Promise.race([activeReader.read(), deadline]);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.length > size - offset)
        return unavailable();
      bytes.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== size) return unavailable();
    return { bytes, object };
  } catch {
    try {
      void reader?.cancel().catch(() => undefined);
    } catch {
      /* best effort */
    }
    return unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      reader?.releaseLock();
    } catch {
      /* do not replace a typed storage result */
    }
  }
}

/** Internal outbox read. The caller must resolve a durable publication binding
 * first; this helper intentionally knows no bearer, owner or HTTP request. */
export async function readPublicationBytes(
  bucket: R2Bucket,
  input: {
    readonly sha256: string;
    readonly size_bytes: number;
    readonly encoding: ArtifactEncoding;
  },
  timeoutMs = PUBLIC_ARTIFACT_STORAGE_TIMEOUT_MS,
): Promise<PublicationBytes> {
  if (!validDigest(input.sha256)) return unavailable();
  const { bytes } = await readExact(
    bucket,
    `cas/sha256/${input.sha256}`,
    input.size_bytes,
    timeoutMs,
  );
  return { bytes, ...(await inspectArtifactForPublication(bytes, input.encoding, input.sha256)) };
}

/** Call ONLY after the release-authorized state commits. A timed-out R2 PUT
 * may still complete; once dispatched it is not honest to promise privacy or
 * undo publication by marking a job held. Retries are create-only and verify
 * both the exact existing bytes and their safe delivery metadata. */
export async function putPublicArtifact(
  bucket: R2Bucket,
  content: PublicationBytes,
  timeoutMs = PUBLIC_ARTIFACT_STORAGE_TIMEOUT_MS,
): Promise<void> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PUBLIC_ARTIFACT_STORAGE_TIMEOUT_MS
  )
    return unavailable();
  const expected = content.artifact;
  if (!Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 20 * 1024 * 1024)
    return unavailable();
  const bytes = content.bytes.slice();
  const key = publicArtifactKey(expected.sha256);
  const contentType = expected.contentType;
  if (
    bytes.length !== expected.size ||
    (contentType !== "text/plain; charset=utf-8" && contentType !== "application/gzip") ||
    (await artifactSha256(bytes)) !== expected.sha256
  )
    return unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bucket.put(key, bytes, {
        sha256: expected.sha256,
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType,
          contentDisposition: "attachment",
          cacheControl: PUBLIC_ARTIFACT_CACHE_CONTROL,
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ArtifactPublicationStorageError()), timeoutMs);
      }),
    ]);
  } catch {
    return unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // This also settles a prior successful PUT whose acknowledgment was lost.
  const observed = await readExact(bucket, key, expected.size, timeoutMs);
  if (
    (await artifactSha256(observed.bytes)) !== expected.sha256 ||
    observed.object.httpMetadata?.contentType !== contentType ||
    observed.object.httpMetadata?.contentDisposition !== "attachment" ||
    observed.object.httpMetadata?.cacheControl !== PUBLIC_ARTIFACT_CACHE_CONTROL
  )
    return unavailable();
}
