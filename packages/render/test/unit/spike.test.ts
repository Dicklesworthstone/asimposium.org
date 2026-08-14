/**
 * The spike fixture is the single source both the local render and the Worker-served face
 * are built from (bead asimposiumorg-6jo). If the two variants ever stopped being two
 * selections over one item list, phase 2 would be comparing two unrelated things and
 * passing. These tests pin that relationship.
 */

import { describe, expect, test } from "bun:test";
import { renderAllFaces } from "../../src/index.ts";
import {
  isSpikeVariant,
  S5_SPIKE_CURSOR,
  S5_SPIKE_PROBLEM,
  SPIKE_VARIANTS,
  s5Canary,
  s5SpikeProjection,
} from "../../src/spike.ts";

describe("the S-5 spike fixture", () => {
  test("the canary is derived from the seed and is stable", () => {
    expect(s5Canary("s5-fixed-seed-v1")).toBe(s5Canary("s5-fixed-seed-v1"));
    expect(s5Canary("other-seed")).not.toBe(s5Canary("s5-fixed-seed-v1"));
    expect(s5Canary()).toMatch(/^S5-CANARY-[0-9a-f]{12}$/);
  });

  test("the public variant is the sponsor variant minus workshop scope", () => {
    const sponsor = s5SpikeProjection("sponsor");
    const publicPack = s5SpikeProjection("public");
    expect(sponsor.items.some((item) => item.scope === "workshop")).toBe(true);
    expect(publicPack.items.some((item) => item.scope === "workshop")).toBe(false);
    expect(publicPack.items.map((i) => i.id)).toEqual(
      sponsor.items.filter((i) => i.scope !== "workshop").map((i) => i.id),
    );
  });

  test("dropping a private item is recorded, never silent", () => {
    expect(s5SpikeProjection("public").omitted[0]?.reason).toBe("workshop_scope_excluded");
    expect(s5SpikeProjection("sponsor").omitted.length).toBeGreaterThan(0);
  });

  test("the canary reaches the sponsor faces and no public face", () => {
    const canary = s5Canary();
    const sponsor = renderAllFaces(s5SpikeProjection("sponsor"));
    const publicFaces = renderAllFaces(s5SpikeProjection("public"));
    for (const face of Object.values(sponsor)) expect(face.body).toContain(canary);
    for (const face of Object.values(publicFaces)) {
      expect(face.body).not.toContain(canary);
      expect(face.body).not.toContain("W-demo-fellow-03");
    }
  });

  test("both variants describe the same problem and cursor", () => {
    for (const variant of SPIKE_VARIANTS) {
      const pack = s5SpikeProjection(variant);
      expect(pack.problem).toBe(S5_SPIKE_PROBLEM);
      expect(pack.cursor).toBe(S5_SPIKE_CURSOR);
    }
  });

  test("the variant guard rejects anything else", () => {
    expect(isSpikeVariant("public")).toBe(true);
    expect(isSpikeVariant("sponsor")).toBe(true);
    expect(isSpikeVariant("workshop")).toBe(false);
    expect(isSpikeVariant("")).toBe(false);
  });

  test("a fixture render is deterministic, so served-vs-local comparison means something", () => {
    expect(renderAllFaces(s5SpikeProjection("public")).md.body).toBe(
      renderAllFaces(s5SpikeProjection("public")).md.body,
    );
  });
});
