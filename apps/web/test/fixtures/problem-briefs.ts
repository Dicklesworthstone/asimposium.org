import type { SponsorFellowSummary, SponsorProblemBrief } from "@asimposium/contracts";

export const briefSponsor = "usr_1234567890abcdef";
export const privateBrief: SponsorProblemBrief = {
  id: "brief-private-editor",
  sponsor_id: briefSponsor,
  version: 4,
  assigned_fellow_id: "F-BRIEF-ACTIVE",
  title: "PRIVATE_BRIEF <script>untrusted()</script>",
  statement: "  Every finite object in the named family has the stated bound.\n",
  falsifier: "  An object in that family that exceeds the exact bound.\n",
  motivation: "  PRIVATE_MOTIVATION for the bounded investigation.  ",
  scope: "  Finite inputs under the stated hypotheses.\n",
  out_of_scope: "Infinite inputs and approximate analogues.\n",
  success_criteria: "An exact proof or a finite counterexample.\n",
  areas: ["number-theory", "combinatorics"],
  famous_guardrail: {
    canonical_formulation: "  PRIVATE_CANONICAL formulation.\n",
    variant_distinctions: "  This bounded variant does not resolve the named problem.\n",
    authoritative_references: ["Reference A\nSection 4 preserves this newline.", "Reference B"],
    standing_banner: "No resolution without extraordinary evidence.",
  },
  status: "active",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-02T00:00:00.000Z",
};

export const briefFellows: readonly SponsorFellowSummary[] = [
  {
    fellow_id: "F-BRIEF-ACTIVE",
    name: "active-brief-fellow",
    model: "test/model",
    harness: "test",
    status: "active",
    granted_scopes: ["propose-problems"],
    granted_resources: {},
    granted_at: 1,
    credentials: [],
  },
  {
    fellow_id: "F-BRIEF-SECOND",
    name: "second-brief-fellow",
    model: "test/model",
    harness: "test",
    status: "active",
    granted_scopes: ["propose-problems"],
    granted_resources: {},
    granted_at: 1,
    credentials: [],
  },
  {
    fellow_id: "F-BRIEF-PAUSED",
    name: "paused-brief-fellow",
    model: "test/model",
    harness: "test",
    status: "paused",
    granted_scopes: ["propose-problems"],
    granted_resources: {},
    granted_at: 1,
    credentials: [],
  },
];
