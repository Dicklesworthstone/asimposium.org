import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  CITATION_EVENT_MAX_BYTES,
  type CitationContentRow,
  mentionsCitation,
  verifiedCitationContent,
} from "../../src/ledger/citation-read-integrity";

async function committed(payload = '{"citation_id":"L-1","title":"Published source"}') {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    problem_id: "P-TEST",
    seq: 3,
    public_seq: 3,
    payload_json: payload,
    payload_sha256: hash,
    content_sha256: hash,
    redacted_at: null,
  } satisfies CitationContentRow;
}

describe("citation publication authority", () => {
  test("reads exact committed public bytes", async () => {
    assert.deepEqual(await verifiedCitationContent("P-TEST", await committed()), {
      citation_id: "L-1",
      title: "Published source",
    });
  });

  const mutations: Array<[string, Partial<CitationContentRow>]> = [
    ["wrong problem", { problem_id: "P-OTHER" }],
    ["unpublished event", { public_seq: 2 }],
    ["zero sequence", { seq: 0 }],
    ["fractional sequence", { seq: 1.5 }],
    ["unsafe sequence", { seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe public cursor", { public_seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["redacted content", { redacted_at: "2026-09-15T00:00:00.000Z" }],
    ["missing content", { payload_json: null }],
    ["missing commitment", { content_sha256: null }],
    ["wrong commitment", { content_sha256: "0".repeat(64) }],
    ["bad digest syntax", { payload_sha256: "not-a-digest" }],
    ["altered body", { payload_json: '{"title":"PRIVATE_CANARY"}' }],
  ];
  for (const [name, mutation] of mutations) {
    test(`withholds ${name}`, async () => {
      const row = await committed();
      assert.ok(await verifiedCitationContent("P-TEST", row));
      assert.equal(await verifiedCitationContent("P-TEST", { ...row, ...mutation }), undefined);
    });
  }

  for (const payload of ["null", "[]", '"text"', "42", "{bad json"]) {
    test(`refuses even correctly hashed non-object content: ${payload}`, async () => {
      assert.equal(await verifiedCitationContent("P-TEST", await committed(payload)), undefined);
    });
  }

  test("byte budget accounts for UTF-8, not just string length", async () => {
    const payload = JSON.stringify({ body: "é".repeat(CITATION_EVENT_MAX_BYTES / 2) });
    assert.ok(payload.length < CITATION_EVENT_MAX_BYTES);
    assert.equal(await verifiedCitationContent("P-TEST", await committed(payload)), undefined);
  });

  test("exact byte limit is accepted; plus one is withheld", async () => {
    const overhead = JSON.stringify({ body: "" }).length;
    const exact = JSON.stringify({ body: "a".repeat(CITATION_EVENT_MAX_BYTES - overhead) });
    assert.ok(await verifiedCitationContent("P-TEST", await committed(exact)));
    assert.equal(await verifiedCitationContent("P-TEST", await committed(`${exact} `)), undefined);
  });
});

describe("exact citation mentions", () => {
  for (const text of ["L-1@2", "[L-1@2]", "See (L-1@2).", "Use L-1@2, then test."]) {
    test(`recognizes pinned mention ${text}`, () => {
      assert.equal(mentionsCitation(text, "L-1", 2), true);
    });
  }
  for (const text of [
    "L-10@2",
    "L-1@20",
    "L-1@1",
    "L-1@02",
    "L-1@0",
    "L-1@2@3",
    "XL-1@2",
    "L-1@2suffix",
    "L-1@2_more",
    "L-1@2-extra",
    "éL-1@2",
    "L-1@2é",
    "𝒙L-1@2",
    "https://example.invalid/L-1@2",
    "file.L-1@2",
    "L-1@2.json",
    "%L-1@2",
    "L-1",
  ]) {
    test(`does not invent a pinned association from ${text}`, () => {
      assert.equal(mentionsCitation(text, "L-1", 2), false);
    });
  }
  test("bare references are an explicit ID-level option, not version evidence", () => {
    assert.equal(mentionsCitation("[L-1]", "L-1", 2, true), true);
    assert.equal(mentionsCitation("[L-10]", "L-1", 2, true), false);
    assert.equal(mentionsCitation("[L-1@3]", "L-1", 2, true), false);
  });
  test("later matching token survives an earlier near miss", () => {
    assert.equal(mentionsCitation("[L-10@2], [L-1@3], then [L-1@2]", "L-1", 2), true);
  });
  test("refuses invalid target versions and does not interpret IDs as regex", () => {
    assert.equal(mentionsCitation("L-1@2", "L-.*", 2), false);
    for (const version of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(mentionsCitation("L-1@2", "L-1", version), false);
    }
  });
});
