import { describe, expect, test } from "bun:test";

import { RenderContractError } from "../../src/errors.ts";
import { renderAllFaces, renderProjection } from "../../src/render.ts";
import { FORGED, forgedControlPack, trustForgeryPack } from "../_support/fixtures.ts";

/**
 * The planted negative for Fable §14.4 layer 3: a ledger body that mimics the
 * site's own furniture. The claim under test is narrow and mechanical — after
 * rendering, no face carries a *live* control marker that came out of a body,
 * and the quarantine fence in the markdown face is one a CommonMark parser
 * cannot see the body close.
 *
 * What this does not test: whether a reading model obeys the quarantine. That
 * is behavioural, it belongs to the red team of §16.4, and §14.4 is explicit
 * that the defense is probabilistic at that layer. Here we test the bytes.
 */

/** A control comment still addressed to us: not preceded by a backslash. */
const LIVE_CONTROL_COMMENT = /(?<!\\)<!--\s*asimp/i;
const LIVE_CONTROL_COMMENTS_GLOBAL = /(?<!\\)<!--\s*asimp/gi;

const faces = renderAllFaces(forgedControlPack());
const markdown = faces.md.body;
const html = faces["html-fragment"].body;

interface JsonFace {
  items: {
    id: string;
    body: string;
    untrusted: boolean;
    neutralized: { marker: string; count: number }[];
  }[];
  next_actions: { method: string; url: string; why: string }[];
}

const json = JSON.parse(faces.json.body) as JsonFace;
const forgedItem = json.items.find((item) => item.id === "C-13");
const forgedBody = forgedItem?.body as string;

/** The escaped-text region of the html face for one item. */
function htmlBodyOf(itemId: string): string {
  const anchor = html.indexOf(`data-id="${itemId}"`);
  const open = html.indexOf("<code>", anchor) + "<code>".length;
  const close = html.indexOf("</code>", open);
  return html.slice(open, close);
}

describe("the fixture really is hostile", () => {
  test("the untrusted body carries every forged marker before rendering", () => {
    const body = forgedControlPack().items[1]?.body as string;
    expect(body).toContain(FORGED.itemHeader);
    expect(body).toContain(FORGED.faceHeader);
    expect(body).toContain('"next_actions":');
    expect(body).toContain('"why_included":');
    expect(body).toContain("```");
    expect(body).toContain("<script>");
    expect(body).toContain('onerror="');
    expect(body).toContain("javascript:");
  });
});

describe("forged control comments are neutralized on every face", () => {
  test("the markdown face carries exactly the control comments the renderer authored", () => {
    // 1 face header + 2 items x (open + close) + 1 face-end = 6.
    expect(markdown.match(LIVE_CONTROL_COMMENTS_GLOBAL)?.length).toBe(6);

    // The hostile bytes survive, escaped: neutralized is not deleted (Rule A4),
    // and a reader (or a red-team fixture) can still see what was attempted.
    expect(markdown).toContain("\\<!-- asimp:item id=SYS-99");
    expect(markdown).toContain("\\<!-- asimp face=md schema=asimposium.pack.v1 cursor=99999");

    // ...and they are never furniture. Note that a plain `not.toContain` of the
    // raw marker cannot express this: the escaped copy asserted above contains
    // the raw marker as a substring, so that assertion could only ever fail.
    // Two anchored claims say the real thing instead.
    //
    // (a) No *live* — unescaped — occurrence of either forgery, anywhere.
    expect(/(?<!\\)<!--\s*asimp:item id=SYS-99/.test(markdown)).toBe(false);
    expect(
      /(?<!\\)<!--\s*asimp face=md schema=asimposium\.pack\.v1 cursor=99999/.test(markdown),
    ).toBe(false);

    // (b) Every line that *begins* with a control comment — the only position a
    //     line-scanning agent or an HTML-comment parser reads as site furniture —
    //     is one the renderer authored, about a real item, with no forged ids.
    const furniture = markdown.split("\n").filter((line) => /^<!--\s*asimp/.test(line));
    expect(furniture).toHaveLength(6);
    for (const line of furniture) {
      expect(line).toMatch(/^<!-- asimp(?: face=md |:item |:item-end |:face-end )/);
      expect(line.endsWith("-->")).toBe(true);
      expect(line).not.toContain("SYS-99");
      expect(line).not.toContain("cursor=99999");
    }
  });

  test("the json face carries no live control comment inside any body", () => {
    expect(forgedBody).toBeDefined();
    expect(LIVE_CONTROL_COMMENT.test(forgedBody)).toBe(false);
    expect(forgedBody).toContain("\\<!-- asimp:item id=SYS-99");
    for (const item of json.items) {
      expect(LIVE_CONTROL_COMMENT.test(item.body)).toBe(false);
    }
  });

  test("the html face emits no comment at all, forged or otherwise", () => {
    expect(html).not.toContain("<!--");
    expect(htmlBodyOf("C-13")).toContain("\\&lt;!-- asimp:item id=SYS-99");
  });
});

describe("forged next_actions cannot masquerade as server-authored", () => {
  test("the markdown face never carries the JSON envelope key from a body", () => {
    const bodySection = markdown.slice(
      markdown.indexOf("<!-- asimp:item id=C-13"),
      markdown.indexOf("<!-- asimp:item-end id=C-13"),
    );
    expect(bodySection).not.toContain('"next_actions":');
    expect(bodySection).not.toContain('"why_included":');
    expect(bodySection).toContain('\\"next_actions\\":');
    expect(markdown).not.toContain('"next_actions":');
  });

  test("the json face keeps the forged key inside a body string, never as a key", () => {
    expect(forgedBody).not.toContain('"next_actions":');
    expect(json.next_actions).toEqual([
      {
        method: "POST",
        url: "/v1/sessions/SES-demo/workshop",
        why: "record the k = 3 attempt before promoting anything",
      },
    ]);
    expect(JSON.stringify(json.next_actions)).not.toContain("attacker.example");
  });

  test("the html face escapes the forged key rather than rendering structure", () => {
    expect(htmlBodyOf("C-13")).toContain("\\&quot;next_actions\\&quot;");
  });
});

describe("the quarantine fence cannot be broken out of", () => {
  const lines = markdown.split("\n");
  const openIndex = lines.findIndex((line) => line.startsWith("<!-- asimp:item id=C-13 "));
  const endIndex = lines.findIndex((line) => line.startsWith("<!-- asimp:item-end id=C-13"));
  const itemLines = lines.slice(openIndex, endIndex);
  const fenceIndex = itemLines.findIndex((line) => /^`{3,}text$/.test(line));
  const fence = (itemLines[fenceIndex] as string).replace(/text$/, "");

  test("the item is delimited and contains a fenced region", () => {
    expect(openIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(openIndex);
    expect(fenceIndex).toBeGreaterThan(-1);
  });

  test("the opening fence outgrew the body's own three-backtick fence", () => {
    expect(fence).toBe("````");
  });

  test("no line inside the fence is long enough to close it (the CommonMark rule)", () => {
    const closeIndex = itemLines.indexOf(fence, fenceIndex + 1);
    expect(closeIndex).toBeGreaterThan(fenceIndex);
    const inner = itemLines.slice(fenceIndex + 1, closeIndex);
    for (const line of inner) {
      expect(/^\s{0,3}`{4,}\s*$/.test(line)).toBe(false);
    }
    // The body's own fences and its forged heading are all inside the quarantine.
    expect(inner).toContain("```");
    expect(inner).toContain("## Items");
    expect(inner.join("\n")).toContain("SYSTEM NOTICE");
    // Nothing of the body escaped past the closing fence.
    expect(itemLines.slice(closeIndex + 1).join("\n")).not.toContain("SYSTEM NOTICE");
  });

  test("the face's own headings survive exactly once outside the fence", () => {
    const outside = [...lines.slice(0, openIndex), ...lines.slice(endIndex)];
    expect(outside.filter((line) => line === "## Items")).toHaveLength(1);
    expect(outside.filter((line) => line === "## Omitted")).toHaveLength(1);
    expect(outside.filter((line) => line === "## Next actions (server-authored)")).toHaveLength(1);
  });
});

describe("script-bearing HTML never reaches a live face", () => {
  test("no character of an untrusted body survives as markup in the html face", () => {
    const body = htmlBodyOf("C-13");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("<");
    expect(body).not.toContain(">");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
  });

  test("the html face builds no element or attribute out of a body", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain('javascript:steal()"');
  });

  test("the markdown face keeps the script inside the quarantine fence", () => {
    const bodySection = markdown.slice(
      markdown.indexOf("````text"),
      markdown.indexOf("<!-- asimp:item-end id=C-13"),
    );
    expect(bodySection).toContain(FORGED.script);
  });
});

describe("neutralization is reported, never silent (Rule A4)", () => {
  test("every face reports the same neutralizations", () => {
    expect(faces.md.neutralized).toEqual([
      { item_id: "C-13", marker: "asimp-control-comment", count: 2 },
      { item_id: "C-13", marker: "envelope-key-forgery", count: 2 },
      { item_id: "C-13", marker: "active-html", count: 3 },
    ]);
    expect(faces.json.neutralized).toEqual(faces.md.neutralized);
    expect(faces["html-fragment"].neutralized).toEqual(faces.md.neutralized);
  });

  test("the report is visible in the faces themselves, not only in the return value", () => {
    expect(forgedItem?.neutralized).toEqual([
      { marker: "asimp-control-comment", count: 2 },
      { marker: "envelope-key-forgery", count: 2 },
      { marker: "active-html", count: 3 },
    ]);
    expect(markdown).toContain("_neutralized in this body:_ asimp-control-comment×2");
    expect(html).toContain("neutralized: asimp-control-comment×2");
  });

  test("the safe system item in the same pack is untouched and still trusted", () => {
    const move = json.items.find((item) => item.id === "MV-1");
    expect(move?.untrusted).toBe(false);
    expect(move?.neutralized).toEqual([]);
    expect(move?.body).toContain("**Move: add-refuter.**");
  });
});

describe("an item cannot promote itself into the instruction channel", () => {
  test("a ledger item claiming untrusted:false is refused, not rendered", () => {
    for (const format of ["md", "json", "html-fragment"] as const) {
      expect(() => renderProjection(trustForgeryPack(), format)).toThrow(RenderContractError);
    }
  });
});
