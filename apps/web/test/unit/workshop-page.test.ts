import { expect, test } from "bun:test";
import { SponsorWorkshopViewSchema } from "@asimposium/contracts";

import { loadWorkshopPage, workshopPageHref } from "../../lib/workshop-page";

const fellow = "fellow-01JXYZ";
const problem = "P-4DSP";
const sponsor = "usr_workshop_reader";

function page(seqs: number[], more = false) {
  return SponsorWorkshopViewSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    fellow_id: fellow,
    problem_id: problem,
    objects: seqs.map((seq) => ({
      workshop_id: `W-${String(seq).padStart(26, "0")}`,
      type: "note",
      title: `Private note ${seq}`,
      body_md: `Private body ${seq}`,
      relates_to: [],
      workshop_seq: seq,
      created_at: "2026-09-07T00:00:00.000Z",
    })),
    has_more: more,
    next_cursor: more ? seqs.at(-1) : null,
  });
}

test("private reader exposes the complete page and follows the Worker's keyset cursor", async () => {
  const calls: unknown[] = [];
  const read: Parameters<typeof loadWorkshopPage>[4] = async (principal, request) => {
    calls.push({ principal, request });
    return {
      ok: true,
      data:
        request.before_workshop_seq === undefined
          ? page(
              Array.from({ length: 16 }, (_, index) => 20 - index),
              true,
            )
          : page([4, 3, 2, 1]),
    };
  };
  const first = await loadWorkshopPage(sponsor, fellow, problem, undefined, read);
  expect(first.status).toBe("ready");
  if (first.status !== "ready") throw new Error("First page unavailable");
  expect(first.view.objects).toHaveLength(16);
  expect(first.olderHref).toBe(`/console/workshop/${fellow}/${problem}?before_workshop_seq=5`);
  const older = await loadWorkshopPage(sponsor, fellow, problem, "5", read);
  expect(older.status).toBe("ready");
  if (older.status !== "ready") throw new Error("Older page unavailable");
  expect(older.view.objects.map((object) => object.workshop_seq)).toEqual([4, 3, 2, 1]);
  expect(older.olderHref).toBeNull();
  expect(older.newestHref).toBe(`/console/workshop/${fellow}/${problem}`);
  expect(calls).toEqual([
    { principal: sponsor, request: { fellow_id: fellow, problem_id: problem } },
    {
      principal: sponsor,
      request: { fellow_id: fellow, problem_id: problem, before_workshop_seq: 5 },
    },
  ]);
});

test("anonymous and invalid requests never reach the private reader", async () => {
  let calls = 0;
  const read: Parameters<typeof loadWorkshopPage>[4] = async () => {
    calls += 1;
    return { ok: true, data: page([1]) };
  };
  for (const principal of [undefined, null, "", "owner@example.com"]) {
    expect(await loadWorkshopPage(principal, fellow, problem, undefined, read)).toEqual({
      status: "sign-in",
    });
  }
  for (const cursor of ["", "0", "-1", "1.2", "1e3", " 5", "01", "9007199254740992", ["5", "4"]]) {
    expect(await loadWorkshopPage(sponsor, fellow, problem, cursor, read)).toEqual({
      status: "invalid",
    });
  }
  expect(await loadWorkshopPage(sponsor, "", problem, undefined, read)).toEqual({
    status: "invalid",
  });
  expect(await loadWorkshopPage(sponsor, fellow, "bad/problem", undefined, read)).toEqual({
    status: "invalid",
  });
  expect(calls).toBe(0);
});

test("refusal, transport failure and malformed pagination expose no private content", async () => {
  for (const reason of ["refused", "unreachable", "unconfigured"] as const) {
    expect(
      await loadWorkshopPage(sponsor, fellow, problem, undefined, async () => ({
        ok: false,
        reason,
        detail: "PRIVATE_REFUSAL_CANARY",
      })),
    ).toEqual({ status: "unavailable" });
  }
  expect(
    await loadWorkshopPage(sponsor, fellow, problem, undefined, async () => {
      throw new Error("PRIVATE_THROW_CANARY");
    }),
  ).toEqual({ status: "unavailable" });
  for (const view of [
    page([1, 2]),
    page([2, 2]),
    page([5, 4]),
    { ...page([4]), fellow_id: "fellow-another" },
  ]) {
    expect(
      await loadWorkshopPage(sponsor, fellow, problem, "5", async () => ({ ok: true, data: view })),
    ).toEqual({ status: "unavailable" });
  }
});

test("an empty older page preserves its meaning and a route cannot inject a query", async () => {
  const result = await loadWorkshopPage(sponsor, fellow, problem, "5", async () => ({
    ok: true,
    data: page([]),
  }));
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Empty page unavailable");
  expect(result.request.before_workshop_seq).toBe(5);
  expect(result.olderHref).toBeNull();
  expect(workshopPageHref("fellow/a?b=c", "P-X#fragment")).toBe(
    "/console/workshop/fellow%2Fa%3Fb%3Dc/P-X%23fragment",
  );
});
