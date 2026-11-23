import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  parsePublicWatchCursor,
  publicWatchEtag,
  publicWatchOrigin,
  publicWatchPath,
  publicWatchRetryAfter,
  validPublicWatchTargets,
} from "../../src/public-watch.ts";

test("cursor grammar rejects coercions, overflow and noncanonical representations", () => {
  assert.equal(parsePublicWatchCursor("0"), 0);
  assert.equal(parsePublicWatchCursor("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const value of ["-1", "01", "1e3", "1\n", " 1", "9007199254740992", "1.1", "NaN"]) {
    assert.equal(parsePublicWatchCursor(value), undefined);
  }
});

test("only strong bounded validators may acknowledge rendered resources", () => {
  assert.equal(publicWatchEtag('"abc-1"'), '"abc-1"');
  for (const value of [
    null,
    undefined,
    "*",
    'W/"x"',
    '"a","b"',
    '"x\r\ny"',
    `"${"a".repeat(161)}"`,
  ]) {
    assert.equal(publicWatchEtag(value), undefined);
  }
});

test("watch origins exclude arbitrary hosts, credentials, paths and noncanonical loopback", () => {
  for (const origin of [
    "https://a.asimposium.org",
    "https://a-staging.asimposium.org",
    "http://127.0.0.1:8787",
  ]) {
    assert.equal(publicWatchOrigin(origin), true);
  }
  for (const origin of [
    "https://evil.test",
    "https://a.asimposium.org/",
    "https://a.asimposium.org.evil.test",
    "https://user@a.asimposium.org",
    "http://a.asimposium.org",
    "http://127.0.0.1:80",
    "http://127.0.0.1:01",
    "http://127.0.0.1:65536",
    "http://localhost:8787",
  ])
    assert.equal(publicWatchOrigin(origin), false);
});

test("the closed route vocabulary preserves claim pins, histories and pagination", () => {
  assert.equal(publicWatchPath("/cursor"), "cursor");
  for (const path of [
    "/p/P-DEMO.json",
    "/p/P-DEMO/claims/C-1%402.json?through=42",
    "/p/P-DEMO/claims/C-1@2.json",
    "/p/P-DEMO/dead-ends.json?include_superseded=true",
    "/now.json?before=opaque%3Acursor",
    "/problems.json?after=P-DEMO",
    "/reviews.json?problem=P-DEMO&after=opaque",
  ]) {
    assert.equal(publicWatchPath(path), "face", path);
  }
});

test("private routes, traversal, unknown query authority and ambiguous duplicate keys are rejected", () => {
  for (const path of [
    "/v1/inbox",
    "/v1/sessions/S-1/pack",
    "/join/ASIMP-EN-AAAA",
    "/cursor?token=secret",
    "//evil.test/cursor",
    "/p/P-DEMO/../P-OTHER.json",
    "/p/P-DEMO.json#secret",
    "/p/P-DEMO.json?token=secret",
    "/p/P-DEMO/claims/C-1.json?through=1&through=2",
    "/p/P-DEMO/claims/C-1.json?through=01",
    "/p/P-DEMO/claims/C-9007199254740992.json",
    "/p/P-DEMO/claims/C-1@0.json",
    "/p/P-DEMO.json?",
    "/reviews.json?problem=P-DEMO&url=https://evil.test",
    "/now.json?before=%00",
  ]) {
    assert.equal(publicWatchPath(path), undefined, path);
  }
});

test("watch manifests are bounded, nonempty, unique and seeded from actual representations", () => {
  assert.equal(validPublicWatchTargets([{ path: "/now.json", etag: '"one"' }]), true);
  assert.equal(validPublicWatchTargets([]), false);
  assert.equal(validPublicWatchTargets([{ path: "/cursor", etag: '"one"' }]), false);
  assert.equal(
    validPublicWatchTargets([
      { path: "/now.json", etag: '"one"' },
      { path: "/now.json", etag: '"two"' },
    ]),
    false,
  );
  assert.equal(
    validPublicWatchTargets(
      Array.from({ length: 11 }, (_, i) => ({
        path: `/p/P-DEMO/claims/C-${i + 1}.json`,
        etag: '"one"',
      })),
    ),
    false,
  );
});

test("retry hints cannot remove the polling floor or create unbounded sleep", () => {
  assert.equal(publicWatchRetryAfter("1"), 10_000);
  assert.equal(publicWatchRetryAfter("90"), 90_000);
  assert.equal(publicWatchRetryAfter("999999"), 120_000);
  for (const value of [null, "-1", "0", "1e3", "tomorrow"])
    assert.equal(publicWatchRetryAfter(value), undefined);
});

test("event watches require one complete bounded snapshot and never permit long polling", () => {
  for (const path of [
    "/p/P-DEMO/events.json?since=0&limit=200&through=42",
    "/p/P-DEMO/events.json?since=57&limit=200&through=257",
    "/p/P-DEMO/events.json?since=0&limit=200&through=0",
  ])
    assert.equal(publicWatchPath(path), "face", path);
  for (const query of [
    "",
    "since=0&limit=200",
    "since=0&through=42",
    "limit=200&through=42",
    "since=0&limit=201&through=42",
    "since=0&limit=0&through=0",
    "since=0&limit=200&through=201",
    "since=2&limit=200&through=1",
    "since=00&limit=200&through=42",
    "since=-1&limit=200&through=42",
    "since=0&limit=200&through=9007199254740992",
    "since=0&limit=200&through=42&wait=0",
    "since=0&limit=200&through=42&wait=25",
    "since=0&limit=200&through=42&since=1",
    "since=0&limit=200&through=42&token=secret",
  ])
    assert.equal(
      publicWatchPath("/p/P-DEMO/events.json" + (query ? "?" + query : "")),
      undefined,
      query,
    );
  for (const path of [
    "/v1/p/P-DEMO/events.json?since=0&limit=200&through=42",
    "/p/P-DEMO/events.ndjson?since=0&limit=200&through=42",
    "/p/P-DEMO/events.json?since=0&limit=200&through=42#fragment",
  ])
    assert.equal(publicWatchPath(path), undefined, path);
});

test("a full problem preview can watch its digest, eight claim reads and recent history", () => {
  const targets = [
    { path: "/p/P-DEMO.json", etag: '"digest"' },
    ...Array.from({ length: 8 }, (_, index) => ({
      path: "/p/P-DEMO/claims/C-" + (index + 1) + ".json?through=42",
      etag: '"claim"',
    })),
    { path: "/p/P-DEMO/events.json?since=0&limit=200&through=42", etag: '"events"' },
  ];
  assert.equal(validPublicWatchTargets(targets), true);
  assert.equal(
    validPublicWatchTargets([...targets, { path: "/now.json", etag: '"extra"' }]),
    false,
  );
});
