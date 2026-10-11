import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { COMMENTARY_SCHEMA_ID, type CommentaryItem } from "@asimposium/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  commentaryCursorFromQuery,
  commentaryPageHref,
  publicCommentaryHref,
} from "../../lib/commentary-page";

mock.module("server-only", () => ({}));

const SPONSOR = "usr_commentary_reader";
const PROBLEM = "P-4DSP";
const ITEM: CommentaryItem = {
  schema: COMMENTARY_SCHEMA_ID,
  commentary_id: "COMM-0123456789abcdef",
  problem_id: PROBLEM,
  seq: 41,
  sponsor_id: SPONSOR,
  body: "<script>COMMENTARY_INJECTION</script>",
  relates_to: [{ kind: "claim", id: "C-1", label: "Boundary case" }],
  supersedes_commentary_id: null,
  superseded_by_commentary_id: null,
  tombstoned: false,
  tombstone_reason: null,
  created_at: "2026-10-11T12:00:00.000Z",
  updated_at: "2026-10-11T12:00:00.000Z",
};

test("commentary navigation rejects ambiguous cursors and links the exact record after earlier pages fill", () => {
  expect(commentaryCursorFromQuery(undefined)).toBe(0);
  expect(commentaryCursorFromQuery("0")).toBe(0);
  expect(commentaryCursorFromQuery("50")).toBe(50);
  for (const invalid of ["", "-1", "01", "1e3", "1.5", "9007199254740992", ["1", "2"]]) {
    expect(commentaryCursorFromQuery(invalid)).toBeUndefined();
  }
  expect(commentaryPageHref(PROBLEM, 40)).toBe("/console/commentary/P-4DSP?cursor=40");
  expect(publicCommentaryHref(PROBLEM, ITEM)).toBe(
    "/p/P-4DSP?commentary_cursor=40#commentary-COMM-0123456789abcdef",
  );
});

describe("commentary console visibility and edit targets", () => {
  let realStoa: typeof import("../../lib/stoa");
  let realAuth: typeof import("../../auth");
  let realPublic: typeof import("../../lib/public-ledger");
  let realEditor: typeof import("../../app/console/commentary-editor");
  let page: typeof import("../../app/console/commentary/[problem]/page").default;
  let sponsor: string | undefined = SPONSOR;
  let faceState = "ok";
  let faceProblem = PROBLEM;
  let bootstrapSponsor = SPONSOR;
  let items: CommentaryItem[] = [];
  let hasMore = false;
  const reads: { name: string; query?: unknown }[] = [];

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa")) };
    realAuth = { ...(await import("../../auth")) };
    realPublic = { ...(await import("../../lib/public-ledger")) };
    realEditor = { ...(await import("../../app/console/commentary-editor")) };
    mock.module("@/auth", () => ({
      ...realAuth,
      auth: async () => (sponsor === undefined ? null : { user: { id: sponsor } }),
    }));
    mock.module("@/lib/stoa", () => ({
      ...realStoa,
      stoaBootstrapSponsor: async () => {
        reads.push({ name: "bootstrap" });
        return {
          ok: true,
          data: { sponsor_id: bootstrapSponsor, created: true, bootstrapped_at: 1 },
        };
      },
    }));
    mock.module("@/lib/public-ledger", () => ({
      ...realPublic,
      stoaFetchProblemFace: async () => {
        reads.push({ name: "face" });
        return {
          state: faceState,
          data: { problem: faceProblem, title: "Public boundary problem", items: [], cursor: 80 },
        };
      },
      stoaFetchCommentary: async (_problem: string, _origin: string, query: unknown) => {
        reads.push({ name: "commentary", query });
        return {
          state: "ok",
          data: {
            schema: COMMENTARY_SCHEMA_ID,
            problem_id: PROBLEM,
            commentaries: items,
            cursor: items.at(-1)?.seq ?? 0,
            has_more: hasMore,
            omitted: [],
          },
        };
      },
    }));
    // The page owns authorization and immutable target selection. Actual form
    // interaction is exercised by the local Next/Chromium product lane.
    mock.module("@/app/console/commentary-editor", () => ({
      ...realEditor,
      CommentaryEditor: (props: { sponsorId: string; problemId: string; item?: CommentaryItem }) =>
        createElement("div", {
          className: "editor-target",
          "data-owner": props.sponsorId,
          "data-problem": props.problemId,
          "data-item": props.item?.commentary_id ?? "new",
        }),
    }));
    const specifier: string =
      "../../app/console/commentary/[problem]/page.tsx?hermetic-commentary-page";
    page = (await import(specifier)).default;
  });

  beforeEach(() => {
    sponsor = SPONSOR;
    faceState = "ok";
    faceProblem = PROBLEM;
    bootstrapSponsor = SPONSOR;
    items = [ITEM];
    hasMore = false;
    reads.length = 0;
  });

  afterAll(() => {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("@/lib/public-ledger", () => realPublic);
    mock.module("@/auth", () => realAuth);
    mock.module("@/app/console/commentary-editor", () => realEditor);
  });

  const render = async (cursor?: string | string[]) =>
    renderToStaticMarkup(
      await page({
        params: Promise.resolve({ problem: PROBLEM }),
        searchParams: Promise.resolve({ cursor }),
      }),
    );

  test("anonymous visitors get sign-in without reading or creating a sponsor account", async () => {
    sponsor = undefined;
    const html = await render();
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("COMMENTARY_INJECTION");
    expect(html).not.toContain("editor-target");
    expect(reads).toEqual([]);
  });

  test("only the confirmed current sponsor's immutable entries receive edit controls", async () => {
    items.push({
      ...ITEM,
      commentary_id: "COMM-abcdef0123456789",
      sponsor_id: "usr_other",
      seq: 42,
    });
    const html = await render("40");
    expect(html).toContain("&lt;script&gt;COMMENTARY_INJECTION&lt;/script&gt;");
    expect(html).not.toContain("<script>COMMENTARY_INJECTION");
    expect(html).toContain(`data-item="${ITEM.commentary_id}"`);
    expect(html).not.toContain('data-item="COMM-abcdef0123456789"');
    expect(html).toContain('data-item="new"');
    expect(reads).toContainEqual({ name: "commentary", query: { cursor: 40, limit: 20 } });
    expect(html).toContain("First commentary page");
  });

  test("an unconfirmed public problem never reveals discussion bytes or renders a composer", async () => {
    faceProblem = "P-OTHER";
    let html = await render();
    expect(html).not.toContain("COMMENTARY_INJECTION");
    expect(html).not.toContain("editor-target");
    faceProblem = PROBLEM;
    faceState = "unavailable";
    html = await render();
    expect(html).not.toContain("COMMENTARY_INJECTION");
    expect(html).not.toContain("editor-target");
    faceState = "not_found";
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  test("an account mismatch or ambiguous cursor prevents posting and preserves recovery", async () => {
    bootstrapSponsor = "usr_other";
    expect(await render()).not.toContain("editor-target");
    bootstrapSponsor = SPONSOR;
    const html = await render(["40", "80"]);
    expect(html).toContain("discussion page link is invalid");
    expect(html).toContain("Open the first page");
    expect(html).not.toContain("editor-target");
  });
});
