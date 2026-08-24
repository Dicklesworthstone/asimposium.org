/**
 * Pack determinism along the two axes the in-process tests cannot reach
 * (bead asimposiumorg-6jo, S-5): budget buckets and process restarts.
 *
 * `diptych.test.ts` already proves that rendering the same projection twice in one process
 * is byte-identical. That is the easy half. The claim the plan actually rests on (Fable
 * §1.3.5, §7.3: "determinism is cache money") is stronger:
 *
 *   - a bigger budget must *extend* a pack, not reshuffle it, so a harness prompt cache
 *     hits on the unchanged prefix across repeated polls; and
 *   - a fresh process must produce the same bytes, or the goldens and any cross-run digest
 *     comparison are measuring one process's hash seed rather than the projection; and
 *   - the literal criterion Fable §16.2 states — "Pack determinism: two `orient` packs at
 *     the same cursor byte-compare" — must hold through the real `composePack` seam, not
 *     only for a hand-built fixture projection handed straight to the renderer.
 *
 * The markdown face keeps its cacheable prefix in raw bytes, not merely inside
 * an item substring: budget-varying metadata is a post-item trailer.
 */

import { describe, expect, test } from "bun:test";
import { composePack, renderProjection } from "../../src/index.ts";
import type { PackCandidate, PackComposerInput } from "../../src/pack-composer.ts";
import type { Projection } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

/**
 * The same cursor at a smaller budget: fewer items, and the drop recorded in `omitted[]`
 * exactly as a real composer must (Fable §7.3 — an empty pack with an empty `omitted` is a
 * bug, a truncated one that says so is information).
 */
type ProjectionWithPackMetadata = Projection & {
  readonly session?: string;
  readonly budget_tokens?: number;
  readonly tokens_estimate?: number;
};

function budgetBucket(items: number): ProjectionWithPackMetadata {
  const pack = safeWorkingPack();
  const dropped = pack.items.length - items;
  return {
    ...pack,
    items: pack.items.slice(0, items).map((item, index) => ({ ...item, tokens: 160 + index * 20 })),
    omitted:
      dropped > 0
        ? [...pack.omitted, { reason: "budget_exceeded", detail: `${dropped} further item(s)` }]
        : pack.omitted,
    session: "SES-cache-stable",
    budget_tokens: items === 1 ? 800 : items === 2 ? 1_500 : 2_500,
    tokens_estimate: 320 + items * 180,
  };
}

/** Every raw byte through the complete ordered item sequence, excluding its trailer. */
function rawItemPrefix(markdown: string): string {
  const trailer = markdown.indexOf("<!-- asimp:trailer ");
  if (trailer === -1) throw new Error("markdown face is missing its post-item trailer");
  return markdown.slice(0, trailer);
}

function trailerLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .find((candidate) => candidate.startsWith("<!-- asimp:trailer "));
  if (line === undefined) throw new Error("markdown face is missing its post-item trailer");
  return line;
}

describe("stable-prefix ordering across budget buckets", () => {
  const buckets = [1, 2, 3].map((n) => ({ n, md: renderProjection(budgetBucket(n), "md").body }));

  test("a larger same-cursor budget shares raw bytes through the complete smaller item list", () => {
    for (let i = 1; i < buckets.length; i += 1) {
      const smaller = rawItemPrefix(buckets[i - 1]?.md ?? "");
      const larger = buckets[i]?.md ?? "";
      expect(larger.startsWith(smaller)).toBe(true);
      expect(larger.length).toBeGreaterThan(smaller.length);
    }
  });

  test("item order is identical in every bucket, and each bucket is a prefix of the roster", () => {
    const ids = (markdown: string) =>
      [...markdown.matchAll(/<!-- asimp:item id=([^\s]+)/g)].map((match) => match[1]);
    const full = ids(buckets[2]?.md ?? "");
    expect(full).toEqual(["MV-1", "C-12", "W-demo-fellow-03"]);
    expect(ids(buckets[0]?.md ?? "")).toEqual(full.slice(0, 1));
    expect(ids(buckets[1]?.md ?? "")).toEqual(full.slice(0, 2));
  });

  test("every bucket still states what its budget cost", () => {
    for (const bucket of buckets.slice(0, 2)) {
      expect(bucket.md).toContain("budget_exceeded");
    }
  });

  test("the post-item trailer retains cursor and optional pack metadata", () => {
    for (const bucket of buckets) {
      const trailer = trailerLine(bucket.md);
      const itemEnd = bucket.md.lastIndexOf("<!-- asimp:item-end ");
      expect(bucket.md.indexOf(trailer)).toBeGreaterThan(itemEnd);
      expect(trailer).toContain("cursor=41");
      expect(trailer).toContain(`items=${bucket.n}`);
      expect(trailer).toContain("session=SES-cache-stable");
      expect(trailer).toContain(
        `budget_tokens=${bucket.n === 1 ? 800 : bucket.n === 2 ? 1_500 : 2_500}`,
      );
      expect(trailer).toContain(`tokens_estimate=${320 + bucket.n * 180}`);
      expect(trailer).toMatch(/fingerprint=fnv1a64:[0-9a-f]{16}/);
      expect(bucket.md).toContain("tokens=160");
    }
  });

  test("re-rendering one bucket is byte-identical, bucket by bucket", () => {
    for (const bucket of buckets) {
      expect(renderProjection(budgetBucket(bucket.n), "md").body).toBe(bucket.md);
    }
  });

  test("the opening header retains cursor but none of the budget-varying fields", () => {
    for (const bucket of buckets) {
      const header = bucket.md.split("\n")[0] ?? "";
      expect(header).toContain("cursor=41");
      expect(header).not.toContain("items=");
      expect(header).not.toContain("omitted=");
      expect(header).not.toContain("fingerprint=");
      expect(header).not.toContain("budget_tokens=");
      expect(header).not.toContain("tokens_estimate=");
    }
  });
});

describe("determinism across process restarts", () => {
  /** Render in a *fresh* interpreter and hand back the bytes it produced. */
  function renderInNewProcess(format: string, items: number): string {
    const source = `
      const { renderProjection } = await import(${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)});
      const { safeWorkingPack } = await import(${JSON.stringify(new URL("../_support/fixtures.ts", import.meta.url).href)});
      const pack = safeWorkingPack();
      const dropped = pack.items.length - ${items};
      const projection = {
        ...pack,
        items: pack.items.slice(0, ${items}).map((item, index) => ({ ...item, tokens: 160 + index * 20 })),
        omitted: dropped > 0
          ? [...pack.omitted, { reason: "budget_exceeded", detail: dropped + " further item(s)" }]
          : pack.omitted,
        session: "SES-cache-stable",
        budget_tokens: ${items} === 1 ? 800 : ${items} === 2 ? 1500 : 2500,
        tokens_estimate: 320 + ${items} * 180,
      };
      process.stdout.write(renderProjection(projection, ${JSON.stringify(format)}).body);
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", source],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitCode !== 0 || stdout.length === 0) {
      throw new Error(
        `child render failed (exit ${child.exitCode}): stderr=${stderr} stdout=${stdout}`,
      );
    }
    return stdout;
  }

  for (const format of ["md", "json", "html-fragment"] as const) {
    test(`the ${format} face is byte-identical in a fresh process`, () => {
      const inProcess = renderProjection(budgetBucket(3), format).body;
      const fresh = renderInNewProcess(format, 3);
      expect(fresh).toBe(inProcess);
    });
  }

  test("two independent fresh processes agree with each other", () => {
    expect(renderInNewProcess("md", 2)).toBe(renderInNewProcess("md", 2));
  });

  test("the fingerprint is a function of content, not of process state", () => {
    const fingerprintOf = (markdown: string) =>
      /fingerprint=(fnv1a64:[0-9a-f]+)/.exec(markdown)?.[1];
    expect(fingerprintOf(renderInNewProcess("md", 3))).toBe(
      fingerprintOf(renderProjection(budgetBucket(3), "md").body),
    );
    // …and a different bucket is a different fingerprint, so the check above is not vacuous.
    expect(fingerprintOf(renderInNewProcess("md", 2))).not.toBe(
      fingerprintOf(renderInNewProcess("md", 3)),
    );
  });
});

/**
 * The literal §16.2 criterion, through the real seam.
 *
 * Everything above composes its projection by hand and hands it to `renderProjection`. That
 * proves the renderer is deterministic, which is necessary but is not the sentence the plan
 * commits to. This block composes through `composePack` — the seam the product actually uses
 * — from two *independently allocated* inputs, so byte-equality cannot come from having
 * accidentally composed one shared object twice. The changed-cursor control is what makes the
 * equality assertion falsifiable rather than decorative.
 */
describe("Fable §16.2: two orient packs at the same cursor byte-compare", () => {
  const ORIENT_CURSOR = 41;

  function orientCandidate(
    id: string,
    stablePrefix: number,
    tokens: number,
    overrides: Partial<PackCandidate> = {},
  ): PackCandidate {
    return {
      kind: id.startsWith("S-") ? "statement" : "claim",
      id,
      scope: "ledger",
      tokens,
      untrusted: true,
      body: `body for ${id}`,
      why_included: `included ${id}`,
      stable_prefix: stablePrefix,
      ...overrides,
    };
  }

  /** A fresh object graph on every call: no identity shared between the packs compared below. */
  function orientInput(overrides: Partial<PackComposerInput> = {}): PackComposerInput {
    return {
      schema: "asimposium.pack.v1",
      session: "SES-orient",
      problem: "bounded-sums",
      profile: "orient",
      cursor: ORIENT_CURSOR,
      requested_max_tokens: 1_500,
      viewer: {
        audience: "session",
        membership: "contributor",
        effective_permissions: ["workshop:read"],
      },
      candidates: [
        orientCandidate("S-1", 0, 100, { kind: "statement" }),
        orientCandidate("C-1", 10, 90),
        orientCandidate("C-2", 10, 90),
      ],
      action_candidates: [
        {
          method: "GET",
          url: "/v1/sessions/SES-orient/pack?profile=orient",
          why: "refresh the pack",
          public_read: false,
        },
      ],
      ...overrides,
    };
  }

  test("two independently allocated orient packs at the same cursor are byte-identical", () => {
    const first = composePack(orientInput());
    const second = composePack(orientInput());

    // The criterion names a profile and a cursor. Assert both rather than assume them, so a
    // future default change cannot quietly turn this into a different comparison.
    expect(first.profile).toBe("orient");
    expect(second.profile).toBe("orient");
    expect(first.cursor).toBe(ORIENT_CURSOR);
    expect(second.cursor).toBe(ORIENT_CURSOR);

    expect(first.canonical_json.length).toBeGreaterThan(0);
    expect(second.canonical_json).toBe(first.canonical_json);
    expect(second.canonical_fingerprint).toBe(first.canonical_fingerprint);
  });

  test("CONTROL: a changed cursor changes the bytes, so the equality above is falsifiable", () => {
    const atCursor = composePack(orientInput());
    const atNextCursor = composePack(orientInput({ cursor: ORIENT_CURSOR + 1 }));

    expect(atNextCursor.cursor).toBe(ORIENT_CURSOR + 1);
    expect(atNextCursor.canonical_json).not.toBe(atCursor.canonical_json);
  });
});
