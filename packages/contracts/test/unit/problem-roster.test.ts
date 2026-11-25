import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ProblemFaceResponseSchema, PublicProblemRosterSchema } from "../../src/ledger.ts";

const good = JSON.parse(
  readFileSync(new URL("../fixtures/valid/ledger-problem-roster.json", import.meta.url), "utf8"),
);
const bad = JSON.parse(
  readFileSync(new URL("../fixtures/invalid/ledger-problem-roster.json", import.meta.url), "utf8"),
);
const face = JSON.parse(
  readFileSync(new URL("../fixtures/valid/ledger-problem-face.json", import.meta.url), "utf8"),
);

test("public roster schema is additive, bounded, strict and forbids private session fields", () => {
  const published = JSON.parse(
    readFileSync(new URL("../../generated/ledger.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020({ strict: true }).compile(
    published.properties.problem_face_response,
  );
  for (const value of [
    face,
    { ...face, roster: good },
    { ...face, roster: { notice: good.notice, members: [], has_more: false, omitted: [] } },
    {
      ...face,
      roster: {
        ...good,
        members: [{ ...good.members[0], fellow_id: "F-\u{10000}", name: "astral-\u{1F9EE}" }],
      },
    },
  ]) {
    expect(ProblemFaceResponseSchema.safeParse(value).success).toBe(true);
    expect(validate(value)).toBe(true);
  }
  for (const roster of [
    bad,
    { ...good, members: Array(9).fill(good.members[0]) },
    { ...good, members: [{ ...good.members[0], role: "admin" }] },
    { ...good, members: [{ ...good.members[0], open_session_heartbeat_at: "online" }] },
    { ...good, members: [{ ...good.members[0], fellow_id: "F-\ud800" }] },
    { ...good, members: [{ ...good.members[0], name: "bad\udfff" }] },
    { ...good, members: [{ ...good.members[0], name: "nul\u0000name" }] },
  ]) {
    expect(PublicProblemRosterSchema.safeParse(roster).success).toBe(false);
    expect(validate({ ...face, roster })).toBe(false);
  }
});

test("roster cuts, ordering and truncation cannot claim unsupported completeness", () => {
  for (const roster of [
    { ...good, has_more: true },
    { ...good, omitted: ["member_limit"] },
    { ...good, members: [good.members[0], good.members[0]] },
    { ...good, members: [{ ...good.members[0], fellow_id: "F-z" }, good.members[0]] },
    { ...good, omitted: ["source_unavailable"] },
    { ...good, members: [], omitted: ["source_unavailable", "source_unavailable"] },
  ])
    expect(PublicProblemRosterSchema.safeParse(roster).success).toBe(false);
  expect(ProblemFaceResponseSchema.safeParse({ ...face, cursor: 6, roster: good }).success).toBe(
    false,
  );
  const binaryOrder = {
    ...good,
    members: [
      { ...good.members[0], fellow_id: "F-\uE000" },
      { ...good.members[0], fellow_id: "F-\u{10000}" },
    ],
  };
  expect(PublicProblemRosterSchema.safeParse(binaryOrder).success).toBe(true);
  expect(
    PublicProblemRosterSchema.safeParse({
      ...binaryOrder,
      members: [...binaryOrder.members].reverse(),
    }).success,
  ).toBe(false);
  expect(
    PublicProblemRosterSchema.safeParse({ ...good, has_more: true, omitted: ["budget_limit"] })
      .success,
  ).toBe(true);
  expect(
    PublicProblemRosterSchema.safeParse({
      ...good,
      members: [],
      has_more: true,
      omitted: ["budget_limit"],
    }).success,
  ).toBe(true);
});
