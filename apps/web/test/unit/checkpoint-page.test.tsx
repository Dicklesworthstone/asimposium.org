import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { CHECKPOINT_SIGNATURE_MESSAGE_FORMAT, PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
const { default: Page, metadata } = await import("../../app/r/p/[slug]/checkpoint/page");
const realFetch = globalThis.fetch;
let oldOrigin: string | undefined;
beforeEach(() => {
  oldOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (oldOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = oldOrigin;
});

function render(query: Record<string, string | string[] | undefined> = {}) {
  return Page({
    params: Promise.resolve({ slug: "P-DEMO" }),
    searchParams: Promise.resolve(query),
  }).then(renderToStaticMarkup);
}

const row = {
  checkpoint_seq: 16,
  root_chain_digest: "a".repeat(64),
  checkpoint_digest: "b".repeat(64),
  key_id: "original",
  algorithm: "Ed25519",
  signature: "c".repeat(128),
  signed_at: "2026-11-01T00:00:00.000Z",
};
const face = {
  problem_id: "P-DEMO",
  message_format: CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
  keys: [{ key_id: row.key_id, algorithm: row.algorithm, public_key: "d".repeat(64) }],
  signatures: [row, { ...row, key_id: "second" }],
  unsigned: 3,
  next_after: 16,
};

test("a human can read signed and unsigned coverage and continue at the returned sequence", async () => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json(face);
  }) as unknown as typeof fetch;
  const html = await render({ after: "8" });
  expect(urls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/checkpoints.json?after=8`]);
  for (const text of [
    row.root_chain_digest,
    row.checkpoint_digest,
    row.signature,
    "d".repeat(64),
    "original",
    "second",
    "Checkpoints without a recorded signature: <strong>3",
    "independently obtained",
    "/r/p/P-DEMO/checkpoint?after=16",
    "/p/P-DEMO/checkpoints.md?after=8",
    "/p/P-DEMO/export.jsonl.gz",
  ]) {
    expect(html).toContain(text);
  }
  expect(metadata.robots.index).toBe(false);
});

test("empty and unavailable faces remain distinct, and a continuation must match its page", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ ...face, keys: [], signatures: [], next_after: null }),
  ) as unknown as typeof fetch;
  expect(await render({ after: "16" })).toContain("No signatures were returned after sequence 16");
  for (const invalid of [
    { ...face, problem_id: "P-OTHER" },
    face,
    { ...face, next_after: 99 },
    { ...face, signatures: [row, row] },
    { ...face, keys: [{ ...face.keys[0], private: "SECRET" }] },
  ]) {
    globalThis.fetch = mock(async () => Response.json(invalid)) as unknown as typeof fetch;
    const html = await render({ after: invalid === face ? "16" : "0" });
    expect(html).toContain("temporarily unavailable");
    expect(html).not.toContain(row.signature);
  }
});

test("invalid cursors fail before the public fetch", async () => {
  const request = mock(async () => Response.json(face));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { after: ["1", "2"] },
    { after: "-1" },
    { after: "9007199254740992" },
    { through: "1" },
  ]) {
    expect(await render(query)).toContain("Invalid checkpoint sequence");
  }
  expect(request).not.toHaveBeenCalled();
});
