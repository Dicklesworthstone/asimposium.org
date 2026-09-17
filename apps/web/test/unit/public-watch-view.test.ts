import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClaimFaceResponse, ProblemFaceResponse } from "@asimposium/contracts";
import {
  publicReadWatch, publicViewWatchTargets, parsePublicWatchManifest,
} from "../../lib/public-watch-view.ts";
import {
  bindPublicWatchBrowser, deferPublicWatchRefresh, publicWatchStatusText,
  type PublicWatchBrowser,
} from "../../lib/public-watch-browser.ts";
import { claimBoardWatchTargets, loadClaimBoard } from "../../lib/claim-board.ts";

const ORIGIN = "https://a.asimposium.org";
const DIGEST = { path: "/p/P-DEMO.json", etag: '"digest"' };

// Typed minimal fixtures for the fields consumed by the existing board loader.
// They are not a replacement for the public JSON Schema contract suite.
function face(count = 1): ProblemFaceResponse {
  return { problem: "P-DEMO", cursor: 42, items: Array.from({ length: count }, (_, index) => ({
    kind: "claim", id: `C-${index + 1}`, body: "Digest statement", neutralized: [],
    why_included: "Published claim",
  })) } as unknown as ProblemFaceResponse;
}
function claim(id: string): ClaimFaceResponse {
  return { problem: "P-DEMO", cursor: 42, claim_state: { claim_id: id, version: 2 },
    items: [{ kind: "claim-detail", id: `${id}@2`, body: "Exact statement", neutralized: [],
      why_included: "Exact public statement" }], omitted: [], degraded: [],
  } as unknown as ClaimFaceResponse;
}
const target = (id: string) => ({ path: `/p/P-DEMO/claims/${id}.json?through=42`, etag: `"${id}"` });

test("render receipts retain exact paths and header validators, not body or cursor guesses", () => {
  const path = "/p/P-DEMO/claims/C-1%402.json?through=42";
  assert.deepEqual(publicReadWatch(path, new Headers({ etag: '"verified"' })), {
    watch: { path, etag: '"verified"' },
  });
  assert.deepEqual(publicReadWatch("/v1/inbox", new Headers({ etag: '"private"' })), {});
  assert.deepEqual(publicReadWatch("/cursor", new Headers({ etag: '"global"' })), {});
});

test("absent, weak or malformed response validators disable automatic watching", () => {
  for (const etag of [undefined, 'W/"weak"', "*", '"one","two"']) {
    assert.deepEqual(publicReadWatch("/now.json", new Headers(etag ? { etag } : {})), {});
  }
});

test("every rendered dependency must have its own valid receipt", () => {
  assert.deepEqual(publicViewWatchTargets(DIGEST, target("C-1")), [DIGEST, target("C-1")]);
  assert.deepEqual(publicViewWatchTargets(DIGEST, undefined), []);
  assert.deepEqual(publicViewWatchTargets(undefined, target("C-1")), []);
  assert.deepEqual(publicViewWatchTargets(), []);
});

test("matching repeated reads deduplicate but conflicting render receipts refuse a partial view", () => {
  assert.deepEqual(publicViewWatchTargets(DIGEST, { ...DIGEST }), [DIGEST]);
  assert.deepEqual(publicViewWatchTargets(DIGEST, { ...DIGEST, etag: '"different"' }), []);
  assert.deepEqual(publicViewWatchTargets(DIGEST,
    ...Array.from({ length: 9 }, (_, i) => target(`C-${i + 1}`))), []);
});

test("client manifest decoding stays inside the credentialless route vocabulary", () => {
  assert.deepEqual(parsePublicWatchManifest(JSON.stringify([DIGEST])), [DIGEST]);
  for (const value of ["not JSON", "null", "{}", '[null]', '[1]',
    '[{"path":"/v1/inbox","etag":"\\"valid\\""}]',
    '[{"path":"/now.json","etag":1}]']) {
    assert.deepEqual(parsePublicWatchManifest(value), []);
  }
  assert.deepEqual(parsePublicWatchManifest(JSON.stringify([DIGEST, DIGEST])), []);
});

test("claim board preserves each successfully rendered resource's actual through-pinned receipt", async () => {
  const calls: string[] = [];
  const rows = await loadClaimBoard(face(10), ORIGIN, async (_problem, id, origin, query) => {
    calls.push(id); assert.equal(origin, ORIGIN); assert.deepEqual(query, { through: "42" });
    return { state: "ok", data: claim(id), origin: ORIGIN, watch: target(id) };
  });
  assert.equal(calls.length, 8);
  assert.equal(rows.length, 10);
  assert.equal(rows[0]?.item.body, "Exact statement");
  assert.equal(rows[0]?.href, "/p/P-DEMO/claims/C-1%402?through=42");
  assert.deepEqual(rows[0]?.watch, target("C-1"));
  assert.equal(rows[8]?.watch, undefined);
  assert.equal(claimBoardWatchTargets(DIGEST, rows).length, 9);
});

test("a failed enriched read cannot be silently left out of the view's liveness claim", async () => {
  const rows = await loadClaimBoard(face(2), ORIGIN, async (_problem, id) => id === "C-1"
    ? { state: "unavailable", reason: "network" }
    : { state: "ok", origin: ORIGIN, data: claim(id), watch: target(id) });
  assert.equal(rows[0]?.standing.state, "unavailable");
  assert.deepEqual(claimBoardWatchTargets(DIGEST, rows), []);
});

test("a readable claim from an older deployment without ETags remains readable but not falsely live", async () => {
  const rows = await loadClaimBoard(face(), ORIGIN, async (_problem, id) => ({
    state: "ok", origin: ORIGIN, data: claim(id),
  }));
  assert.equal(rows[0]?.standing.state, "ok");
  assert.deepEqual(claimBoardWatchTargets(DIGEST, rows), []);
});

test("mismatched origin and missing exact statement never donate validators to the board", async () => {
  for (const fault of ["origin", "statement"]) {
    const rows = await loadClaimBoard(face(), ORIGIN, async (_problem, id) => ({
      state: "ok", origin: fault === "origin" ? "https://a-staging.asimposium.org" : ORIGIN,
      data: fault === "statement" ? { ...claim(id), items: [] } : claim(id), watch: target(id),
    }));
    assert.equal(rows[0]?.standing.state, "unavailable");
    assert.equal(rows[0]?.watch, undefined);
    assert.deepEqual(claimBoardWatchTargets(DIGEST, rows), []);
  }
});

test("an empty problem needs only its rendered digest, not invented claim probes", async () => {
  const rows = await loadClaimBoard(face(0), ORIGIN, async () => { throw new Error("must not read"); });
  assert.deepEqual(claimBoardWatchTargets(DIGEST, rows), [DIGEST]);
});

function browserFixture() {
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState, activeElement: null as Element | null,
  });
  let selected = false;
  const window = Object.assign(new EventTarget(), {
    navigator: { onLine: true },
    getSelection: () => ({ isCollapsed: !selected }) as Selection,
  });
  const browser = { document, window } as unknown as PublicWatchBrowser;
  return { document, window, browser, select: (value: boolean) => { selected = value; } };
}

test("visibility and connectivity jointly pause and resume the same watcher", () => {
  const f = browserFixture(); const calls: (string | boolean)[] = [];
  const dispose = bindPublicWatchBrowser({
    start: (active) => { calls.push("start", active ?? true); },
    stop: () => { calls.push("stop"); },
    setActive: (active) => { calls.push(active); },
  }, true, f.browser);
  f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
  f.window.navigator.onLine = false; f.window.dispatchEvent(new Event("offline"));
  f.document.visibilityState = "visible"; f.document.dispatchEvent(new Event("visibilitychange"));
  f.window.navigator.onLine = true; f.window.dispatchEvent(new Event("online"));
  assert.deepEqual(calls, ["start", true, false, false, false, true]);
  dispose(); assert.equal(calls.at(-1), "stop");
  const length = calls.length;
  f.document.dispatchEvent(new Event("visibilitychange")); f.window.dispatchEvent(new Event("online"));
  assert.equal(calls.length, length);
});

test("user pause survives connectivity and visibility changes", () => {
  const f = browserFixture(); const active: boolean[] = [];
  const dispose = bindPublicWatchBrowser({ start: (value) => { active.push(value ?? true); },
    stop() {}, setActive: (value) => { active.push(value); } }, false, f.browser);
  f.window.dispatchEvent(new Event("online")); f.document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(active, [false, false, false]); dispose();
});

test("mount-cleanup-remount leaves exactly one lifecycle listener per event", () => {
  const f = browserFixture(); let updates = 0; let stops = 0;
  const watch = { start() {}, stop() { stops++; }, setActive() { updates++; } };
  bindPublicWatchBrowser(watch, true, f.browser)();
  const dispose = bindPublicWatchBrowser(watch, true, f.browser);
  f.window.dispatchEvent(new Event("online")); assert.equal(updates, 1);
  dispose(); assert.equal(stops, 2);
});

test("automatic refresh defers for editable controls and selected text, not ordinary reading", () => {
  const f = browserFixture(); assert.equal(deferPublicWatchRefresh(f.browser), false);
  f.select(true); assert.equal(deferPublicWatchRefresh(f.browser), true); f.select(false);
  let selector = "";
  f.document.activeElement = { closest(value: string) { selector = value; return {}; } } as unknown as Element;
  assert.equal(deferPublicWatchRefresh(f.browser), true); assert.match(selector, /input, textarea, select/);
  assert.match(selector, /contenteditable/);
  f.document.activeElement = { closest() { return null; } } as unknown as Element;
  assert.equal(deferPublicWatchRefresh(f.browser), false);
});

test("live status describes observed freshness, never scientific certainty", () => {
  assert.match(publicWatchStatusText({ status: "current" }), /last check/);
  assert.match(publicWatchStatusText({ status: "unavailable", reason: "http" }), /last rendered snapshot/);
  assert.match(publicWatchStatusText({ status: "paused" }), /paused/);
  assert.match(publicWatchStatusText({ status: "update-available" }), /when ready/);
});
