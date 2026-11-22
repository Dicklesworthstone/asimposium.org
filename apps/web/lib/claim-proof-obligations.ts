import { type ClaimFaceResponse, GapFileRequestSchema } from "@asimposium/contracts";
import { type ProofGapEvent, ProofGapEventSchema } from "@asimposium/contracts/proof-gaps";
import { proofGapClosingPath, proofGapPagePath } from "./proof-gap-view";

type FaceItem = ClaimFaceResponse["items"][number];
type GapStatus = "open" | "closed-by" | "withdrawn" | "unavailable";

export interface ClaimProofObligationView {
  readonly id: string;
  readonly status: GapStatus;
  readonly target: string;
  readonly path: readonly { readonly target: string; readonly href: string }[];
  readonly href: string;
  readonly obligation: string | null;
  readonly closesWhat: string | null;
  readonly closedBy: string | null;
  readonly closingHref: string | null;
  readonly filing: ProofGapEvent;
  readonly lastEvent: ProofGapEvent;
  readonly screeningNotice?: FaceItem["screening_notice"];
}

export interface ClaimProofObligationsView {
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly records: readonly ClaimProofObligationView[];
  /** Counts describe the bounded canonical scan, not all mathematical obligations. */
  readonly counts: {
    readonly examined: number;
    readonly relevant: number;
    readonly unresolved: number;
    readonly settled: number;
    readonly unassigned: number;
  } | null;
  readonly undisplayed: number | null;
  readonly readHref: string;
  readonly nextHref: string | null;
  readonly notices: readonly string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function body(item: FaceItem): Record<string, unknown> | null {
  if (item.body.length > 64_000) return null;
  try {
    return record(JSON.parse(item.body));
  } catch {
    return null;
  }
}
function exactClaim(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^C-[0-9]+@[1-9][0-9]*$/.exec(value)?.[0] === value &&
    Number.isSafeInteger(Number(value.split("@")[1]))
  );
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8;
}
const targetOf = (face: ClaimFaceResponse) =>
  `${face.claim_state.claim_id}@${face.claim_state.version}`;
const sourceBase = (face: ClaimFaceResponse) =>
  `/p/${encodeURIComponent(face.problem)}/gaps.md?through=${face.cursor}`;

/** The Worker has already verified the publication ancestry. Interpret only
 * its exact identities and snapshot; never infer a dependency from prose or
 * follow a body-supplied URL. Missing display records remain explicit unknowns. */
function obligation(face: ClaimFaceResponse, item: FaceItem): ClaimProofObligationView | null {
  const value = body(item);
  if (!value || item.scope !== "ledger" || item.untrusted !== true) return null;
  const filing = ProofGapEventSchema.safeParse(value.filing);
  const last = ProofGapEventSchema.safeParse(value.last_event);
  const path = value.dependency_path;
  if (
    value.problem !== face.problem ||
    value.through !== face.cursor ||
    value.root_target !== targetOf(face) ||
    value.gap_id !== item.id ||
    !filing.success ||
    !last.success ||
    item.id !== `G-${filing.data.seq}` ||
    filing.data.seq > face.cursor ||
    last.data.seq < filing.data.seq ||
    last.data.seq > face.cursor ||
    !exactClaim(value.target) ||
    !Array.isArray(path) ||
    path.length < 1 ||
    path.length > 64 ||
    !path.every(exactClaim) ||
    path[0] !== targetOf(face) ||
    path.at(-1) !== value.target ||
    new Set(path.map((pin) => pin.split("@")[0])).size !== path.length ||
    typeof value.status !== "string" ||
    !["open", "closed-by", "withdrawn", "unavailable"].includes(value.status) ||
    value.source !== `${sourceBase(face)}&target=${item.id}` ||
    value.target_read !==
      `/p/${encodeURIComponent(face.problem)}/claims/${value.target}.md?through=${face.cursor}`
  )
    return null;
  const status = value.status as GapStatus;
  if (
    (status === "open" &&
      (last.data.event_id !== filing.data.event_id ||
        last.data.seq !== filing.data.seq ||
        last.data.payload_sha256 !== filing.data.payload_sha256)) ||
    ((status === "closed-by" || status === "withdrawn") &&
      (last.data.seq <= filing.data.seq || last.data.event_id === filing.data.event_id)) ||
    (status === "closed-by"
      ? typeof value.closed_by !== "string" ||
        !value.closed_by.trim() ||
        value.closed_by.length > 80
      : value.closed_by !== null)
  )
    return null;
  const content = GapFileRequestSchema.safeParse(value.content);
  if (
    content.success
      ? `${content.data.target_claim_id}@${content.data.target_version}` !== value.target
      : value.content !== null || value.content_omitted !== "whole-record-size-limit"
  )
    return null;
  const closedBy = status === "closed-by" ? (value.closed_by as string) : null;
  return {
    id: item.id,
    status,
    target: value.target,
    path: path.map((target) => ({
      target,
      href: `/p/${encodeURIComponent(face.problem)}/claims/${encodeURIComponent(target)}?through=${face.cursor}`,
    })),
    href: proofGapPagePath(face.problem, { through: face.cursor, target: item.id }),
    obligation: content.success ? content.data.obligation : null,
    closesWhat: content.success ? content.data.closes_what : null,
    closedBy,
    // Old unpinned claim references may be displayed as history, never floated
    // to a later statement. Evidence records are immutable, with current controls.
    closingHref:
      closedBy !== null && (exactClaim(closedBy) || closedBy.startsWith("E-"))
        ? proofGapClosingPath(face.problem, closedBy, face.cursor)
        : null,
    filing: filing.data,
    lastEvent: last.data,
    ...(item.screening_notice === undefined ? {} : { screeningNotice: item.screening_notice }),
  };
}

function inventory(face: ClaimFaceResponse) {
  const details = face.items.filter((item) => item.kind === "claim-detail");
  const detail = details.length === 1 ? body(details[0]!) : null;
  const value = record(detail?.proof_obligations);
  if (
    !detail ||
    details[0]?.id !== targetOf(face) ||
    detail.problem !== face.problem ||
    detail.claim_id !== face.claim_state.claim_id ||
    detail.version !== face.claim_state.version ||
    !value ||
    value.scope !== "exact-claim-and-publication-pins" ||
    value.problem !== face.problem ||
    value.target !== targetOf(face) ||
    value.through !== face.cursor ||
    typeof value.complete !== "boolean" ||
    !count(value.admissions_examined) ||
    !count(value.relevant_records) ||
    !count(value.unresolved_records) ||
    !count(value.settled_records) ||
    !count(value.unassigned_records) ||
    value.relevant_records !== value.unresolved_records + value.settled_records ||
    value.relevant_records + value.unassigned_records > value.admissions_examined ||
    value.read_url !== sourceBase(face)
  )
    return null;
  let after: number | null = null;
  if (value.next_read_url !== null) {
    const prefix = `${sourceBase(face)}&after=`;
    if (typeof value.next_read_url !== "string" || !value.next_read_url.startsWith(prefix))
      return null;
    const sequence = value.next_read_url.slice(prefix.length);
    if (/^[1-9][0-9]*$/.exec(sequence)?.[0] !== sequence) return null;
    after = Number(sequence);
    if (!Number.isSafeInteger(after) || after > face.cursor || value.admissions_examined !== 8)
      return null;
  }
  if (value.complete && (after !== null || value.unassigned_records !== 0)) return null;
  return {
    complete: value.complete,
    counts: {
      examined: value.admissions_examined,
      relevant: value.relevant_records,
      unresolved: value.unresolved_records,
      settled: value.settled_records,
      unassigned: value.unassigned_records,
    },
    after,
  };
}

export function readClaimProofObligations(face: ClaimFaceResponse): ClaimProofObligationsView {
  const items = face.items.filter((item) => item.kind === "claim-proof-gap");
  const records: ClaimProofObligationView[] = [];
  const seen = new Set<string>();
  let unavailable = items.length > 8;
  for (const item of items.slice(0, 8)) {
    const gap = obligation(face, item);
    if (gap === null || seen.has(item.id)) {
      unavailable = true;
      continue;
    }
    seen.add(item.id);
    records.push(gap);
  }
  let summary = inventory(face);
  const unresolved = records.filter((gap) => gap.status === "open" || gap.status === "unavailable");
  const after = summary?.after;
  if (
    summary !== null &&
    (summary.counts.unresolved < unresolved.length ||
      summary.counts.settled < records.length - unresolved.length ||
      (after != null && records.some((gap) => gap.filing.seq > after)))
  )
    summary = null;
  const undisplayed = summary === null ? null : summary.counts.relevant - records.length;
  const complete =
    summary?.complete === true &&
    !unavailable &&
    undisplayed === 0 &&
    records.every((gap) => gap.status !== "unavailable" && gap.obligation !== null) &&
    !face.omitted.some((entry) => entry.reason === "proof_obligation_history_unavailable");
  const notices: string[] = [];
  if (summary === null)
    notices.push(
      "The proof-obligation inventory is unavailable. Missing records do not establish that this claim has no open obligations.",
    );
  else if (!complete)
    notices.push(
      "This proof-obligation inventory is incomplete. Later filings, unavailable history or omitted records may contain additional missing steps.",
    );
  if (unavailable)
    notices.push(
      "Some obligation records could not be matched to this exact claim and snapshot; they are not treated as settled.",
    );
  if (summary && summary.counts.unassigned > 0)
    notices.push(
      `${summary.counts.unassigned} examined filing(s) could not be assigned to a claim because their source content was unavailable.`,
    );
  if (undisplayed !== null && undisplayed > 0)
    notices.push(
      `${undisplayed} relevant obligation record(s) from the scan are not displayed in this budgeted face.`,
    );
  return {
    coverage: summary === null ? "unavailable" : complete ? "complete" : "partial",
    records,
    counts: summary?.counts ?? null,
    undisplayed,
    readHref: proofGapPagePath(face.problem, { through: face.cursor }),
    nextHref:
      summary?.after == null
        ? null
        : proofGapPagePath(face.problem, { through: face.cursor, after: summary.after }),
    notices,
  };
}
