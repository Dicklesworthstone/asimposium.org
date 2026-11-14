import { expect, test } from "bun:test";
import { SponsorWorkshopViewSchema } from "@asimposium/contracts";
import { loadWorkshopRevisionPage, workshopRevisionHref } from "../../lib/workshop-page";

const sponsor = "usr_history_reader";
const fellow = "fellow-01JXYZ";
const problem = "P-4DSP";
const workshop = `W-${"B".repeat(26)}`;
const privateBody = "Private earlier work, preserved after a later edit.";
const view = (version = 2, currentVersion = 3) =>
  SponsorWorkshopViewSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    fellow_id: fellow,
    problem_id: problem,
    objects: [
      {
        workshop_id: workshop,
        type: "claim-draft",
        title: "Earlier boundary case",
        body_md: privateBody,
        relates_to: ["C-1"],
        workshop_seq: 8,
        created_at: "2026-11-14T12:00:00.000Z",
        version,
        current_version: currentVersion,
        state: "discarded",
      },
    ],
    has_more: false,
    next_cursor: null,
  });

test("history is pinned, includes discarded work and navigates stored versions without writes", async () => {
  const calls: unknown[] = [];
  const page = await loadWorkshopRevisionPage(
    sponsor,
    fellow,
    problem,
    workshop,
    "2",
    async (id, request) => {
      calls.push({ id, request });
      return { ok: true, data: view() };
    },
  );
  expect(calls).toEqual([
    {
      id: sponsor,
      request: {
        fellow_id: fellow,
        problem_id: problem,
        object: { workshop_id: workshop, version: 2 },
      },
    },
  ]);
  expect(page.status).toBe("ready");
  if (page.status !== "ready") throw new Error("History unavailable");
  expect(page.object.body_md).toBe(privateBody);
  expect(page.object.state).toBe("discarded");
  expect(page.workshopHref).toBe(
    `/console/workshop/${fellow}/${problem}?before_workshop_seq=9#${workshop}`,
  );
  expect(page.previousHref).toBe(workshopRevisionHref(fellow, problem, workshop, 1));
  expect(page.nextHref).toBe(workshopRevisionHref(fellow, problem, workshop, 3));
  expect(page.nextHref).toBe(page.currentHref);
  for (const [version, currentVersion, previous, next] of [
    [1, 3, null, workshopRevisionHref(fellow, problem, workshop, 2)],
    [3, 3, workshopRevisionHref(fellow, problem, workshop, 2), null],
  ] as const) {
    const boundary = await loadWorkshopRevisionPage(
      sponsor,
      fellow,
      problem,
      workshop,
      String(version),
      async () => ({
        ok: true,
        data: view(version, currentVersion),
      }),
    );
    expect(boundary).toMatchObject({ status: "ready", previousHref: previous, nextHref: next });
  }
});

test("invalid or anonymous history links never request private bytes", async () => {
  let calls = 0;
  const read: Parameters<typeof loadWorkshopRevisionPage>[5] = async () => {
    calls += 1;
    return { ok: true, data: view() };
  };
  expect(await loadWorkshopRevisionPage(undefined, fellow, problem, workshop, "2", read)).toEqual({
    status: "sign-in",
  });
  for (const version of [
    undefined,
    "",
    "0",
    "-1",
    "01",
    "1e2",
    "1.5",
    "9007199254740992",
    ["1", "2"],
  ]) {
    expect(
      await loadWorkshopRevisionPage(sponsor, fellow, problem, workshop, version, read),
    ).toEqual({ status: "invalid" });
  }
  expect(await loadWorkshopRevisionPage(sponsor, fellow, problem, "../foreign", "2", read)).toEqual(
    { status: "invalid" },
  );
  expect(calls).toBe(0);
});

test("a substituted head, wrong scope, malformed response or upstream error exposes no history", async () => {
  const object = view().objects[0];
  if (object === undefined) throw new Error("Missing history fixture");
  for (const value of [
    view(3),
    view(2, 1),
    { ...view(), problem_id: "P-OTHER" },
    { ...view(), fellow_id: "fellow-other" },
    { ...view(), objects: [] },
    { ...view(), objects: [object, object] },
    { ...view(), has_more: true, next_cursor: 8 },
    { ...view(), objects: [{ ...object, workshop_id: `W-${"C".repeat(26)}` }] },
  ]) {
    expect(
      await loadWorkshopRevisionPage(sponsor, fellow, problem, workshop, "2", async () => ({
        ok: true,
        data: value,
      })),
    ).toEqual({ status: "unavailable" });
  }
  expect(
    await loadWorkshopRevisionPage(sponsor, fellow, problem, workshop, "2", async () => {
      throw new Error(privateBody);
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    await loadWorkshopRevisionPage(sponsor, fellow, problem, workshop, "2", async () => ({
      ok: false,
      reason: "unreachable",
    })),
  ).toEqual({ status: "unavailable" });
});
