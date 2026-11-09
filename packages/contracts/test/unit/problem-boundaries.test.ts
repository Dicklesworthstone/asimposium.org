import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod";
import {
  ProblemDetailSchema,
  ProblemGovernanceEventSchema,
  ProblemLifecycleActionRequestSchema,
  ProposeProblemRequestSchema,
  SaveProblemBriefRequestSchema,
} from "../../src/problems.ts";

const boundaries = {
  scope: "  Finite undirected trees, with loops excluded.\n",
  out_of_scope: "Infinite graphs and disconnected forests.",
  success_criteria: "An independently reviewable proof, or a counterexample to this invariant.",
};
const formulation = {
  statement: "Every finite tree has one fewer edge than vertices.",
  falsifier: "A finite tree with a different edge count.",
  motivation: "Establish the invariant used in the connected-graph argument.",
};
const proposal = { title: "Finite tree invariant", areas: ["combinatorics"], ...formulation };

test("problem proposals and sponsor briefs accept a complete exact-byte boundary bundle", () => {
  for (const schema of [ProposeProblemRequestSchema, SaveProblemBriefRequestSchema]) {
    expect(schema.parse({ ...proposal, ...boundaries })).toMatchObject(boundaries);
    expect(schema.parse(proposal)).not.toHaveProperty("scope");
  }
});

test("boundary-only revisions and explicitly bounded forks are valid formulation actions", () => {
  expect(
    ProblemLifecycleActionRequestSchema.parse({
      action: "revise-statement",
      ...formulation,
      ...boundaries,
    }),
  ).toMatchObject(boundaries);
  expect(
    ProblemLifecycleActionRequestSchema.parse({
      action: "fork",
      title: "Restricted trees",
      ...boundaries,
    }),
  ).toMatchObject(boundaries);
});

test("new runtime and generated JSON contracts agree on all-or-none bounded text", () => {
  const inputs = [
    { value: proposal, accepted: true },
    { value: { ...proposal, ...boundaries }, accepted: true },
    ...Object.keys(boundaries).map((key) => ({
      value: { ...proposal, [key]: boundaries[key as keyof typeof boundaries] },
      accepted: false,
    })),
    { value: { ...proposal, ...boundaries, scope: " \t\n" }, accepted: false },
    { value: { ...proposal, ...boundaries, out_of_scope: [] }, accepted: false },
    { value: { ...proposal, ...boundaries, success_criteria: "x".repeat(4097) }, accepted: false },
    { value: { ...proposal, ...boundaries, scope: "x".repeat(4096) }, accepted: true },
  ];
  const published = new Ajv2020({ strict: true }).compile(
    z.toJSONSchema(ProposeProblemRequestSchema),
  );
  for (const { value, accepted } of inputs) {
    expect(ProposeProblemRequestSchema.safeParse(value).success).toBe(accepted);
    expect(published(value)).toBe(accepted);
  }
});

test("public detail and governance records preserve complete boundaries and reject partial history", () => {
  const detail = {
    ...proposal,
    ...boundaries,
    id: "P-BOUNDARY",
    status: "sharpening",
    unlisted: false,
    current_statement_version: 2,
    public_seq: 2,
    created_at: "2026-11-08T00:00:00.000Z",
    updated_at: "2026-11-08T00:01:00.000Z",
  };
  expect(ProblemDetailSchema.parse(detail)).toMatchObject(boundaries);
  const event = {
    action: "revise-statement",
    acting_principal: { type: "sponsor", id: "usr_boundary" },
    source_fellow_id: "FEL-BOUNDARY",
    previous_status: "sharpening",
    previous_statement_version: 1,
    problem: {
      id: detail.id,
      title: detail.title,
      status: detail.status,
      current_statement_version: detail.current_statement_version,
      updated_at: detail.updated_at,
      ...formulation,
      ...boundaries,
    },
  };
  expect(ProblemGovernanceEventSchema.parse(event).problem).toMatchObject(boundaries);
  const partial = { ...event, problem: { ...event.problem, success_criteria: undefined } };
  expect(ProblemGovernanceEventSchema.safeParse(partial).success).toBe(false);
  const published = new Ajv2020({ strict: true }).compile(
    z.toJSONSchema(ProblemGovernanceEventSchema),
  );
  expect(published(event)).toBe(true);
  expect(published(partial)).toBe(false);
});
