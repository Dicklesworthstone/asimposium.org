import { expect, test } from "bun:test";
import {
  SponsorWorkshopPromotionReceiptSchema,
  SponsorWorkshopCursorResponseSchema,
  SponsorWorkshopViewSchema,
} from "@asimposium/contracts";

import {
  loadWorkshopPage,
  loadWorkshopCursorResponse,
  workshopPageHref,
  workshopPromotionDestination,
} from "../../lib/workshop-page";

const fellow = "fellow-01JXYZ";
const problem = "P-4DSP";
const sponsor = "usr_workshop_reader";

test("typed promotion receipts link to the exact canonical object and disclose computed evidence", () => {
  const origin = "https://a-staging.asimposium.org";
  const hypothesis = SponsorWorkshopPromotionReceiptSchema.parse({
    object_kind: "hypothesis",
    problem_id: problem,
    seq: 7,
    version: 1,
    result: { hypothesis_id: "H-7", status: "open" },
  });
  expect(workshopPromotionDestination(hypothesis, origin)).toEqual({
    label: "H-7",
    href: `${origin}/p/${problem}/hypotheses/H-7.html`,
  });
  const evidence = SponsorWorkshopPromotionReceiptSchema.parse({
    object_kind: "evidence",
    problem_id: problem,
    seq: 8,
    version: 1,
    result: {
      evidence_id: "E-8",
      computed_class: "heuristic",
      coercion_flags: ["domain_or_floor_missing"],
      drives_promotion: false,
    },
  });
  const destination = workshopPromotionDestination(evidence, origin);
  expect(destination.href).toBe(`/r/p/${problem}/evidence/E-8`);
  expect(destination.label).toBe("E-8");
  expect(destination.assessment).toContain("Computed evidence class: heuristic");
  expect(destination.assessment).toContain("cannot drive claim promotion");
  expect(destination.assessment).toContain("domain_or_floor_missing");
  const claim = SponsorWorkshopPromotionReceiptSchema.parse({
    claim_id: "C-1",
    problem_id: problem,
    seq: 1,
    version: 1,
    queue_position: 0,
  });
  expect(workshopPromotionDestination(claim, origin)).toEqual({
    label: "C-1",
    href: `/p/${problem}/claims/C-1`,
  });
  const revised = SponsorWorkshopPromotionReceiptSchema.parse({ ...claim, seq: 9, version: 2 });
  expect(workshopPromotionDestination(revised, origin)).toEqual({
    label: "C-1@2",
    href: `/p/${problem}/claims/C-1%402`,
  });
  const deadEnd = SponsorWorkshopPromotionReceiptSchema.parse({
    object_kind: "dead-end",
    problem_id: problem,
    seq: 10,
    version: 1,
    result: { recorded: true, dead_end_id: "DE-10", problem_id: problem, seq: 10 },
  });
  expect(workshopPromotionDestination(deadEnd, origin)).toEqual({
    label: "DE-10",
    href: `/p/${problem}/dead-ends?include_superseded=true#DE-10`,
  });
});

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

test("workshop cursor facade authenticates before reading and returns private metadata only", async () => {
  const calls: unknown[] = [];
  const data = SponsorWorkshopCursorResponseSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    sponsor_id: sponsor,
    fellow_id: fellow,
    problem_id: problem,
    workshop_cursor: 17,
  });
  const read: Parameters<typeof loadWorkshopCursorResponse>[3] = async (principal, request) => {
    calls.push({ principal, request });
    return { ok: true, data };
  };
  for (const principal of [undefined, "", "owner@example.com"])
    expect((await loadWorkshopCursorResponse(principal, fellow, problem, read)).status).toBe(401);
  for (const [fellowId, problemId] of [
    ["", problem],
    [fellow, "P-A?upstream=evil"],
  ] as const)
    expect((await loadWorkshopCursorResponse(sponsor, fellowId, problemId, read)).status).toBe(400);
  expect(calls).toHaveLength(0);
  const response = await loadWorkshopCursorResponse(sponsor, fellow, problem, read);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(await response.json()).toEqual(data);
  expect(calls).toEqual([{ principal: sponsor, request: { fellow_id: fellow, problem_id: problem } }]);
});

test("cursor facade refuses crossed identities, malformed bodies and private upstream diagnostics", async () => {
  const data = SponsorWorkshopCursorResponseSchema.parse({
    schema: "https://a.asimposium.org/schemas/sessions.v1.json",
    sponsor_id: sponsor,
    fellow_id: fellow,
    problem_id: problem,
    workshop_cursor: 0,
  });
  for (const body of [
    { ...data, sponsor_id: "usr_other" },
    { ...data, fellow_id: "fellow-other" },
    { ...data, problem_id: "P-OTHER" },
    { ...data, workshop_cursor: -1 },
    { ...data, body_md: "private-canary" },
  ]) {
    const response = await loadWorkshopCursorResponse(sponsor, fellow, problem, async () => ({
      ok: true,
      data: body,
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-canary");
  }
  for (const status of [401, 403, 404, 503]) {
    const response = await loadWorkshopCursorResponse(sponsor, fellow, problem, async () => ({
      ok: false,
      reason: "refused",
      status,
      detail: "private-canary",
    }));
    expect(response.status).toBe(status === 503 ? 503 : 404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("private-canary");
  }
  const failed = await loadWorkshopCursorResponse(sponsor, fellow, problem, async () => {
    throw new Error("private-canary");
  });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private-canary");
});
