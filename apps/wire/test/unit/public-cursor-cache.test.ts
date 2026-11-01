import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { Env } from "../../src/env";
import { cursorEtag } from "../../src/herald/public-cursor";
import {
  createPublicCursorCache,
  type PublicCursorCache,
} from "../../src/herald/public-cursor-cache";

const ORIGIN = "https://a.asimposium.org";

function fixture() {
  const sql = new Database(":memory:");
  sql.run("CREATE TABLE public_cursor (singleton INTEGER PRIMARY KEY, cursor INTEGER)");
  sql.run("INSERT INTO public_cursor VALUES (1, 7)");
  const calls = { reads: 0, opens: 0, matches: 0, puts: 0, deletes: 0 };
  let now = 10_000;
  let waitForRead: Promise<void> | undefined;
  let waitForPut: Promise<void> | undefined;
  let waitForOpen: Promise<void> | undefined;
  let waitForMatch: Promise<void> | undefined;
  let waitForDelete: Promise<void> | undefined;
  let failRead = false;
  let failCache = false;
  const db = {
    prepare(query: string) {
      return {
        async first() {
          calls.reads++;
          if (failRead) throw new Error("private database exception, not public");
          const row = sql.query(query).get();
          await waitForRead;
          return row;
        },
      };
    },
  } as unknown as Env["DB"];
  // Deliberately no enrollment/replay/Google configuration: cursor is public.
  const env = { DB: db, STOA_ORIGIN: ORIGIN } as Env;
  const entries = new Map<string, Response>();
  const provider: PublicCursorCache = {
    async match(request) {
      calls.matches++;
      await waitForMatch;
      if (failCache) throw new Error("cache read failure");
      const stored = entries.get(request.url);
      return stored === undefined
        ? undefined
        : new Response(stored.clone().body, {
            status: stored.status,
            headers: [...stored.headers],
          });
    },
    async put(request, response) {
      calls.puts++;
      await waitForPut;
      if (failCache) throw new Error("cache write failure");
      entries.set(request.url, response);
    },
    async delete(request) {
      calls.deletes++;
      await waitForDelete;
      if (failCache) throw new Error("cache delete failure");
      entries.delete(request.url);
    },
  };
  const adapter = createPublicCursorCache({
    cache: async () => {
      calls.opens++;
      await waitForOpen;
      return provider;
    },
    now: () => now,
  });
  const app = createApp();
  function read(init?: RequestInit, selected = env, url = `${selected.STOA_ORIGIN}/cursor`) {
    return adapter.fetch(new Request(url, init), selected, async (request) =>
      app.fetch(request, selected),
    );
  }
  return {
    app,
    adapter,
    env,
    sql,
    calls,
    entries,
    read,
    advance(ms: number) {
      now += ms;
    },
    value(value: number) {
      sql.query("UPDATE public_cursor SET cursor = ?").run(value);
    },
    holdRead(promise?: Promise<void>) {
      waitForRead = promise;
    },
    holdPut(promise?: Promise<void>) {
      waitForPut = promise;
    },
    holdOpen(promise?: Promise<void>) {
      waitForOpen = promise;
    },
    holdMatch(promise?: Promise<void>) {
      waitForMatch = promise;
    },
    holdDelete(promise?: Promise<void>) {
      waitForDelete = promise;
    },
    failRead(value = true) {
      failRead = value;
    },
    failCache(value = true) {
      failCache = value;
    },
  };
}

async function spinUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

async function completes<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("optional cache stranded authority")), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("public cursor Cache API adapter (unit, no deployed edge claim)", () => {
  test("anonymous D1 cursor works with absent or malformed enrollment configuration", async () => {
    const f = fixture();
    const response = await f.app.fetch(new Request(`${ORIGIN}/cursor`), f.env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("7");
    const misconfigured = {
      ...f.env,
      SERVICE_ENVELOPE_KEYS: "not a keyring",
      ENROLLMENT_REPLAY_KEY: "invalid",
    };
    const head = await f.app.fetch(
      new Request(`${ORIGIN}/cursor`, { method: "HEAD" }),
      misconfigured,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(await cursorEtag("7"));
    f.sql.close();
  });

  test("warm GET and HEAD hits perform zero D1 reads and expire within five seconds", async () => {
    const f = fixture();
    expect(await (await f.read()).text()).toBe("7");
    expect(f.calls.reads).toBe(1);
    const readsBeforeHits = f.calls.reads;
    for (let i = 0; i < 20; i++) {
      const response = await f.read(i % 2 ? { method: "HEAD" } : undefined);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(i % 2 ? "" : "7");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-asimp-internal-cursor-observed-at")).toBeNull();
    }
    expect(f.calls.reads - readsBeforeHits).toBe(0);
    f.advance(4_999);
    expect((await f.read()).headers.get("age")).toBe("5");
    expect(f.calls.reads).toBe(1);
    f.value(8);
    f.advance(1);
    expect(await (await f.read()).text()).toBe("8");
    expect(f.calls.reads).toBe(2);
    f.sql.close();
  });

  test("a cached matching ETag revalidates, so a hide/change cannot produce a false 304", async () => {
    const f = fixture();
    const old = (await f.read()).headers.get("etag");
    f.value(8); // A public content-control transaction advances this same signal.
    const changed = await f.read({ headers: { "if-none-match": old ?? "" } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("8");
    expect(f.calls.reads).toBe(2);
    for (const value of [await cursorEtag("8"), `W/${await cursorEtag("8")}`, "*"]) {
      const current = await f.read({ headers: { "if-none-match": value } });
      expect(current.status).toBe(304);
      expect(await current.text()).toBe("");
    }
    expect(f.calls.reads).toBe(5);
    expect([...f.entries.values()].every((response) => response.status === 200)).toBe(true);
    f.sql.close();
  });

  test("simultaneous cold polls share one in-flight canonical read", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<void>();
    f.holdRead(ready.promise);
    const requests = Array.from({ length: 30 }, () => f.read());
    await spinUntil(() => f.calls.reads > 0);
    expect(f.calls.reads).toBe(1);
    ready.resolve();
    const responses = await Promise.all(requests);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array(30).fill("7"),
    );
    expect(f.calls.reads).toBe(1);
    expect(f.calls.puts).toBe(1);
    f.sql.close();
  });

  test("simultaneous matching conditional polls coalesce without sharing a 304 cache entry", async () => {
    const f = fixture();
    const etag = (await f.read()).headers.get("etag") ?? "";
    const ready = Promise.withResolvers<void>();
    f.holdRead(ready.promise);
    const requests = Array.from({ length: 20 }, () =>
      f.read({ headers: { "if-none-match": etag } }),
    );
    await spinUntil(() => f.calls.reads > 1);
    expect(f.calls.reads).toBe(2);
    ready.resolve();
    expect((await Promise.all(requests)).every((response) => response.status === 304)).toBe(true);
    expect(f.calls.reads).toBe(2);
    f.sql.close();
  });

  test("write invalidation racing an old fill refuses the stale result even when cache deletion fails", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<void>();
    f.holdPut(ready.promise);
    const first = f.read({ headers: { "if-none-match": await cursorEtag("7") } });
    await spinUntil(() => f.calls.puts === 1);
    f.value(8);
    f.failCache();
    await f.adapter.invalidate(f.env);
    f.failCache(false);
    f.holdPut();
    ready.resolve();
    const raced = await first;
    expect(raced.status).toBe(200);
    expect(await raced.text()).toBe("8");
    expect(await (await f.read()).text()).toBe("8");
    expect(f.calls.reads).toBe(3);
    f.sql.close();
  });

  test("invalidating after a rejected write does not manufacture a public change", async () => {
    const f = fixture();
    const etag = (await f.read()).headers.get("etag");
    await f.adapter.invalidate(f.env);
    const response = await f.read({ headers: { "if-none-match": etag ?? "" } });
    expect(response.status).toBe(304);
    expect(f.calls.reads).toBe(2);
    expect(f.calls.deletes).toBe(1);
    f.sql.close();
  });

  test("cache read/write failure falls back to D1, and an unavailable provider does the same", async () => {
    const f = fixture();
    f.failCache();
    expect(await (await f.read()).text()).toBe("7");
    f.value(8);
    expect(await (await f.read()).text()).toBe("8");
    expect(f.calls.reads).toBe(2);
    const unavailable = createPublicCursorCache({
      cache: async () => {
        throw new Error("no edge");
      },
    });
    const response = await unavailable.fetch(
      new Request(`${ORIGIN}/cursor`),
      f.env,
      async (request) => f.app.fetch(request, f.env),
    );
    expect(await response.text()).toBe("8");
    expect(f.calls.reads).toBe(3);
    f.sql.close();
  });

  test("origin failures and corrupt integers never become cached successful cursors", async () => {
    const f = fixture();
    f.failRead();
    for (let i = 0; i < 2; i++) {
      const response = await f.read();
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("private database exception");
    }
    expect(f.entries.size).toBe(0);
    f.failRead(false);
    f.value(Number.MAX_SAFE_INTEGER + 1);
    expect((await f.read()).status).toBe(500);
    expect(f.entries.size).toBe(0);
    f.value(9);
    expect(await (await f.read()).text()).toBe("9");
    expect(f.calls.reads).toBe(4);
    f.sql.close();
  });

  test("explicit cache reload/no-cache and protocol variants bypass warm entries", async () => {
    const f = fixture();
    await f.read();
    f.value(8);
    expect(await (await f.read({ headers: { "cache-control": "no-cache" } })).text()).toBe("8");
    f.value(9);
    expect(await (await f.read({ cache: "reload" })).text()).toBe("9");
    f.value(10);
    expect(await (await f.read({ cache: "no-cache" })).text()).toBe("10");
    const response = await f.read({ headers: { "asimp-protocol-version": "unsupported" } });
    expect(response.status).toBe(400);
    expect(f.calls.reads).toBe(4);
    f.sql.close();
  });

  test("explicit no-store performs no Cache API I/O or storage and retires older local snapshots", async () => {
    const f = fixture();
    await f.read();
    const before = { ...f.calls };
    f.value(8);
    expect(await (await f.read({ cache: "no-store" })).text()).toBe("8");
    f.value(9);
    expect(await (await f.read({ headers: { "cache-control": "no-store" } })).text()).toBe("9");
    expect(f.calls.opens).toBe(before.opens);
    expect(f.calls.matches).toBe(before.matches);
    expect(f.calls.puts).toBe(before.puts);
    expect(f.calls.deletes).toBe(before.deletes);
    expect(await (await f.read()).text()).toBe("9");
    expect(f.calls.reads).toBe(4);
    f.sql.close();
  });

  for (const stage of ["open", "match", "put"] as const) {
    test(`a never-resolving cache ${stage} cannot strand the canonical cursor response`, async () => {
      const f = fixture();
      const never = new Promise<void>(() => {});
      if (stage === "open") f.holdOpen(never);
      if (stage === "match") f.holdMatch(never);
      if (stage === "put") f.holdPut(never);
      const response = await completes(f.read());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("7");
      expect(f.calls.reads).toBe(1);
      f.sql.close();
    });
  }

  test("a never-resolving cache delete cannot strand a committed mutation response", async () => {
    const f = fixture();
    await f.read();
    f.holdDelete(new Promise<void>(() => {}));
    const response = await completes(
      (async () => {
        f.value(8);
        const committed = new Response("committed", { status: 201 });
        // This is the same awaited invalidation used by the entrypoint's finally.
        await f.adapter.invalidate(f.env);
        return committed;
      })(),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("committed");
    expect(await (await f.read()).text()).toBe("8");
    expect(f.calls.reads).toBe(2);
    f.sql.close();
  });

  test("a timed-out put that completes after a newer fill cannot restore its old cursor", async () => {
    const f = fixture();
    const late = Promise.withResolvers<void>();
    f.holdPut(late.promise);
    expect(await (await completes(f.read())).text()).toBe("7");
    expect(f.entries.size).toBe(0);
    f.holdPut();
    f.value(8);
    expect(await (await f.read()).text()).toBe("8");
    late.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stale = [...f.entries.values()][0];
    expect(await stale?.clone().text()).toBe("7");
    expect(await (await f.read()).text()).toBe("8");
    expect(f.calls.reads).toBe(3);
    f.sql.close();
  });

  test("a stuck cached body is cancelled at the cache deadline before the D1 fallback", async () => {
    const f = fixture();
    await f.read();
    const key = [...f.entries.keys()][0];
    const stored = key === undefined ? undefined : f.entries.get(key);
    if (!key || !stored) throw new Error("cache fixture missing");
    let cancelled = false;
    const stuck = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: stored.headers },
    );
    f.entries.set(key, stuck);
    expect(await (await completes(f.read())).text()).toBe("7");
    expect(f.calls.reads).toBe(2);
    // match clones the fixture response; one tee branch retains the original.
    // Cancel that fixture-owned branch to observe the reader's cancellation.
    void stuck.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    f.sql.close();
  });

  test("cookies, bearer headers, query variants and foreign hosts cannot use shared entries", async () => {
    const f = fixture();
    await f.read();
    f.value(9);
    for (const headers of [
      new Headers({ cookie: "private-session=secret" }),
      new Headers({ authorization: "Bearer secret" }),
    ]) {
      expect(await (await f.read({ headers })).text()).toBe("9");
    }
    expect(await (await f.read(undefined, f.env, "https://untrusted.example/cursor")).text()).toBe(
      "9",
    );
    expect(await (await f.read(undefined, f.env, `${ORIGIN}/cursor?cache=other`)).text()).toBe("9");
    expect(f.calls.reads).toBe(5);
    expect(f.calls.puts).toBe(1);
    f.sql.close();
  });

  test("two D1 capabilities with identical origins never share cached authority", async () => {
    const f = fixture();
    const other = fixture();
    other.value(100);
    await f.read();
    const second = await f.adapter.fetch(
      new Request(`${ORIGIN}/cursor`),
      other.env,
      async (request) => other.app.fetch(request, other.env),
    );
    expect(await second.text()).toBe("100");
    expect(f.entries.size).toBe(2);
    expect(f.calls.reads).toBe(1);
    expect(other.calls.reads).toBe(1);
    const staging = { ...f.env, STOA_ORIGIN: "https://a-staging.asimposium.org" };
    expect(await (await f.read(undefined, staging)).text()).toBe("7");
    expect(f.calls.reads).toBe(2);
    expect(f.entries.size).toBe(3);
    f.sql.close();
    other.sql.close();
  });

  test("future and malformed cache values are misses, and cache state never touches other faces", async () => {
    const f = fixture();
    await f.read();
    const key = [...f.entries.keys()][0];
    expect(key).toBeDefined();
    if (!key) return;
    const valid = f.entries.get(key);
    if (!valid) throw new Error("cache fixture missing");
    const headers = new Headers(valid.headers);
    headers.set("x-asimp-internal-cursor-observed-at", "100000");
    f.entries.set(key, new Response("7", { headers }));
    expect(await (await f.read()).text()).toBe("7");
    f.entries.set(key, new Response("private payload", { headers }));
    expect(await (await f.read()).text()).toBe("7");
    expect(f.calls.reads).toBe(3);
    let canonicalCalls = 0;
    const face = await f.adapter.fetch(new Request(`${ORIGIN}/p/P-MATH.json`), f.env, async () => {
      canonicalCalls++;
      return new Response("hidden", {
        status: 403,
        headers: { "cache-control": "private, no-store" },
      });
    });
    expect(face.status).toBe(403);
    expect(canonicalCalls).toBe(1);
    expect(f.entries.size).toBe(1);
    f.sql.close();
  });
});
