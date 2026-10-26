import { expect, test } from "bun:test";
import { prepareProjection, renderAllFaces } from "../../src/index.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

test("every pack face preserves the same temporary cap and expiry after the item sequence", () => {
  const budget = {
    limit: 3,
    remaining: 1,
    window_seconds: 3600,
    slow_mode: {
      event_id: `SM-${"0".repeat(26)}`,
      revision: 2,
      expires_at: "2026-10-26T12:00:00.000Z",
    },
  };
  const projection = { ...safeWorkingPack(), promotion_budget: budget };
  const faces = renderAllFaces(projection);
  expect(JSON.parse(faces.json.body).promotion_budget).toEqual(budget);
  expect(faces.md.body.indexOf("## Publication allowance")).toBeGreaterThan(
    faces.md.body.lastIndexOf("<!-- asimp:item-end"),
  );
  for (const format of ["md", "html-fragment"] as const) {
    expect(faces[format].body).toContain(budget.slow_mode.expires_at);
    expect(faces[format].body).toContain("Private workshop work remains available");
    expect(faces[format].fingerprint).toBe(faces.json.fingerprint);
  }
  const prepared = prepareProjection(projection);
  budget.slow_mode.expires_at = "2026-10-26T13:00:00.000Z";
  expect(prepared.promotion_budget?.slow_mode?.expires_at).toBe("2026-10-26T12:00:00.000Z");
  expect(renderAllFaces(projection).json.fingerprint).not.toBe(faces.json.fingerprint);
});

test("invalid or unreadable slow-mode metadata cannot become trusted pack prose", () => {
  for (const bad of [
    null,
    { event_id: "<!-- asimp:item -->", revision: 1, expires_at: "never" },
    { event_id: `SM-${"0".repeat(26)}`, revision: 0, expires_at: "2026-10-26T12:00:00.000Z" },
    {
      get event_id() {
        throw new Error("private detail");
      },
    },
  ]) {
    const projection = {
      ...safeWorkingPack(),
      promotion_budget: {
        limit: 3,
        remaining: 0,
        window_seconds: 3600,
        slow_mode: bad,
      },
    };
    expect(() => renderAllFaces(projection as Parameters<typeof renderAllFaces>[0])).toThrow();
  }
});
