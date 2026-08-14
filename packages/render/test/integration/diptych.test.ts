import { describe, expect, test } from "bun:test";

import { renderAllFaces, renderProjection } from "../../src/render.ts";
import type { Projection } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

/**
 * Rule A1: every public resource has a human face and an agent face rendered
 * from *one* projection, and disagreement between them is a bug. These tests
 * are the mechanical form of that rule at the renderer level: one safe
 * projection in, three faces out, and the faces have to agree about what they
 * contain.
 *
 * The wider S-5 Diptych gate (golden face snapshots over real ledger objects,
 * pack determinism proven end-to-end against the Worker) is a separate spike;
 * this suite covers the renderer only.
 */

interface JsonFace {
  schema: string;
  face: string;
  kind: string;
  problem: string;
  profile: string;
  cursor: number;
  fingerprint: string;
  title: string;
  preamble: string;
  items: {
    id: string;
    kind: string;
    scope: string;
    untrusted: boolean;
    body: string;
    why_included: string;
  }[];
  omitted: { reason: string; detail?: string }[];
  next_actions: { method: string; url: string; why: string }[];
  degraded: string[];
}

function markdownItemIds(markdown: string): string[] {
  return [...markdown.matchAll(/^<!-- asimp:item id=(\S+) /gm)].map((match) => match[1] as string);
}

function htmlItemIds(html: string): string[] {
  return [...html.matchAll(/<li class="asimp-item" data-id="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

describe("one projection, three faces", () => {
  const projection = safeWorkingPack();
  const faces = renderAllFaces(projection);

  test("every face is non-empty and declares its media type", () => {
    expect(faces.md.media_type).toBe("text/markdown; charset=utf-8");
    expect(faces.json.media_type).toBe("application/json; charset=utf-8");
    expect(faces["html-fragment"].media_type).toBe("text/html; charset=utf-8");
    for (const face of Object.values(faces)) {
      expect(face.body.length).toBeGreaterThan(0);
      expect(face.bytes).toBe(new TextEncoder().encode(face.body).length);
    }
  });

  test("all three faces carry the same fingerprint", () => {
    expect(faces.json.fingerprint).toBe(faces.md.fingerprint);
    expect(faces["html-fragment"].fingerprint).toBe(faces.md.fingerprint);
    expect(faces.md.fingerprint).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  test("all three faces carry the same items in the same order", () => {
    const json = JSON.parse(faces.json.body) as JsonFace;
    const expected = projection.items.map((item) => item.id);
    expect(json.items.map((item) => item.id)).toEqual(expected);
    expect(markdownItemIds(faces.md.body)).toEqual(expected);
    expect(htmlItemIds(faces["html-fragment"].body)).toEqual(expected);
  });

  test("all three faces agree about which items are untrusted", () => {
    const json = JSON.parse(faces.json.body) as JsonFace;
    for (const item of json.items) {
      const untrusted = projection.items.find((candidate) => candidate.id === item.id)?.untrusted;
      expect(item.untrusted).toBe(untrusted as boolean);
      expect(faces.md.body).toContain(
        `<!-- asimp:item id=${item.id} kind=${item.kind} scope=${item.scope} untrusted=${item.untrusted} -->`,
      );
      expect(faces["html-fragment"].body).toContain(
        `data-id="${item.id}" data-kind="${item.kind}" data-scope="${item.scope}" data-untrusted="${item.untrusted}"`,
      );
    }
  });

  test("the mandatory omitted[] survives onto every face", () => {
    const json = JSON.parse(faces.json.body) as JsonFace;
    expect(json.omitted).toEqual([
      { reason: "budget_exceeded", detail: "4 further open claims beyond the 4,000-token budget" },
      {
        reason: "p12_review_isolation",
        detail: "author workshop excluded from review-shaped items",
      },
    ]);
    expect(faces.md.body).toContain("## Omitted");
    expect(faces.md.body).toContain("- budget_exceeded — 4 further open claims");
    expect(faces["html-fragment"].body).toContain("<li>budget_exceeded — 4 further open claims");
  });

  test("server-authored next_actions appear on every face and nowhere in a body", () => {
    const json = JSON.parse(faces.json.body) as JsonFace;
    expect(json.next_actions).toEqual([
      {
        method: "POST",
        url: "/v1/sessions/SES-demo/workshop",
        why: "record the k = 3 attempt before promoting anything",
      },
    ]);
    expect(faces.md.body).toContain("## Next actions (server-authored)");
    expect(faces.md.body).toContain("`POST /v1/sessions/SES-demo/workshop`");
    expect(faces["html-fragment"].body).toContain("Next actions (server-authored)");
    for (const item of json.items) {
      expect(item.body).not.toContain("next_actions");
    }
  });

  test("an empty omitted[] is still stated rather than dropped", () => {
    const emptyOmission: Projection = { ...safeWorkingPack(), omitted: [] };
    const rendered = renderAllFaces(emptyOmission);
    expect(rendered.md.body).toContain("## Omitted\n\n_none_");
    expect(rendered["html-fragment"].body).toContain("<li>none</li>");
    expect((JSON.parse(rendered.json.body) as JsonFace).omitted).toEqual([]);
  });

  test("degraded diagnostics are labelled and never mixed into an item body", () => {
    const degraded: Projection = {
      ...safeWorkingPack(),
      degraded: ["screening: deterministic fallback"],
    };
    const rendered = renderAllFaces(degraded);
    expect(rendered.md.body).toContain("## Degraded\n\n- screening: deterministic fallback");
    expect(rendered["html-fragment"].body).toContain("<li>screening: deterministic fallback</li>");
    const json = JSON.parse(rendered.json.body) as JsonFace;
    expect(json.degraded).toEqual(["screening: deterministic fallback"]);
    for (const item of json.items) expect(item.body).not.toContain("screening:");
  });
});

describe("determinism (Fable §7.1 axiom 7)", () => {
  test("rendering the same projection twice is byte-identical on every face", () => {
    const first = renderAllFaces(safeWorkingPack());
    const second = renderAllFaces(safeWorkingPack());
    expect(second.md.body).toBe(first.md.body);
    expect(second.json.body).toBe(first.json.body);
    expect(second["html-fragment"].body).toBe(first["html-fragment"].body);
    expect(second.md.fingerprint).toBe(first.md.fingerprint);
  });

  test("key insertion order in the composer does not change any face", () => {
    const base = safeWorkingPack();
    const reordered: Projection = {
      degraded: base.degraded,
      next_actions: base.next_actions,
      omitted: base.omitted,
      items: base.items.map((item) => ({
        why_included: item.why_included,
        body: item.body,
        untrusted: item.untrusted,
        scope: item.scope,
        id: item.id,
        kind: item.kind,
      })),
      preamble: base.preamble,
      title: base.title,
      cursor: base.cursor,
      profile: base.profile,
      problem: base.problem,
      kind: base.kind,
      schema: base.schema,
    };
    expect(renderProjection(reordered, "json").body).toBe(renderProjection(base, "json").body);
    expect(renderProjection(reordered, "md").body).toBe(renderProjection(base, "md").body);
  });

  test("a one-character change to a body changes the fingerprint on every face", () => {
    const base = safeWorkingPack();
    const edited: Projection = {
      ...base,
      items: base.items.map((item) =>
        item.id === "C-12" ? { ...item, body: item.body.replace("< 2^k", "<= 2^k") } : item,
      ),
    };
    const before = renderAllFaces(base);
    const after = renderAllFaces(edited);
    expect(after.md.fingerprint).not.toBe(before.md.fingerprint);
    expect(after.json.fingerprint).toBe(after.md.fingerprint);
    expect(after["html-fragment"].fingerprint).toBe(after.md.fingerprint);
  });
});

describe("face shape", () => {
  const faces = renderAllFaces(safeWorkingPack());

  test("the markdown face opens with a parseable control header and closes with the fingerprint", () => {
    const [header] = faces.md.body.split("\n");
    expect(header).toBe(
      `<!-- asimp face=md schema=asimposium.pack.v1 kind=pack problem=demo-bounded-sums profile=working ` +
        `cursor=41 items=3 omitted=2 fingerprint=${faces.md.fingerprint} -->`,
    );
    expect(
      faces.md.body
        .trimEnd()
        .endsWith(`<!-- asimp:face-end fingerprint=${faces.md.fingerprint} -->`),
    ).toBe(true);
  });

  test("every markdown item is opened and closed by its own delimiter", () => {
    const opens = [...faces.md.body.matchAll(/^<!-- asimp:item id=(\S+) /gm)].length;
    const closes = [...faces.md.body.matchAll(/^<!-- asimp:item-end id=(\S+) -->$/gm)].length;
    expect(opens).toBe(3);
    expect(closes).toBe(3);
  });

  test("the html face is an embeddable fragment, not a document", () => {
    const html = faces["html-fragment"].body;
    expect(html.startsWith('<section class="asimp-face"')).toBe(true);
    expect(html).not.toContain("<!doctype");
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html).not.toContain("<script");
  });

  test("the json face is parseable and self-describing", () => {
    const json = JSON.parse(faces.json.body) as JsonFace;
    expect(json.schema).toBe("asimposium.pack.v1");
    expect(json.face).toBe("json");
    expect(json.cursor).toBe(41);
    expect(json.fingerprint).toBe(faces.json.fingerprint);
  });
});
