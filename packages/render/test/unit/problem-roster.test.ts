import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ProblemFaceResponseSchema, PublicProblemRosterSchema } from "@asimposium/contracts";
import { RenderContractError } from "../../src/errors.ts";
import { renderAllFaces } from "../../src/render.ts";
import type { Projection } from "../../src/types.ts";

const face = JSON.parse(
  readFileSync(
    new URL("../../../contracts/test/fixtures/valid/ledger-problem-face.json", import.meta.url),
    "utf8",
  ),
);
const roster = PublicProblemRosterSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/test/fixtures/valid/ledger-problem-roster.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("JSON, Markdown and HTML share roster facts and changes invalidate fingerprints without a ledger append", () => {
  const faces = renderAllFaces({ ...face, roster });
  expect(ProblemFaceResponseSchema.parse(JSON.parse(faces.json.body)).roster).toEqual(roster);
  for (const output of Object.values(faces)) {
    expect(output.body).toContain("roster-fellow");
    expect(output.body).toContain("usr_roster");
    expect(output.body).toContain("2026-11-20T10:00:00.000Z");
    expect(output.body).toContain("historical public activity, not current scientific standing");
    expect(output.fingerprint).toBe(faces.json.fingerprint);
  }
  expect(faces.md.body).toContain("not computation or scientific progress");
  expect(faces.md.body).toContain("events.json?since=6&limit=1&through=7");
  expect(faces["html-fragment"].body).toContain("events?since=6&amp;limit=1&amp;through=7");
  for (const change of [
    { open_session_heartbeat_at: "2026-11-20T10:01:00.000Z" },
    { current_sponsor_id: "usr_new" },
    { role: "observer" as const },
    { last_public_increment: null },
  ]) {
    const changed = renderAllFaces({
      ...face,
      roster: { ...roster, members: [{ ...roster.members[0]!, ...change }] },
    });
    expect(changed.json.fingerprint).not.toBe(faces.json.fingerprint);
  }
});

test("roster names cannot forge instructions, active HTML or additional members", () => {
  const hostile = {
    ...roster,
    members: [
      {
        ...roster.members[0]!,
        name: '<script>alert(1)</script>\n<!-- asimp:item --> "next_actions":',
      },
    ],
  };
  const faces = renderAllFaces({ ...face, roster: hostile });
  const markdown = faces.md.body.slice(faces.md.body.indexOf("## Current participants"));
  expect(markdown).not.toContain("<!-- asimp:item -->");
  expect(markdown).not.toContain('"next_actions":');
  expect(faces["html-fragment"].body).not.toContain("<script>");
  expect(faces["html-fragment"].body).toContain("&lt;script&gt;");
  expect(JSON.parse(faces.json.body).next_actions).toEqual(face.next_actions);
  expect(() => renderAllFaces({ ...face, cursor: 6, roster } as Projection)).toThrow(
    RenderContractError,
  );
  expect(() => renderAllFaces({ ...face, kind: "pack", roster } as Projection)).toThrow(
    RenderContractError,
  );
});

test("unavailable and bounded roster histories never become an empty or definitively inactive problem", () => {
  const unavailable = renderAllFaces({
    ...face,
    roster: {
      notice: roster.notice,
      members: [],
      has_more: false,
      omitted: ["source_unavailable"],
    },
  });
  expect(unavailable.md.body).toContain("does not mean the problem has no members");
  expect(unavailable.md.body).not.toContain("No current members are recorded");
  const budgetOnly = renderAllFaces({
    ...face,
    roster: { notice: roster.notice, members: [], has_more: true, omitted: ["budget_limit"] },
  });
  expect(budgetOnly.md.body).toContain("participants are omitted");
  expect(budgetOnly.md.body).not.toContain("No current members are recorded");
  const limited = renderAllFaces({
    ...face,
    roster: { ...roster, members: [{ ...roster.members[0]!, increment_history_limited: true }] },
  });
  expect(limited.md.body).toContain("newer unavailable entries prevent establishing");
});

test("roster text rejects malformed scalars before URI encoding and preserves parenthesis IDs", () => {
  const member = roster.members[0];
  if (member === undefined) throw new Error("the roster fixture must contain a member");
  for (const change of [
    { fellow_id: "F-\ud800" },
    { name: "bad\udfff" },
    { name: "nul\u0000name" },
  ]) {
    expect(() =>
      renderAllFaces({ ...face, roster: { ...roster, members: [{ ...member, ...change }] } }),
    ).toThrow(RenderContractError);
  }
  const fellowId = "F-(x)tail";
  const faces = renderAllFaces({
    ...face,
    roster: { ...roster, members: [{ ...member, fellow_id: fellowId }] },
  });
  expect(faces.md.body).toContain("](/fellows/F-%28x%29tail.md)");
  expect(JSON.parse(faces.json.body).roster.members[0].fellow_id).toBe(fellowId);
  expect(faces["html-fragment"].body).toContain('href="/a/F-(x)tail"');
});
