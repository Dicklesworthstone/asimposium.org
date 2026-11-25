import type { GauntletResult, GauntletScorecard } from "./scorecard.ts";

export interface StagingJoinEntry {
  readonly attemptIndex: number;
  readonly joinUrl: string;
  readonly enrollmentId: string;
  readonly secret: string;
  readonly problemId: string;
  readonly sponsorId: string;
  readonly harness: string;
}

export type OriginValidation =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly exitCode: 64 | 78; readonly code: string };

export function validateStagingAgentOrigin(
  rawOrigin: string | undefined,
  options?: { readonly allowLoopback?: boolean },
): OriginValidation;

export function parseJoinUrlsFile(
  content: string,
  defaults?: { readonly problemId?: string; readonly sponsorId?: string },
): StagingJoinEntry[];

export function startStagingRecordingProxy(options: {
  readonly upstreamOrigin: string;
  readonly enrollmentSecret: string;
  readonly injectFirstPromoteRefusal?: boolean;
}): Promise<{
  readonly origin: string;
  snapshot(): {
    readonly fellow: { readonly fellow_id: string; readonly sponsor_id: string } | null;
    readonly sessions: readonly {
      readonly session_id: string;
      readonly problem_id: string;
      readonly closed_at: string | null;
      readonly has_handback: boolean;
      readonly workshop_objects: number;
    }[];
    readonly observations: readonly {
      readonly started_order: number;
      readonly completed_order: number;
      readonly claim_id: string | null;
      readonly method: string;
      readonly path: string;
      readonly status: number;
      readonly code: string | null;
      readonly bytes: number;
      readonly injected: boolean;
    }[];
    readonly injected: boolean;
    readonly secretSeenInPaths: boolean;
    readonly servedBytes: number;
  };
  close(): Promise<void>;
}>;

export function fetchAnonymousPublicClaims(
  upstreamOrigin: string,
  problemId: string,
): Promise<
  Array<{
    readonly claim_id: string | null;
    readonly author_fellow_id: string | null;
    readonly session_id: string | null;
    readonly has_falsifier: boolean;
    readonly conjecture_class: boolean;
  }>
>;

export function runStagingCohort(options: {
  readonly targetOrigin: string | undefined;
  readonly entries: readonly StagingJoinEntry[];
  readonly allowLoopback?: boolean;
  readonly injectFirstPromoteRefusal?: boolean;
  readonly approveEnrollment?: (ctx: {
    readonly enrollmentId: string;
    readonly sponsorId: string;
    readonly problemId: string;
    readonly attemptIndex: number;
  }) => Promise<void> | void;
  readonly runner?: (ctx: {
    readonly attemptIndex: number;
    readonly harness: string;
    readonly joinUrl: string;
    readonly proxyOrigin: string;
    readonly problemId: string;
    readonly sponsorId: string;
  }) => Promise<{ readonly tokensUsed: number }>;
  readonly emit?: (record: Record<string, unknown>) => void;
}): Promise<{
  readonly ok: boolean;
  readonly exitCode: number;
  readonly code: string;
  readonly results: readonly GauntletResult[];
  readonly scorecard: GauntletScorecard | null;
  readonly attempts: readonly Record<string, unknown>[];
}>;
