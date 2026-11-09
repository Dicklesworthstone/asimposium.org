import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStewardshipAttempt,
  parseProblemStewardshipCommand,
  parseStewardshipAttempt,
  problemGovernanceConsolePath,
  STEWARDSHIP_RETRY_MS,
  stewardshipAttemptExpired,
} from "../../lib/problem-stewardship";
import { accessProblem, accessSponsor } from "../fixtures/problem-governance";
import {
  stewardshipCommand,
  stewardshipWorkspace,
  stewardTarget,
} from "../fixtures/problem-stewardship";

mock.module("server-only", () => ({}));
const { ProblemStewardshipControl } = await import("../../components/problem-stewardship-control");

test("the console accepts only exact stewardship commands with a reviewed roster version", () => {
  expect(parseProblemStewardshipCommand(stewardshipCommand)).toEqual(stewardshipCommand);
  for (const input of [
    { ...stewardshipCommand, expected_stewardship_version: undefined },
    { ...stewardshipCommand, expected_stewardship_version: -1 },
    { ...stewardshipCommand, expected_stewardship_version: Number.MAX_SAFE_INTEGER + 1 },
    { ...stewardshipCommand, target_sponsor_id: "person@example.invalid" },
    { ...stewardshipCommand, acting_sponsor_id: accessSponsor },
    { action: "set-admission-mode", mode: "open" },
  ])
    expect(parseProblemStewardshipCommand(input)).toBeUndefined();
});

test("uncertain retry metadata freezes the reviewed body, account, problem and key", () => {
  const input = { ...stewardshipCommand, target_sponsor_id: stewardTarget };
  const attempt = createStewardshipAttempt(accessSponsor, accessProblem, input, "exact-key", 1000);
  if (!attempt) throw new Error("Missing valid retry attempt");
  input.target_sponsor_id = accessSponsor;
  expect(attempt.command).toEqual(stewardshipCommand);
  expect(
    parseStewardshipAttempt(JSON.stringify(attempt), accessSponsor, accessProblem, 2000),
  ).toEqual(attempt);
  expect(
    parseStewardshipAttempt(JSON.stringify(attempt), stewardTarget, accessProblem, 2000),
  ).toBeUndefined();
  expect(
    parseStewardshipAttempt(JSON.stringify(attempt), accessSponsor, "P-OTHER", 2000),
  ).toBeUndefined();
  expect(
    parseStewardshipAttempt(JSON.stringify(attempt), accessSponsor, accessProblem, 999),
  ).toBeUndefined();
  expect(JSON.stringify(attempt)).not.toContain("PRIVATE_ACCESS_TITLE");
});

test("expired attempts remain identifiable for explicit inspection and never receive an automatic new key", () => {
  const attempt = createStewardshipAttempt(
    accessSponsor,
    accessProblem,
    stewardshipCommand,
    "original-key",
    1000,
  );
  if (!attempt) throw new Error("Missing valid retry attempt");
  expect(stewardshipAttemptExpired(attempt, 1000 + STEWARDSHIP_RETRY_MS - 1)).toBe(false);
  expect(stewardshipAttemptExpired(attempt, 1000 + STEWARDSHIP_RETRY_MS)).toBe(true);
  const expired = parseStewardshipAttempt(
    JSON.stringify(attempt),
    accessSponsor,
    accessProblem,
    1000 + STEWARDSHIP_RETRY_MS,
  );
  expect(expired).toEqual(attempt);
  expect(expired?.key).toBe("original-key");
  for (const changed of [
    { key: "bad key" },
    { startedAt: -1 },
    { version: 2 },
    { private_text: "never retain prose" },
  ]) {
    expect(
      parseStewardshipAttempt(
        JSON.stringify({ ...attempt, ...changed }),
        accessSponsor,
        accessProblem,
        2000,
      ),
    ).toBeUndefined();
  }
});

test("member and steward continuation links preserve their independent bounded cursors", () => {
  expect(
    problemGovernanceConsolePath(accessProblem, { after: "F-ONE", steward_after: accessSponsor }),
  ).toBe(`/console/problems/${accessProblem}/access?after=F-ONE&steward_after=${accessSponsor}`);
  expect(problemGovernanceConsolePath(accessProblem)).toBe(
    `/console/problems/${accessProblem}/access`,
  );
});

test("stewardship renders the actual roster and explains founding, private access and transfer consequences", () => {
  const html = renderToStaticMarkup(
    <ProblemStewardshipControl
      sponsorId={accessSponsor}
      problemId={accessProblem}
      initial={stewardshipWorkspace}
      query={{}}
      returnPath={problemGovernanceConsolePath(accessProblem)}
    />,
  );
  for (const text of [
    "Problem stewardship",
    "Roster version 7",
    "Founding steward",
    "accountable sponsor",
    accessSponsor,
    "Add a co-steward",
    "Transfer my stewardship",
    "Remove a steward",
    "grants no permanent control",
    "cannot grant scientific standing by fiat",
    "private problem formulations",
    "Account data page",
  ])
    expect(html).toContain(text);
  expect(html).toContain("<fieldset disabled");
  expect(html).not.toContain("PRIVATE_MEMBER_ALPHA");
});

test("a transferred-away account still receives the recovery surface without a current private roster", () => {
  const html = renderToStaticMarkup(
    <ProblemStewardshipControl
      sponsorId={accessSponsor}
      problemId={accessProblem}
      initial={null}
      query={{}}
      returnPath={problemGovernanceConsolePath(accessProblem)}
    />,
  );
  expect(html).toContain("exact earlier command can still be recovered");
  expect(html).not.toContain("PRIVATE_ACCESS_TITLE");
  expect(html).not.toContain("Current sponsor stewards");
  expect(html).toContain("<fieldset disabled");
});
