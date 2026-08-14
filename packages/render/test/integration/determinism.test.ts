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
 *     comparison are measuring one process's hash seed rather than the projection.
 *
 * The second block records an honest limitation of the current face format. See the note.
 */

import { describe, expect, test } from "bun:test";
import { renderProjection } from "../../src/index.ts";
import type { Projection } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

/**
 * The same cursor at a smaller budget: fewer items, and the drop recorded in `omitted[]`
 * exactly as a real composer must (Fable §7.3 — an empty pack with an empty `omitted` is a
 * bug, a truncated one that says so is information).
 */
function budgetBucket(items: number): Projection {
  const pack = safeWorkingPack();
  const dropped = pack.items.length - items;
  return {
    ...pack,
    items: pack.items.slice(0, items),
    omitted:
      dropped > 0
        ? [...pack.omitted, { reason: "budget_exceeded", detail: `${dropped} further item(s)` }]
        : pack.omitted,
  };
}

/** The item region of a markdown face: everything the prompt cache would reuse. */
function itemRegion(markdown: string): string {
  const start = markdown.indexOf("## Items\n");
  const end = markdown.indexOf("## Omitted\n");
  return markdown.slice(start, end);
}

describe("stable-prefix ordering across budget buckets", () => {
  const buckets = [1, 2, 3].map((n) => ({ n, md: renderProjection(budgetBucket(n), "md").body }));

  test("a larger budget extends the item region rather than reshuffling it", () => {
    for (let i = 1; i < buckets.length; i += 1) {
      const smaller = itemRegion(buckets[i - 1]?.md ?? "");
      const larger = itemRegion(buckets[i]?.md ?? "");
      expect(larger.startsWith(smaller.trimEnd())).toBe(true);
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

  test("re-rendering one bucket is byte-identical, bucket by bucket", () => {
    for (const bucket of buckets) {
      expect(renderProjection(budgetBucket(bucket.n), "md").body).toBe(bucket.md);
    }
  });

  /**
   * Honest limitation, recorded rather than asserted away. The face *header* carries
   * `items=`, `omitted=` and the content fingerprint, so two buckets share no byte prefix
   * from position zero — only the item region is stable. A harness caching on a raw prefix
   * of the whole face therefore gets no hit across budgets. Moving the volatile counters
   * behind the stable envelope would fix it, but that is a face-format change with golden
   * and Worker consequences, so it is reported, not smuggled in here.
   */
  test("the whole face is NOT prefix-stable: the shared prefix dies inside the header", () => {
    const small = buckets[0]?.md ?? "";
    const large = buckets[2]?.md ?? "";

    let shared = 0;
    while (shared < Math.min(small.length, large.length) && small[shared] === large[shared]) {
      shared += 1;
    }

    // The two faces agree until the header's `items=` counter and diverge there, which is
    // well before the item region — the expensive part a prompt cache would want to reuse.
    expect(small.slice(shared - 6, shared)).toBe("items=");
    expect(shared).toBeLessThan(large.indexOf("## Items"));
    expect(large.startsWith(small.slice(0, shared + 1))).toBe(false);
    expect((small.split("\n")[0] ?? "").includes("items=1")).toBe(true);
    expect((large.split("\n")[0] ?? "").includes("items=3")).toBe(true);
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
        items: pack.items.slice(0, ${items}),
        omitted: dropped > 0
          ? [...pack.omitted, { reason: "budget_exceeded", detail: dropped + " further item(s)" }]
          : pack.omitted,
      };
      process.stdout.write(renderProjection(projection, ${JSON.stringify(format)}).body);
    `;
    const child = Bun.spawnSync({ cmd: ["bun", "-e", source], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitCode !== 0) throw new Error(`child render failed: ${stderr}`);
    return new TextDecoder().decode(child.stdout);
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
