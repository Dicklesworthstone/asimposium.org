/**
 * Checked-in golden faces (bead asimposiumorg-6jo, S-5).
 *
 * The other suites assert *properties* of a face: that ids appear, that a fence cannot be
 * closed, that the three faces agree. Properties cannot catch a change nobody asserted —
 * a reordered section, a dropped provenance line, a header field that quietly disappeared.
 * These goldens are the byte-level backstop, and they exist precisely to fail when a face
 * changes.
 *
 * There is deliberately no update mode. No environment variable rewrites these files, and
 * no test writes to `test/golden/`. Regenerating a golden to make a red suite green is the
 * self-deal Fable §17.0 names, and a harness that offers a one-flag way to do it will
 * eventually be used that way. When a face legitimately changes, the author regenerates by
 * hand (`bun run golden:print > test/golden/<name>`), *reads the diff*, and lands it as its
 * own reviewable change — which is exactly the gate-diff discipline the doctrine asks for.
 */

import { describe, expect, test } from "bun:test";
import { renderAllFaces, renderProjection } from "../../src/index.ts";
import type { FaceFormat } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

const GOLDEN: Readonly<Record<FaceFormat, string>> = {
  md: "working-pack.md",
  json: "working-pack.json",
  "html-fragment": "working-pack.html",
};

async function readGolden(name: string): Promise<string> {
  return await Bun.file(new URL(`../golden/${name}`, import.meta.url)).text();
}

describe("golden faces detect drift", () => {
  for (const [format, name] of Object.entries(GOLDEN) as [FaceFormat, string][]) {
    test(`the ${format} face is byte-identical to test/golden/${name}`, async () => {
      const rendered = renderProjection(safeWorkingPack(), format).body;
      const golden = await readGolden(name);

      if (rendered !== golden) {
        // Point at the first differing line rather than dumping two faces into the log.
        const renderedLines = rendered.split("\n");
        const goldenLines = golden.split("\n");
        const at = renderedLines.findIndex((line, index) => line !== goldenLines[index]);
        throw new Error(
          `The ${format} face no longer matches test/golden/${name} at line ${at + 1}.\n` +
            `  golden:   ${JSON.stringify(goldenLines[at] ?? "<end of file>")}\n` +
            `  rendered: ${JSON.stringify(renderedLines[at] ?? "<end of file>")}\n` +
            "If the change is intended, regenerate by hand, read the diff, and land it as its " +
            "own change. Do not regenerate a golden to turn a red suite green.",
        );
      }
      expect(rendered).toBe(golden);
    });
  }

  test("the goldens are substantial, so an emptied file cannot pass silently", async () => {
    for (const name of Object.values(GOLDEN)) {
      const golden = await readGolden(name);
      expect(golden.length).toBeGreaterThan(500);
      expect(golden.endsWith("\n")).toBe(true);
    }
  });

  test("each golden carries the marks that make it worth freezing", async () => {
    const md = await readGolden(GOLDEN.md);
    // The header an agent paginates on (Fable §7.7), the item delimiters, the mandatory
    // omissions, and the server-authored next_actions.
    expect(md.startsWith("<!-- asimp face=md schema=asimposium.pack.v1")).toBe(true);
    expect(md).toContain("cursor=41");
    expect(md).toContain("<!-- asimp:item id=C-12");
    expect(md).toContain("## Omitted");
    expect(md).toContain("budget_exceeded");
    expect(md).toContain("## Next actions (server-authored)");
    expect(md.trimEnd().endsWith("-->")).toBe(true);

    const json = JSON.parse(await readGolden(GOLDEN.json)) as {
      cursor: number;
      items: { id: string; scope: string; untrusted: boolean }[];
      omitted: unknown[];
    };
    expect(json.cursor).toBe(41);
    expect(json.items.map((item) => item.id)).toEqual(["MV-1", "C-12", "W-demo-fellow-03"]);
    expect(json.omitted).toHaveLength(2);

    const html = await readGolden(GOLDEN["html-fragment"]);
    expect(html.startsWith('<section class="asimp-face"')).toBe(true);
    expect(html).toContain('data-cursor="41"');
    expect(html).not.toContain("<html");
  });

  test("a golden is frozen against the projection, not against itself", () => {
    // If the fixture changed, the goldens must fail rather than track it silently. One
    // byte of drift in the source projection has to move the fingerprint on every face.
    const pack = safeWorkingPack();
    const drifted = {
      ...pack,
      items: pack.items.map((item, index) =>
        index === 1 ? { ...item, body: `${item.body} ` } : item,
      ),
    };
    const faces = renderAllFaces(drifted);
    const original = renderAllFaces(pack);
    for (const format of Object.keys(GOLDEN) as FaceFormat[]) {
      expect(faces[format].fingerprint).not.toBe(original[format].fingerprint);
      expect(faces[format].body).not.toBe(original[format].body);
    }
  });
});
