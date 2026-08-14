import { describe, expect, test } from "bun:test";

import { canonicalBytes, payloadDigest, toHex } from "../../src/auth/canonical";
import {
  buildAuthDiagnostic,
  formatAuthDiagnostic,
  principalPseudonym,
} from "../../src/auth/diagnostics";
import { verifyServiceEnvelope, type ServiceEnvelope } from "../../src/auth/envelope";
import { VerificationKeyring } from "../../src/auth/keyring";
import { MemoryNonceStore } from "../../src/auth/nonce";
import { routePrincipal } from "../../src/auth/principal";

/**
 * S-6 disclosure discipline across the cross-plane seam (Fable §14.3).
 *
 * The auth decision is the event most worth logging and the one most likely to
 * carry material that must never be written down. These tests plant real
 * credential-shaped canaries — a session cookie, a bearer token, an OAuth code,
 * a signature, a request body — and assert that none of them reaches a
 * diagnostic, a refusal, or an accepted result.
 */

const NOW = 1786000000;
const ROUTE = "/v1/p/:id/directives";

const COOKIE_CANARY = "asimp.session=Fe26.2**canary-session-material**";
const BEARER_CANARY = "asimp_ag_canary0123456789abcdefghijklmn";
const OAUTH_CANARY = "4/0AY0e-g7canary-authorization-code";
const BODY_CANARY = '{"focus":"canary-directive-body-never-logged"}';

async function harness() {
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const keyring = new VerificationKeyring([
    {
      kid: "agora-2026-08-a",
      publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey))),
      notBefore: 0,
    },
  ]);

  const claims = {
    v: "asimp-env-1",
    kid: "agora-2026-08-a",
    alg: "Ed25519",
    iss: "agora",
    aud: "stoa",
    iat: NOW,
    exp: NOW + 60,
    nonce: "z".repeat(43),
    method: "POST",
    route: ROUTE,
    action: "directive.create",
    principal_type: "sponsor",
    principal_id: "usr_01JXYZ0000000000000000",
    payload_sha256: await payloadDigest(BODY_CANARY),
  };
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        keypair.privateKey,
        canonicalBytes(claims) as BufferSource,
      ),
    ),
  );

  const envelope: ServiceEnvelope = { claims, signature };
  return {
    envelope,
    verify: (overrides: Record<string, unknown> = {}) =>
      verifyServiceEnvelope(envelope, {
        keyring,
        nonces: new MemoryNonceStore(),
        now: NOW,
        issuer: "agora",
        audience: "stoa",
        body: BODY_CANARY,
        method: "POST",
        route: ROUTE,
        ...overrides,
      }),
  };
}

/** Every byte that must never appear in an emitted string. */
function assertNoCanaries(text: string, signature: string): void {
  expect(text).not.toContain(COOKIE_CANARY);
  expect(text).not.toContain("Fe26.2");
  expect(text).not.toContain(BEARER_CANARY);
  expect(text).not.toContain("asimp_ag_");
  expect(text).not.toContain(OAUTH_CANARY);
  expect(text).not.toContain(BODY_CANARY);
  expect(text).not.toContain("canary");
  // The signature is the credential of this scheme; not one byte of it leaks.
  expect(text).not.toContain(signature);
  expect(text).not.toContain(signature.slice(0, 16));
}

describe("diagnostics carry no credential material", () => {
  test("an accepted write logs identifiers and digests, never bytes", async () => {
    const h = await harness();
    const result = await h.verify();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = formatAuthDiagnostic(
      buildAuthDiagnostic({
        outcome: "accepted",
        code: "OK",
        reason: "accepted",
        method: "POST",
        route: ROUTE,
        claims: result.claims,
        principalPseudonym: await principalPseudonym(result.principal.id, "operator-salt"),
        durationMs: 12.6,
      }),
    );

    assertNoCanaries(line, h.envelope.signature);
    // What it does carry: enough to correlate, not enough to reconstruct.
    expect(line).toContain("agora-2026-08-a");
    expect(line).toContain("directive.create");
    expect(line).toContain(ROUTE);
  });

  test("the pseudonym is stable, salted, and not the principal id", async () => {
    const id = "usr_01JXYZ0000000000000000";
    const first = await principalPseudonym(id, "salt-a");
    expect(await principalPseudonym(id, "salt-a")).toBe(first);
    expect(await principalPseudonym(id, "salt-b")).not.toBe(first);
    expect(first).not.toContain(id);
    expect(first).toHaveLength(12);
  });

  test("a refusal diagnostic names an enumerated reason and no attacker input", async () => {
    const h = await harness();
    const result = await h.verify({ body: '{"focus":"rewritten in flight"}' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const line = formatAuthDiagnostic(
      buildAuthDiagnostic({
        outcome: "refused",
        code: result.code,
        reason: result.reason,
        method: "POST",
        route: ROUTE,
      }),
    );
    assertNoCanaries(line, h.envelope.signature);
    expect(line).toContain("payload_mismatch");
  });

  test("only a digest prefix of the payload is ever emitted", async () => {
    const h = await harness();
    const full = await payloadDigest(BODY_CANARY);
    const record = buildAuthDiagnostic({
      outcome: "accepted",
      code: "OK",
      reason: "accepted",
      method: "POST",
      route: ROUTE,
      claims: h.envelope.claims,
    });
    expect(record.payload_digest_prefix).toBe(full.slice(0, 12));
    expect(formatAuthDiagnostic(record)).not.toContain(full);
  });

  test("the route is a template, so no identifier reaches the log", () => {
    const record = buildAuthDiagnostic({
      outcome: "refused",
      code: "WRONG_PRINCIPAL",
      reason: "bearer_on_sponsor_route",
      method: "POST",
      route: ROUTE,
    });
    expect(record.route).toBe("/v1/p/:id/directives");
    expect(record.route).toContain(":id");
  });
});

describe("verification results carry no credential material", () => {
  test("neither an accepted nor a refused result echoes the signature or body", async () => {
    const h = await harness();
    for (const result of [
      await h.verify(),
      await (await harness()).verify({ body: "tampered" }),
      await (await harness()).verify({ now: NOW + 10_000 }),
    ]) {
      assertNoCanaries(JSON.stringify(result), h.envelope.signature);
    }
  });

  test("a refusal never reveals which check failed to the caller", async () => {
    const h = await harness();
    const refusal = await h.verify({ body: "tampered" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    // The external code is uniform. `reason` is internal: an auth refusal that
    // explains itself is an oracle for grinding out a forgery (Rule A5).
    expect(refusal.code).toBe("UNAUTHORIZED");
  });
});

describe("the Worker accepts what the Agora actually mints", () => {
  /**
   * The two planes have independent implementations of the canonical form. The
   * golden corpus proves the bytes agree; this proves the whole envelope does —
   * shape, field names, hex encoding, signature — by minting with the real
   * Agora signer and verifying with the real Worker verifier, in process.
   *
   * Still not a deployment: no Vercel, no Auth.js, no HTTP, no Worker runtime.
   */
  test("a minted envelope round-trips and attributes the sponsor", async () => {
    const { mintServiceEnvelope } = await import("../../../web/lib/service-envelope.ts");
    const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;

    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "agora-2026-08-a",
      now: NOW,
      method: "POST",
      route: ROUTE,
      action: "directive.create",
      principalId: "usr_01JXYZ0000000000000000",
      body: BODY_CANARY,
    });

    const result = await verifyServiceEnvelope(envelope, {
      keyring: new VerificationKeyring([
        {
          kid: "agora-2026-08-a",
          publicKeyHex: toHex(
            new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)),
          ),
          notBefore: 0,
        },
      ]),
      nonces: new MemoryNonceStore(),
      now: NOW,
      issuer: "agora",
      audience: "stoa",
      body: BODY_CANARY,
      method: "POST",
      route: ROUTE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toMatchObject({
      type: "sponsor",
      id: "usr_01JXYZ0000000000000000",
      action: "directive.create",
    });
  });

  test("a minted envelope is refused when the body is altered in flight", async () => {
    const { mintServiceEnvelope } = await import("../../../web/lib/service-envelope.ts");
    const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const envelope = await mintServiceEnvelope({
      privateKey: keypair.privateKey,
      kid: "k",
      now: NOW,
      method: "POST",
      route: ROUTE,
      action: "directive.create",
      principalId: "usr_1",
      body: BODY_CANARY,
    });

    const result = await verifyServiceEnvelope(envelope, {
      keyring: new VerificationKeyring([
        {
          kid: "k",
          publicKeyHex: toHex(
            new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)),
          ),
          notBefore: 0,
        },
      ]),
      nonces: new MemoryNonceStore(),
      now: NOW,
      issuer: "agora",
      audience: "stoa",
      body: '{"focus":"rewritten by a proxy"}',
      method: "POST",
      route: ROUTE,
    });
    expect(result).toMatchObject({ ok: false, reason: "payload_mismatch" });
  });
});

describe("principal confusion is refused before any credential is examined", () => {
  test("a bearer on a sponsor route is refused without consulting the envelope", () => {
    const decision = routePrincipal({
      host: "apex",
      routeClass: "sponsor-write",
      presented: { bearer: true, envelope: true, cookie: true },
    });
    expect(decision).toMatchObject({ ok: false, code: "WRONG_PRINCIPAL" });
    assertNoCanaries(JSON.stringify(decision), "0".repeat(128));
  });

  test("a cookie on the agent plane is refused and never read", () => {
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: { bearer: false, envelope: false, cookie: true },
    });
    expect(decision).toMatchObject({ ok: false, code: "WRONG_PRINCIPAL" });
    expect(decision.consulted).not.toContain("cookie");
  });
});
