import {
  PUBLIC_RESOURCE_REGISTRY,
  type PublicResourceKind,
  type ReportRequest,
  ReportRequestSchema,
  type ReportResponse,
} from "@asimposium/contracts";

export type ReportTarget = Pick<ReportRequest, "problem_id" | "target">;

export interface ReportDraft {
  readonly reason: string;
  readonly note: string;
}

export type ReportActionState =
  | { readonly status: "idle" }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly draft: ReportDraft;
      /** The write may have committed; retry its unchanged body to recover the receipt. */
      readonly uncertain: boolean;
      readonly signInRequired?: boolean;
    }
  | { readonly status: "committed"; readonly receipt: ReportResponse };

const ReportTargetSchema = ReportRequestSchema.pick({ problem_id: true, target: true });

/** Public URL context, not proof that a target exists or authority to report it. */
export function parseReportTarget(problemId: unknown, target: unknown): ReportTarget | null {
  const parsed = ReportTargetSchema.safeParse({ problem_id: problemId, target });
  return parsed.success ? parsed.data : null;
}

/** A commentary cursor is only navigation context, never report authority or signed input. */
function commentaryReportCursor(target: ReportTarget, cursor?: number): number | undefined {
  return target.target.startsWith("COMM-") &&
    cursor !== undefined &&
    Number.isSafeInteger(cursor) &&
    cursor > 0
    ? cursor
    : undefined;
}

export function reportPageHref(target: ReportTarget, commentaryCursor?: number): string {
  const query = new URLSearchParams(target);
  const cursor = commentaryReportCursor(target, commentaryCursor);
  if (cursor !== undefined) query.set("commentary_cursor", String(cursor));
  return `/report?${query}`;
}

/** A new report must match the requested version. A sponsor-family replay
 * may return the original report on another version of that same claim. */
export function reportReceiptMatchesTarget(
  receipt: ReportResponse,
  requested: ReportTarget,
): boolean {
  if (receipt.problem_id !== requested.problem_id) return false;
  if (receipt.target === requested.target) return true;
  return (
    receipt.deduplicated &&
    requested.target.startsWith("C-") &&
    ReportRequestSchema.shape.target.safeParse(receipt.target).success &&
    receipt.target.split("@")[0] === requested.target.split("@")[0]
  );
}

const TARGET_KINDS: Readonly<Record<string, PublicResourceKind>> = {
  H: "hypothesis",
  E: "evidence",
  R: "review",
  G: "proof-gap",
  L: "citation",
  DE: "dead-end",
  Q: "question",
  CF: "conflict",
  SYNTH: "synthesis",
};

/** Scientific targets use registered readers; commentary returns to its immutable entry. */
export function reportSourceHref(target: ReportTarget, commentaryCursor?: number): string {
  const problemPath = `/p/${encodeURIComponent(target.problem_id)}`;
  if (target.target === "problem") return problemPath;
  if (target.target.startsWith("COMM-")) {
    const cursor = commentaryReportCursor(target, commentaryCursor);
    return `${problemPath}${cursor === undefined ? "" : `?commentary_cursor=${cursor}`}#commentary-${encodeURIComponent(target.target)}`;
  }
  if (target.target.startsWith("C-"))
    return `${problemPath}/claims/${encodeURIComponent(target.target)}`;
  const kind = TARGET_KINDS[target.target.slice(0, target.target.indexOf("-"))];
  const reader = PUBLIC_RESOURCE_REGISTRY.find((resource) => resource.kind === kind);
  return reader === undefined
    ? problemPath
    : reader.human_route_key.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
        encodeURIComponent(name === "id" ? target.problem_id : target.target),
      );
}

export function reportStatusLabel(status: ReportResponse["status"]): string {
  return status === "pending"
    ? "Awaiting operator review"
    : status === "dismissed"
      ? "Dismissed by an operator"
      : "Upheld by an operator";
}
