/** Types for state-verdict.mjs (the runner is plain Node ESM; tests are TypeScript). */
export declare const GAUNTLET_STAGES: readonly string[];

export interface GauntletObservation {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | null;
  readonly injected?: boolean;
}

export interface GauntletFacts {
  readonly fellow: { readonly fellow_id: string; readonly sponsor_id: string } | null;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly sessions: readonly {
    readonly session_id: string;
    readonly problem_id: string;
    readonly closed_at: string | null;
  }[];
  readonly workshopObjects: number;
  readonly publicClaims: readonly {
    readonly author_fellow_id: string | null;
    readonly has_falsifier: boolean;
    readonly conjecture_class: boolean;
  }[];
  readonly observations: readonly GauntletObservation[];
  readonly injected: boolean;
  readonly secretSeenInPaths: boolean;
}

export interface GauntletVerdict {
  readonly completed: boolean;
  readonly stageReached: string;
  readonly reached: readonly string[];
  readonly missing: readonly string[];
  readonly failures: readonly string[];
}

export declare function gauntletVerdict(facts: GauntletFacts): GauntletVerdict;
