import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryNonceStore } from "../../src/auth/nonce";
import {
  base64UrlToBytes,
  computeContentDigest,
  ed25519KeyFingerprint,
  enforceFellowCredentialProfile,
  verifyFellowPopRequest,
} from "../../src/auth/pop";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const VECTORS_PATH = resolve(REPO_ROOT, "cli/tests/pop_vectors.json");

interface PopVector {
  readonly name: string;
  readonly method: string;
  readonly target_uri: string;
  readonly authorization: string;
  readonly body: string | null;
  readonly created: number;
  readonly expires: number;
  readonly nonce: string;
  readonly content_digest: string | null;
  readonly signature_input: string;
  readonly signature_base: string;
  readonly signature: string;
}

interface PopVectorsFile {
  readonly public_key_b64url: string;
  readonly key_id: string;
  readonly vectors: readonly PopVector[];
}

const VECTORS = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as PopVectorsFile;
const PUBLIC_KEY_BYTES = base64UrlToBytes(VECTORS.public_key_b64url);
if (!PUBLIC_KEY_BYTES) {
  throw new Error("pop_vectors.json public_key_b64url failed to decode");
}

const utf8 = new TextEncoder();

describe("RFC 9421 Ed25519 PoP verification & Rust<->TS interop (asimposiumorg-rc-cli-pop-encrypted-store-gates-sn5p)", () => {
  test("POSITIVE 1: published Rust/WebCrypto test vectors verify byte-identically", async () => {
    expect(await ed25519KeyFingerprint(PUBLIC_KEY_BYTES)).toBe(VECTORS.key_id);

    const nonces = new MemoryNonceStore();
    for (const vec of VECTORS.vectors) {
      const bodyBytes = vec.body === null ? new Uint8Array(0) : utf8.encode(vec.body);
      if (vec.content_digest !== null) {
        expect(await computeContentDigest(bodyBytes)).toBe(vec.content_digest);
      }

      const result = await verifyFellowPopRequest({
        method: vec.method,
        targetUri: vec.target_uri,
        authorization: vec.authorization,
        signatureInput: vec.signature_input,
        signature: vec.signature,
        contentDigest: vec.content_digest,
        bodyBytes,
        expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
        nowSeconds: vec.created + 10,
        nonces,
      });
      expect(result, `vector ${vec.name} should verify`).toEqual({
        ok: true,
        keyId: VECTORS.key_id,
        nonce: vec.nonce,
        created: vec.created,
        expires: vec.expires,
      });
    }
  });

  test("SHOULD-FAIL CONTROL 1: tampered HTTP method, path, body, or reused nonce returns 401 UNAUTHORIZED", async () => {
    const postVec = VECTORS.vectors.find((v) => v.name === "post-session-open-json-body");
    expect(postVec).toBeDefined();
    const vec = postVec as PopVector;
    const bodyBytes = utf8.encode(vec.body ?? "");

    // 1a. Tampered HTTP method (POST -> PUT) -> bad_signature
    const noncesMethod = new MemoryNonceStore();
    const methodTamper = await verifyFellowPopRequest({
      method: "PUT",
      targetUri: vec.target_uri,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes,
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.created + 10,
      nonces: noncesMethod,
    });
    expect(methodTamper).toEqual({ ok: false, code: "UNAUTHORIZED", reason: "bad_signature" });

    // 1b. Tampered HTTP path (/v1/sessions -> /v1/sessions/evil) -> bad_signature
    const pathTamper = await verifyFellowPopRequest({
      method: vec.method,
      targetUri: `${vec.target_uri}/evil`,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes,
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.created + 10,
      nonces: noncesMethod,
    });
    expect(pathTamper).toEqual({ ok: false, code: "UNAUTHORIZED", reason: "bad_signature" });

    // 1c. Tampered body bytes -> content_digest_mismatch
    const bodyTamper = await verifyFellowPopRequest({
      method: vec.method,
      targetUri: vec.target_uri,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes: utf8.encode('{"problem_id":"P-TAMPER","intent":"explore"}'),
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.created + 10,
      nonces: noncesMethod,
    });
    expect(bodyTamper).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      reason: "content_digest_mismatch",
    });

    // 1d. Reused nonce replay -> first succeeds, second fails with replayed (and failed tamper attempts above did NOT burn the nonce!)
    const first = await verifyFellowPopRequest({
      method: vec.method,
      targetUri: vec.target_uri,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes,
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.created + 10,
      nonces: noncesMethod,
    });
    expect(first.ok).toBe(true);

    const replay = await verifyFellowPopRequest({
      method: vec.method,
      targetUri: vec.target_uri,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes,
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.created + 11,
      nonces: noncesMethod,
    });
    expect(replay).toEqual({ ok: false, code: "UNAUTHORIZED", reason: "replayed" });

    // 1e. Expired signature -> expired
    const expired = await verifyFellowPopRequest({
      method: vec.method,
      targetUri: vec.target_uri,
      authorization: vec.authorization,
      signatureInput: vec.signature_input,
      signature: vec.signature,
      contentDigest: vec.content_digest,
      bodyBytes,
      expectedPublicKeyBytes: PUBLIC_KEY_BYTES,
      nowSeconds: vec.expires + 120,
      nonces: new MemoryNonceStore(),
    });
    expect(expired).toEqual({ ok: false, code: "UNAUTHORIZED", reason: "expired" });
  });

  test("credential_profile enforcement keeps plain bearer curl tokens first-class while enforcing PoP on http-message-signature tokens", async () => {
    const getVec = VECTORS.vectors[0] as PopVector;
    const nonces = new MemoryNonceStore();

    // Plain curl bearer token succeeds with zero PoP headers.
    const bearerResult = await enforceFellowCredentialProfile({
      credentialProfile: "bearer",
      request: {
        method: "GET",
        targetUri: getVec.target_uri,
        authorization: getVec.authorization,
        signatureInput: null,
        signature: null,
        contentDigest: null,
        bodyBytes: new Uint8Array(0),
      },
      nowSeconds: getVec.created + 5,
      nonces,
    });
    expect(bearerResult).toEqual({ ok: true, profile: "bearer" });

    // http-message-signature token without PoP headers fails closed 401.
    const missingPop = await enforceFellowCredentialProfile({
      credentialProfile: "http-message-signature",
      popPublicKeyBytes: PUBLIC_KEY_BYTES,
      request: {
        method: "GET",
        targetUri: getVec.target_uri,
        authorization: getVec.authorization,
        signatureInput: null,
        signature: null,
        contentDigest: null,
        bodyBytes: new Uint8Array(0),
      },
      nowSeconds: getVec.created + 5,
      nonces,
    });
    expect(missingPop).toEqual({ ok: false, code: "UNAUTHORIZED", reason: "missing_headers" });

    // http-message-signature token WITH valid RFC 9421 PoP headers passes cleanly.
    const validPop = await enforceFellowCredentialProfile({
      credentialProfile: "http-message-signature",
      popPublicKeyBytes: PUBLIC_KEY_BYTES,
      request: {
        method: getVec.method,
        targetUri: getVec.target_uri,
        authorization: getVec.authorization,
        signatureInput: getVec.signature_input,
        signature: getVec.signature,
        contentDigest: getVec.content_digest,
        bodyBytes: new Uint8Array(0),
      },
      nowSeconds: getVec.created + 5,
      nonces,
    });
    expect(validPop).toEqual({ ok: true, profile: "http-message-signature" });
  });
});
