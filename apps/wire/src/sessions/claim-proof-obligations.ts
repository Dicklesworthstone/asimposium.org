import type { ProofGapEvent } from "@asimposium/contracts/proof-gaps";
import type { PackCandidate } from "@asimposium/render";
import type { DependencyClosure } from "../ledger/claim-dependency-closure.ts";
import type { ProofGapPage } from "../ledger/proof-gaps-read.ts";

const LIMIT = 8;
const MAX_ITEM_SIZE = 18000;
export const CLAIM_OBLIGATIONS_BOUNDARY =
  "Recorded proof obligations for this exact claim and its verified publication-pinned premises. At most eight problem-wide gap filings are examined in sequence order; later or unreadable filings and incomplete ancestry prevent a complete inventory. Settlements record an author's action, not independent proof. An empty recorded inventory does not establish mathematical completeness. Whole records remain subject to the pack budget; follow the pinned history links.";

export interface ClaimObligationSummary {
  readonly scope: "exact-claim-and-publication-pins";
  readonly problem: string;
  readonly target: string;
  readonly through: number;
  readonly complete: boolean;
  readonly admissions_examined: number;
  readonly relevant_records: number;
  readonly unresolved_records: number;
  readonly settled_records: number;
  readonly unassigned_records: number;
  readonly read_url: string;
  readonly next_read_url: string | null;
  readonly boundary: string;
}
export interface ClaimObligationSection {
  readonly summary: ClaimObligationSummary;
  readonly candidates: PackCandidate[];
  readonly omitted: { reason: string; detail: string }[];
}

function exact(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^C-[0-9]+@[1-9][0-9]*$/.exec(value)?.[0] === value &&
    Number.isSafeInteger(Number(value.split("@")[1]));
}
function sourceEvent(e: ProofGapEvent): ProofGapEvent {
  return { event_id: e.event_id, seq: e.seq, payload_sha256: e.payload_sha256,
    created_at: e.created_at, fellow_id: e.fellow_id, sponsor_id: e.sponsor_id,
    session_id: e.session_id, model_string_self_declared: e.model_string_self_declared,
    harness: e.harness };
}

/** Selection happens only after canonical source/lifecycle decoding and only
 * through verified reachable publication pins. Missing filing bytes cannot be
 * assigned to a claim; disclose that uncertainty instead of inventing zero
 * obligations. No private workshop, independent scientific fold or write. */
export function composeClaimProofObligations(
  page: ProofGapPage,
  closure: DependencyClosure,
  problem: string,
  target: string,
  through: number,
  neutralize: (body: string) => string,
): ClaimObligationSection {
  const face = page.face;
  if (!exact(target) || /^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/.exec(problem)?.[0] !== problem ||
      !Number.isSafeInteger(through) || through < 0 || face.problem_id !== problem ||
      face.cursor !== through || face.after !== 0 || face.target !== null ||
      face.gaps.length > LIMIT || closure.nodes.length > 63)
    throw new Error("Claim proof obligations do not match the snapshot.");
  const paths = new Map<string, readonly string[]>();
  if (closure.root_available) paths.set(target, [target]);
  for (const node of closure.nodes) {
    if (!closure.root_available || !exact(node.target) || paths.has(node.target) ||
        node.path.length < 2 || node.path.length > 64 || node.path[0] !== target ||
        node.path.at(-1) !== node.target || !node.path.every(exact) ||
        new Set(node.path.map(pin => pin.split("@")[0])).size !== node.path.length ||
        node.path.slice(1).some((pin, i) => !closure.edges.some(edge =>
          edge.available && edge.from === node.path[i] && edge.to === pin)))
      throw new Error("Proof obligation premise path is not verified.");
    paths.set(node.target, [...node.path]);
  }
  const readUrl = `/p/${encodeURIComponent(problem)}/gaps.md?through=${through}`;
  const candidates: PackCandidate[] = [], omitted: ClaimObligationSection["omitted"] = [];
  let previous = 0, unassigned = 0, unresolved = 0, settled = 0;
  const seen = new Set<string>();
  for (const gap of face.gaps) {
    if (!Number.isSafeInteger(gap.filing.seq) || gap.filing.seq <= previous ||
        gap.filing.seq > through || gap.gap_id !== `G-${gap.filing.seq}` || seen.has(gap.gap_id) ||
        !Number.isSafeInteger(gap.last_event.seq) || gap.last_event.seq < gap.filing.seq ||
        gap.last_event.seq > through || !["open", "closed-by", "withdrawn", "unavailable"].includes(gap.status))
      throw new Error("Proof obligation history is inconsistent.");
    previous = gap.filing.seq; seen.add(gap.gap_id);
    if (gap.content === null) { unassigned++; continue; }
    const pin = `${gap.content.target_claim_id}@${gap.content.target_version}`;
    if (!exact(pin)) throw new Error("Proof obligation target is invalid.");
    const path = paths.get(pin);
    if (!path) continue;
    if (gap.status === "open" || gap.status === "unavailable") unresolved++;
    else settled++;
    const source = `${readUrl}&target=${gap.gap_id}`;
    const reference = {
      problem, through, root_target: target, target: pin, dependency_path: path,
      gap_id: gap.gap_id, status: gap.status,
      filing: sourceEvent(gap.filing), last_event: sourceEvent(gap.last_event),
      closed_by: gap.status === "closed-by" ? gap.closed_by : null,
      source,
      target_read: `/p/${encodeURIComponent(problem)}/claims/${pin}.md?through=${through}`,
      notice: "A recorded obligation or settlement, not a computed scientific verdict or independent proof.",
    };
    let body = JSON.stringify({ ...reference, content: {
      target_claim_id: gap.content.target_claim_id, target_version: gap.content.target_version,
      obligation: gap.content.obligation, closes_what: gap.content.closes_what,
    } });
    const tooLarge = (text: string) => new TextEncoder().encode(text).length > MAX_ITEM_SIZE ||
      new TextEncoder().encode(neutralize(text)).length > MAX_ITEM_SIZE;
    if (tooLarge(body)) {
      omitted.push({ reason: "item_too_large", detail: `claim-proof-gap:${gap.gap_id}; full record: ${source}` });
      body = JSON.stringify({ ...reference, content: null, content_omitted: "whole-record-size-limit" });
      if (tooLarge(body)) continue;
    }
    candidates.push({
      kind: "claim-proof-gap", id: gap.gap_id, scope: "ledger", untrusted: true,
      tokens: 1, body, stable_prefix: 5 + candidates.length,
      why_included: "recorded proof obligation on this exact statement or a verified pinned premise; settlement is not proof",
    });
  }
  if (face.next_after !== null && (face.next_after !== previous || previous <= 0 ||
      !face.omitted.includes("page_limit")))
    throw new Error("Proof obligation continuation is inconsistent.");
  if (face.next_after === null && face.omitted.includes("page_limit"))
    throw new Error("Proof obligation continuation is missing.");
  const nextRead = face.next_after === null ? null : `${readUrl}&after=${face.next_after}`;
  if (nextRead) omitted.push({ reason: "candidate_limit", detail: `claim-proof-obligations: later filings were not examined; continue ${nextRead}` });
  const complete = closure.root_available && closure.complete && face.next_after === null &&
    face.omitted.length === 0 && unassigned === 0 && !face.gaps.some(gap => gap.status === "unavailable");
  if (!complete) omitted.push({
    reason: "proof_obligation_history_unavailable",
    detail: "The bounded gap scan or verified premise history is incomplete; no zero-obligation conclusion is supported.",
  });
  return {
    summary: {
      scope: "exact-claim-and-publication-pins", problem, target, through, complete,
      admissions_examined: face.gaps.length, relevant_records: unresolved + settled,
      unresolved_records: unresolved, settled_records: settled, unassigned_records: unassigned,
      read_url: readUrl, next_read_url: nextRead, boundary: CLAIM_OBLIGATIONS_BOUNDARY,
    },
    candidates, omitted,
  };
}
