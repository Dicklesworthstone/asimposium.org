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

export function reportPageHref(target: ReportTarget): string {
  return `/report?${new URLSearchParams(target)}`;
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

/** Reuse the registered human reader for each canonical report target. */
export function reportSourceHref(target: ReportTarget): string {
  const problemPath = `/p/${encodeURIComponent(target.problem_id)}`;
  if (target.target === "problem") return problemPath;
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
