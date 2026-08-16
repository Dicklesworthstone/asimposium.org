import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CANONICAL_FIELDS,
  type CanonicalField,
  canonicalBytes,
  canonicalDigest,
  ENVELOPE_VERSION,
  type ServiceEnvelopeClaims,
  toHex,
} from "../../src/auth/canonical";
import { VerificationKeyring } from "../../src/auth/keyring";

/**
 * The parts of the shared canonicalization corpus that `service-envelope.test.ts`
 * does not already prove.
 *
 * That sibling suite already pins every corpus vector to its digest against this
 * Worker's own `canonicalDigest` (`service-envelope.test.ts:190-216`), and
 * already drives the rotation refusals through `verifyServiceEnvelope`
 * (`:498-590`). Restating either here would be duplication that reads as new
 * coverage, so this file does not. What is genuinely left, and all this file
 * claims:
 *
 *  - the framing *law*, compared against an oracle rebuilt from the written
 *    specification in `canonical.ts` rather than from its code — which catches
 *    the one failure a pinned digest cannot, an edit that changes the encoder
 *    and regenerates the vectors to match it;
 *  - the signed field list and envelope version as an exact wire-format pin,
 *    which no other suite asserts;
 *  - the exact instants at the edges of a key validity window, where the
 *    sibling tests sit well inside theirs;
 *  - key *identity* returned by `keyring.lookup`, proven by signature rather
 *    than inferred from an end-to-end success.
 *
 * The corpus deliberately carries values ordinary round-trips never produce — a
 * `:` inside a value, a record separator, a newline, an astral character —
 * because a framing divergence reachable only through one of those surfaces at
 * runtime as `bad_signature`, which is indistinguishable from a genuine forgery
 * on the one route where that distinction matters most.
 */

interface CorpusVector {
  readonly note: string;
  readonly claims: ServiceEnvelopeClaims;
  readonly canonical_sha256: string;
}

interface Corpus {
  readonly vectors: Record<string, CorpusVector>;
}

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const CORPUS_PATH = resolve(REPOSITORY_ROOT, "apps/wire/src/auth/service-envelope-vectors.json");
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
const vectorEntries = Object.entries(corpus.vectors);

/** Read a named vector, failing loudly rather than skipping if the corpus is renamed. */
function vector(name: string): CorpusVector {
  const found = corpus.vectors[name];
  if (found === undefined) {
    throw new Error(`shared corpus is missing the required vector "${name}"`);
  }
  return found;
}

/**
 * The exact defective framing this suite exists to refuse: field *values*
 * joined by a single `:`, with no length prefix and no field names between
 * them. It is defined here, in the test, precisely because production must
 * never contain it — the plant below feeds it two different claim sets and
 * proves it collides, then proves the real encoder does not.
 */
function naiveValueJoin(claims: ServiceEnvelopeClaims): string {
  return CANONICAL_FIELDS.map((field: CanonicalField) => String(claims[field])).join(":");
}

/**
 * The canonical framing rebuilt from its written specification.
 *
 * `canonical.ts` documents each record as
 *
 *     <byteLen(name)> ":" <name> ":" <byteLen(value)> ":" <value> 0x1E
 *
 * after an `asimp-env-1\n` domain prefix, with lengths counted in UTF-8 bytes.
 * This is that prose transcribed, not the encoder copied: it accumulates one
 * string and encodes it once, where the implementation concatenates per-field
 * byte chunks. The version prefix is written as a literal for the same reason —
 * importing `ENVELOPE_VERSION` would let a changed signing domain agree with
 * itself.
 *
 * This is the check a pinned digest cannot make. `service-envelope.test.ts`
 * already asserts every vector against its recorded `canonical_sha256`, but an
 * edit that changed the framing *and* regenerated those digests would satisfy
 * it. Comparing against an independently written oracle would not survive that.
 */
function specFramedBytes(claims: ServiceEnvelopeClaims): Uint8Array {
  const utf8 = new TextEncoder();
  const byteLength = (text: string) => utf8.encode(text).length;
  // The record terminator, built by code point rather than written as a source
  // escape. A raw 0x1E pasted into source is invisible to rg and review, and a
  // backslash escape is easy to miscount when a tool renders it doubled — this
  // spelling is unambiguous at a glance and cannot drift into four literal
  // characters without failing loudly.
  const rs = String.fromCharCode(0x1e);
  let framed = "asimp-env-1\n";
  for (const field of CANONICAL_FIELDS) {
    const raw = claims[field];
    const value = typeof raw === "number" ? String(raw) : raw;
    framed += `${byteLength(field)}:${field}:${byteLength(value)}:${value}${rs}`;
  }
  return utf8.encode(framed);
}

describe("Worker canonicalization obeys the written framing rule", () => {
  test.each(vectorEntries)(
    "vector %s is framed exactly as the specification describes",
    (_name, entry) => {
      // Bytes, not digests: a hex mismatch names the diverging position, where a
      // digest mismatch only says "different".
      expect(toHex(canonicalBytes(entry.claims))).toBe(toHex(specFramedBytes(entry.claims)));
    },
  );

  test("the signed field list and version match the pinned wire format", () => {
    expect(ENVELOPE_VERSION).toBe("asimp-env-1");
    expect([...CANONICAL_FIELDS]).toEqual([
      "v",
      "kid",
      "alg",
      "iss",
      "aud",
      "iat",
      "exp",
      "nonce",
      "method",
      "route",
      "action",
      "principal_type",
      "principal_id",
      "payload_sha256",
    ]);
  });

  test("PLANTED: a one-character claim change moves the digest", async () => {
    const pinned = vector("minimal");
    const altered: ServiceEnvelopeClaims = {
      ...pinned.claims,
      principal_id: `${pinned.claims.principal_id}x`,
    };

    // The framing comparison above is over bytes; this is over the digest that
    // is actually signed, so the two layers stay separately falsifiable. The
    // pinned digest is the sibling suite's to assert — what is asserted here is
    // only that this claim no longer reaches it.
    expect(await canonicalDigest(altered)).not.toBe(pinned.canonical_sha256);
  });

  test("PLANTED: an adjacent-field boundary cannot be moved without moving the digest", async () => {
    // `principal_type` and `principal_id` are adjacent in CANONICAL_FIELDS, so
    // they are the pair a value-joined encoding confuses: moving one `:` across
    // the boundary produces the same joined string, and under that encoding an
    // attacker who controls either value forges the other.
    //
    // These values deliberately violate the envelope's own `principal_type`
    // pattern (`envelope.ts` bounds it to /^[a-z_]+$/). That is intentional:
    // canonicalization is a pure byte function and must be collision-free
    // independently of the validation that later rejects such an envelope.
    const base = vector("minimal").claims;
    const left: ServiceEnvelopeClaims = {
      ...base,
      principal_type: "sponsor:1",
      principal_id: "b",
    };
    const right: ServiceEnvelopeClaims = {
      ...base,
      principal_type: "sponsor",
      principal_id: "1:b",
    };

    // The collision is real: the defective encoder cannot tell these apart.
    // Without this the assertions below would only show two claim sets that
    // happen to differ, which every pair of distinct claims does.
    expect(naiveValueJoin(left)).toBe(naiveValueJoin(right));

    // Length-prefixed framing keeps them distinct, at the bytes and the digest.
    const leftBytes = canonicalBytes(left);
    const rightBytes = canonicalBytes(right);
    expect(toHex(leftBytes)).not.toBe(toHex(rightBytes));
    expect(await canonicalDigest(left)).not.toBe(await canonicalDigest(right));
  });
});

const KEY_A = "agora-window-a";
const KEY_B = "agora-window-b";
const ROTATION_INSTANT = 1_786_000_000;

interface RotationKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKeyHex: string;
}

/** Generate a keypair and RETAIN its private half, so lookups can be proven by signature. */
async function rotationKey(kid: string): Promise<RotationKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return {
    kid,
    privateKey: pair.privateKey,
    publicKeyHex: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
}

/** The exact bytes an envelope signature covers, for the given signing kid. */
function signedBytes(kid: string): ArrayBuffer {
  return canonicalBytes({ ...vector("minimal").claims, kid }).slice().buffer;
}

async function activeLookup(keyring: VerificationKeyring, kid: string, issuedAt: number) {
  const lookup = await keyring.lookup(kid, issuedAt);
  if (!lookup.ok) {
    throw new Error(
      `expected an active window for ${kid} at ${issuedAt}, refused ${lookup.reason}`,
    );
  }
  return lookup;
}

/**
 * Key-window *edges*, and key *identity*.
 *
 * `service-envelope.test.ts:498-590` already drives `unknown_kid`,
 * `key_not_yet_valid`, `key_retired` and a two-key overlap through
 * `verifyServiceEnvelope`, so those branches are covered and are not restated
 * here. Deleting the validity window would already turn that suite red. Two
 * narrower properties are left, and they are all this block claims.
 *
 * First, the edges. Those tests sit well inside their windows — `NOW ± 100`,
 * `notAfter: NOW - 1` — so an off-by-one on either comparison keeps them green.
 * Fable §10.5 requires overlapping current/previous `kid`s so a rotation never
 * strands an in-flight envelope, and a rotation off by one instant either
 * strands a legitimate write or honours a retired key. `notBefore` is asserted
 * inclusive and `notAfter` exclusive at the exact boundary instant.
 *
 * Second, which key came back. An end-to-end verification implies the right key
 * was returned but does not isolate it; a keyring that returned the correct
 * record with the wrong imported key fails there for a reason no assertion
 * names. Here each looked-up key verifies a real signature from its own signer
 * and fails against the other's.
 */
describe("verification key windows", () => {
  test("an unknown kid is refused without consulting a window", async () => {
    const key = await rotationKey(KEY_A);
    const keyring = new VerificationKeyring([
      { kid: key.kid, publicKeyHex: key.publicKeyHex, notBefore: 0 },
    ]);

    expect(await keyring.lookup("agora-never-issued", ROTATION_INSTANT)).toMatchObject({
      ok: false,
      reason: "unknown_kid",
    });
  });

  test("PLANTED: an envelope issued before the key exists is refused", async () => {
    const key = await rotationKey(KEY_B);
    const keyring = new VerificationKeyring([
      { kid: key.kid, publicKeyHex: key.publicKeyHex, notBefore: ROTATION_INSTANT },
    ]);

    expect(await keyring.lookup(key.kid, ROTATION_INSTANT - 1)).toMatchObject({
      ok: false,
      reason: "key_not_yet_valid",
    });
    // `notBefore` is inclusive: the first valid instant is the boundary itself.
    expect((await activeLookup(keyring, key.kid, ROTATION_INSTANT)).record.kid).toBe(key.kid);
  });

  test("PLANTED: an envelope issued at or after retirement is refused", async () => {
    const key = await rotationKey(KEY_A);
    const keyring = new VerificationKeyring([
      {
        kid: key.kid,
        publicKeyHex: key.publicKeyHex,
        notBefore: 0,
        notAfter: ROTATION_INSTANT,
      },
    ]);

    // `notAfter` is exclusive: the retirement instant is already too late.
    expect(await keyring.lookup(key.kid, ROTATION_INSTANT)).toMatchObject({
      ok: false,
      reason: "key_retired",
    });
    expect((await activeLookup(keyring, key.kid, ROTATION_INSTANT - 1)).record.kid).toBe(key.kid);
  });

  test("overlapping rotation returns each kid's own key, proven by signature", async () => {
    const overlap = 3_600;
    const outgoing = await rotationKey(KEY_A);
    const incoming = await rotationKey(KEY_B);
    const keyring = new VerificationKeyring([
      {
        kid: outgoing.kid,
        publicKeyHex: outgoing.publicKeyHex,
        notBefore: 0,
        notAfter: ROTATION_INSTANT,
      },
      {
        kid: incoming.kid,
        publicKeyHex: incoming.publicKeyHex,
        notBefore: ROTATION_INSTANT - overlap,
      },
    ]);

    // Inside the overlap both kids resolve. This is the property that keeps an
    // in-flight envelope signed by the outgoing key verifiable after the
    // incoming key is published.
    const insideOverlap = ROTATION_INSTANT - 1;
    const lookedUpOutgoing = await activeLookup(keyring, outgoing.kid, insideOverlap);
    const lookedUpIncoming = await activeLookup(keyring, incoming.kid, insideOverlap);
    expect(lookedUpOutgoing.record.kid).toBe(outgoing.kid);
    expect(lookedUpIncoming.record.kid).toBe(incoming.kid);

    const outgoingBytes = signedBytes(outgoing.kid);
    const incomingBytes = signedBytes(incoming.kid);
    const outgoingSignature = await crypto.subtle.sign(
      { name: "Ed25519" },
      outgoing.privateKey,
      outgoingBytes,
    );
    const incomingSignature = await crypto.subtle.sign(
      { name: "Ed25519" },
      incoming.privateKey,
      incomingBytes,
    );

    // Each looked-up key verifies only its own signer. Asserting the kid alone
    // would pass against a keyring that returned the right record with the
    // wrong imported key.
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        lookedUpOutgoing.key,
        outgoingSignature,
        outgoingBytes,
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        lookedUpIncoming.key,
        incomingSignature,
        incomingBytes,
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        lookedUpIncoming.key,
        outgoingSignature,
        outgoingBytes,
      ),
    ).toBe(false);
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        lookedUpOutgoing.key,
        incomingSignature,
        incomingBytes,
      ),
    ).toBe(false);

    // After the cutover only the incoming key resolves.
    expect(await keyring.lookup(outgoing.kid, ROTATION_INSTANT)).toMatchObject({
      ok: false,
      reason: "key_retired",
    });
    expect((await activeLookup(keyring, incoming.kid, ROTATION_INSTANT)).record.kid).toBe(
      incoming.kid,
    );
  });
});

/**
 * The auth source and vector files this proof rests on must stay ordinary UTF-8
 * text.
 *
 * A raw U+001E was twice pasted into a test value instead of being written as
 * an escape. The runtime bytes were correct both times; the *source* was not
 * reviewable. Such a byte is invisible in an editor and in a diff, and `rg`
 * classifies the file as binary and stops matching it — which is how the corpus
 * note warning about exactly this hazard became unsearchable itself.
 *
 * Catching that with an operator scan only works when someone remembers to run
 * one. This asserts it on every test run, which is the difference between an
 * invariant and a habit.
 *
 * TAB and LF are the only control bytes source here needs. Every other C0 byte
 * and DEL are refused. CR is refused too: these files are LF-only, and a stray
 * CRLF is the same class of invisible drift.
 */
const GUARDED_SOURCES: [string, string][] = [
  ["auth-canonical-vectors.test.ts", resolve(import.meta.dir, "auth-canonical-vectors.test.ts")],
  ["service-envelope.test.ts", resolve(import.meta.dir, "service-envelope.test.ts")],
  ["service-envelope-vectors.json", CORPUS_PATH],
  ["canonical.ts", resolve(import.meta.dir, "../../src/auth/canonical.ts")],
  ["keyring.ts", resolve(import.meta.dir, "../../src/auth/keyring.ts")],
  [
    "apps/web/lib/service-envelope.ts",
    resolve(REPOSITORY_ROOT, "apps/web/lib/service-envelope.ts"),
  ],
  [
    "apps/web/test/unit/service-envelope.test.ts",
    resolve(REPOSITORY_ROOT, "apps/web/test/unit/service-envelope.test.ts"),
  ],
];

/**
 * Offending bytes as `line: 0xNN` labels.
 *
 * The surrounding source text is deliberately not echoed. A failure needs to
 * say where to look, and quoting the line would reprint the invisible byte into
 * the test output, where it is just as unreadable.
 */
function controlByteSites(bytes: Uint8Array): string[] {
  const sites: string[] = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) {
      sites.push(`line ${line}: 0x${byte.toString(16).padStart(2, "0")}`);
    }
  }
  return sites;
}

describe("source text carries no invisible control bytes", () => {
  test.each(GUARDED_SOURCES)("%s is ordinary UTF-8 text", (_label, path) => {
    // Read as raw bytes: decoding to a string first is what makes the byte
    // invisible in the first place.
    expect(controlByteSites(readFileSync(path))).toEqual([]);
  });

  test("PLANTED: the scan detects forbidden controls and permits only tab and newline", () => {
    const encoder = new TextEncoder();

    // How these files spell a terminator now, plus the two control bytes source
    // legitimately contains. Without this the guard could be passing because it
    // refuses nothing.
    const escaped = "const rs = String.fromCharCode(0x1e);\n\tindented();\n";
    expect(controlByteSites(encoder.encode(escaped))).toEqual([]);

    // The paste this guard exists to catch, through the same helper.
    const pasted = `const rs = "${String.fromCharCode(0x1e)}";\n`;
    expect(controlByteSites(encoder.encode(pasted))).toEqual(["line 1: 0x1e"]);

    // The other byte this corpus has historically carried, and a line number
    // that has to be counted rather than guessed.
    const nul = `\n["kid", "agora${String.fromCharCode(0x00)}a"],\n`;
    expect(controlByteSites(encoder.encode(nul))).toEqual(["line 2: 0x00"]);

    // Constructed at runtime so this source remains ordinary text, while still
    // proving that DEL follows the same precise line-reporting path.
    const del = `\nconst terminator = "${String.fromCharCode(0x7f)}";\n`;
    expect(controlByteSites(encoder.encode(del))).toEqual(["line 2: 0x7f"]);
  });
});
