import { expect, test } from "bun:test";
import { type ClaimFaceResponse, ClaimFaceResponseSchema } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatRemainsUnverifiedPanel } from "../../components/claim-honesty-panels";
import { buildClaimPageViewModel } from "../../lib/claim-page-view";
import { readClaimProofObligations } from "../../lib/claim-proof-obligations";

const target = "C-1@2";
const event = (seq: number) => ({
  event_id: `EVENT-${seq}`,
  seq,
  payload_sha256: "a".repeat(64),
  created_at: "2026-11-22T08:00:00.000Z",
  fellow_id: "F-REVIEWER",
  sponsor_id: "S-REVIEWER",
  session_id: "SESSION-1",
  model_string_self_declared: "Declared model",
  harness: "Declared harness",
});
function gap(seq = 10, premise = target, patch: Record<string, unknown> = {}) {
  const [claim, version] = premise.split("@");
  return {
    problem: "P-DEMO",
    through: 40,
    root_target: target,
    target: premise,
    dependency_path: premise === target ? [target] : [target, premise],
    gap_id: `G-${seq}`,
    status: "open",
    filing: event(seq),
    last_event: event(seq),
    closed_by: null,
    source: `/p/P-DEMO/gaps.md?through=40&target=G-${seq}`,
    target_read: `/p/P-DEMO/claims/${premise}.md?through=40`,
    notice: "A recorded obligation or settlement is not independent proof.",
    content: {
      target_claim_id: claim,
      target_version: Number(version),
      obligation: "Prove uniform convergence for $n \\ge 1$.",
      closes_what: "The interchange of the limit and the infinite sum.",
    },
    ...patch,
  };
}
function face(records = [gap()], summary: Record<string, unknown> = {}): ClaimFaceResponse {
  const settled = records.filter((item) => item.status === "closed-by" || item.status === "withdrawn").length;
  return ClaimFaceResponseSchema.parse({
    schema: "asimposium.claim-face.v1",
    face: "json",
    kind: "claim-face",
    profile: "claim",
    problem: "P-DEMO",
    cursor: 40,
    fingerprint: "fnv1a64:0000000000000000",
    title: target,
    preamble: "A public statement at its exact snapshot.",
    claim_state: {
      claim_id: "C-1", version: 2, latest_version: 3,
      disposition: "open", review_state: "unreviewed", unchallenged: true,
      stale: false, recorded_refutation_attempts: 0, certified_artifact: false, legacy_reviews: 0,
    },
    items: [
      {
        kind: "claim-detail", id: target, scope: "ledger", untrusted: true,
        neutralized: [], why_included: "exact statement",
        body: JSON.stringify({
          problem: "P-DEMO", claim_id: "C-1", version: 2,
          statement: "A limit commutes with a series.",
          proof_obligations: {
            scope: "exact-claim-and-publication-pins", problem: "P-DEMO", target, through: 40,
            complete: true, admissions_examined: records.length, relevant_records: records.length,
            unresolved_records: records.length - settled, settled_records: settled, unassigned_records: 0,
            read_url: "/p/P-DEMO/gaps.md?through=40", next_read_url: null,
            boundary: "A recorded inventory is not independent proof.",
            ...summary,
          },
        }),
      },
      ...records.map((value) => ({
        kind: "claim-proof-gap", id: value.gap_id, scope: "ledger", untrusted: true,
        neutralized: [], why_included: "recorded exact or inherited obligation", body: JSON.stringify(value),
      })),
    ],
    omitted: [], degraded: [], next_actions: [],
  });
}
function panel(value: ClaimFaceResponse): string {
  const vm = buildClaimPageViewModel(value);
  return renderToStaticMarkup(<WhatRemainsUnverifiedPanel whatRemainsUnverified={vm.whatRemainsUnverified} />);
}

test("exact and inherited missing steps are readable with the same historical version and cut", () => {
  const value = face([gap(), gap(12, "C-2@1")]);
  const inventory = readClaimProofObligations(value);
  expect(inventory.coverage).toBe("complete");
  expect(inventory.records.map((item) => item.path.map((step) => step.target)))
    .toEqual([[target], [target, "C-2@1"]]);
  const html = panel(value);
  expect(html).toContain("Recorded proof obligations");
  expect(html).toContain("Prove uniform convergence");
  expect(html).toContain("katex");
  expect(html).toContain("The interchange of the limit");
  expect(html).toContain("Obligation on a pinned premise");
  expect(html).toContain('href="/p/P-DEMO/claims/C-1%402?through=40"');
  expect(html).toContain('href="/p/P-DEMO/claims/C-2%401?through=40"');
  expect(html).toContain('href="/p/P-DEMO/gaps?through=40&amp;target=G-12"');
  expect(html).not.toContain("No unresolved proof obligations");
  const timeline = buildClaimPageViewModel(value).timeline.filter((item) => item.kind === "claim-proof-gap");
  expect(timeline.map((item) => [item.seq, item.sourceHref])).toEqual([
    [10, "/p/P-DEMO/gaps?through=40&target=G-10"],
    [12, "/p/P-DEMO/gaps?through=40&target=G-12"],
  ]);
});

test("settlements and withdrawals preserve provenance without certifying the obligation", () => {
  const value = face([
    gap(10, target, { status: "closed-by", closed_by: "C-7@3", last_event: event(20) }),
    gap(12, "C-2@1", { status: "withdrawn", last_event: event(22) }),
  ]);
  const vm = buildClaimPageViewModel(value);
  expect(vm.whatRemainsUnverified.proofObligations.counts?.settled).toBe(2);
  expect(vm.badges.machineChecked.earned).toBe(false);
  const html = panel(value);
  expect(html).toContain("Recorded settlements and withdrawals (2)");
  expect(html).toContain("not independent verification");
  expect(html).toContain('href="/p/P-DEMO/claims/C-7%403?through=40"');
  expect(html).toContain("Latest recorded transition: #20");
  expect(vm.timeline.filter((item) => item.kind === "claim-proof-gap").map((item) => item.seq))
    .toEqual([10, 12, 20, 22]);
});

test("complete source scans do not conceal relevant records removed by the face budget", () => {
  const value = face([gap(), gap(12, "C-2@1")]);
  value.items.pop();
  value.omitted.push({ reason: "budget_exceeded", detail: "Trailing records omitted." });
  const result = readClaimProofObligations(value);
  expect(result.coverage).toBe("partial");
  expect(result.counts?.relevant).toBe(2);
  expect(result.undisplayed).toBe(1);
  expect(panel(value)).toContain("1 relevant obligation record(s) from the scan are not displayed");
});

test("partial problem-wide scans disclose unassigned filings and link to the captured continuation", () => {
  const value = face([], {
    complete: false, admissions_examined: 8, unassigned_records: 2,
    next_read_url: "/p/P-DEMO/gaps.md?through=40&after=20",
  });
  const html = panel(value);
  expect(html).toContain("2 examined filing(s) could not be assigned");
  expect(html).toContain("incomplete inventory cannot establish their absence");
  expect(html).toContain('href="/p/P-DEMO/gaps?through=40&amp;after=20"');
  expect(html).not.toContain("No unresolved proof obligations are recorded");
});

test("a missing legacy summary or mismatched summary never manufactures an empty inventory", () => {
  for (const patch of [
    { through: 41 }, { target: "C-1@3" }, { problem: "P-OTHER" },
    { relevant_records: 0, unresolved_records: 0 },
    { next_read_url: "https://evil.invalid/next" },
    { complete: true, unassigned_records: 1 },
  ]) {
    const result = readClaimProofObligations(face([gap()], patch));
    expect(result.coverage).toBe("unavailable");
    expect(result.counts).toBeNull();
    expect(result.nextHref).toBeNull();
  }
  const legacy = face([]);
  legacy.items[0]!.body = JSON.stringify({ problem: "P-DEMO", claim_id: "C-1", version: 2 });
  expect(panel(legacy)).toContain("proof-obligation inventory is unavailable");
  expect(panel(legacy)).not.toContain("No unresolved proof obligations are recorded");
});

test("mismatched records and forged navigation cannot become trusted missing-step cards", () => {
  for (const patch of [
    { through: 41 }, { problem: "P-OTHER" }, { root_target: "C-1@3" },
    { target: "C-9@1" }, { dependency_path: [target, target] },
    { source: "javascript:alert(1)" }, { target_read: "/console/private" },
    { last_event: event(41) }, { status: { toString: null } },
    { content: { ...gap().content, target_version: 3 } },
  ]) {
    const value = face([gap(10, target, patch)]);
    const result = readClaimProofObligations(value);
    expect(result.records).toHaveLength(0);
    expect(result.coverage).toBe("partial");
    const html = panel(value);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="/console/private"');
    expect(html).not.toContain("No unresolved proof obligations are recorded");
  }
});

test("unavailable lifecycle and omitted text are visible uncertainty, never a settlement", () => {
  const unknown = face([gap(10, target, { status: "unavailable", last_event: event(20) })], { complete: false });
  expect(panel(unknown)).toContain("Status unavailable");
  expect(panel(unknown)).not.toContain("Recorded settlements and withdrawals (");
  const omitted = face([gap(10, target, { content: null, content_omitted: "whole-record-size-limit" })]);
  expect(readClaimProofObligations(omitted).coverage).toBe("partial");
  expect(panel(omitted)).toContain("complete obligation text was omitted");
});

test("author markup stays escaped and source URLs cannot redirect the panel", () => {
  const value = face([gap(10, target, {
    href: "https://evil.invalid/workshop",
    content: { ...gap().content, obligation: '<script>alert("secret")</script> [link](javascript:alert(1))' },
  })]);
  const html = panel(value);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('href="https://evil.invalid');
  expect(html).toContain('href="/p/P-DEMO/gaps?through=40&amp;target=G-10"');
});

test("a complete empty recorded inventory remains explicitly weaker than a complete proof", () => {
  const value = face([]);
  expect(readClaimProofObligations(value).coverage).toBe("complete");
  expect(panel(value)).toContain("No unresolved proof obligations are recorded in this inventory");
  expect(panel(value)).toContain("does not establish mathematical completeness");
});
