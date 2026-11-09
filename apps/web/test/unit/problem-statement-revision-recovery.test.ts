import { expect, test } from "bun:test";
import {
  clearPendingStatementRevision,
  createPendingStatementRevision,
  parsePendingStatementRevision,
  persistPendingStatementRevision,
  STATEMENT_REVISION_RETRY_MS,
  statementRevisionAttemptExpired,
  statementRevisionRecoveryKey,
} from "../../lib/problem-statement-revision";
import {
  revisionCommand,
  revisionProblem,
  revisionSponsor,
} from "../fixtures/problem-statement-revision";

const now = 1_793_016_000_000;
const pending = () =>
  createPendingStatementRevision(
    revisionSponsor,
    revisionProblem,
    revisionCommand,
    "exact-statement-retry",
    now,
  );
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("acceptance recovery survives reload with only exact proposal metadata and the original key", () => {
  const retained = storage(),
    original = pending();
  persistPendingStatementRevision(retained, original);
  const raw = retained.getItem(statementRevisionRecoveryKey(revisionSponsor, revisionProblem))!;
  const restored = parsePendingStatementRevision(raw, revisionSponsor, revisionProblem);
  expect(restored).toEqual(original);
  expect(Object.keys(restored.input).sort()).toEqual([
    "action",
    "proposal_id",
    "reviewed_digest",
    "reviewed_statement_version",
  ]);
  expect(raw).not.toContain("PRIVATE_REVISION");
  persistPendingStatementRevision(retained, restored);
  expect(retained.getItem(statementRevisionRecoveryKey(revisionSponsor, revisionProblem))).toBe(
    raw,
  );
});

test("a second candidate, digest or key cannot overwrite an unresolved acceptance", () => {
  const retained = storage(),
    original = pending();
  persistPendingStatementRevision(retained, original);
  for (const changed of [
    { ...original, key: "different-key" },
    { ...original, startedAt: now + 1 },
    { ...original, input: { ...original.input, reviewed_digest: "c".repeat(64) } },
    {
      ...original,
      input: { ...original.input, proposal_id: "SPR-22345678-1234-1234-1234-123456789abc" },
    },
  ]) {
    expect(() => persistPendingStatementRevision(retained, changed)).toThrow("unresolved");
    expect(() => clearPendingStatementRevision(retained, changed)).toThrow("unresolved");
  }
  clearPendingStatementRevision(retained, original);
  expect(
    retained.getItem(statementRevisionRecoveryKey(revisionSponsor, revisionProblem)),
  ).toBeNull();
});

test("recovery rejects scientific prose, another account and malformed metadata before any retry", () => {
  const original = pending();
  for (const value of [
    { ...original, extra: "private text" },
    { ...original, key: "key\n" },
    { ...original, startedAt: -1 },
    { ...original, input: { ...original.input, statement: "SPONSOR_AUTHORED_REPLACEMENT" } },
    { ...original, input: { ...original.input, proposal_id: `${original.input.proposal_id}\n` } },
    {
      ...original,
      input: { ...original.input, reviewed_statement_version: Number.MAX_SAFE_INTEGER },
    },
    {
      ...original,
      input: { action: "publish", reviewed_statement_version: 3, reviewed_digest: "b".repeat(64) },
    },
  ])
    expect(() =>
      parsePendingStatementRevision(JSON.stringify(value), revisionSponsor, revisionProblem),
    ).toThrow();
  expect(() =>
    parsePendingStatementRevision(JSON.stringify(original), "usr_other_sponsor", revisionProblem),
  ).toThrow();
  expect(() =>
    parsePendingStatementRevision(JSON.stringify(original), revisionSponsor, "P-OTHER"),
  ).toThrow();
  expect(() =>
    parsePendingStatementRevision(" ".repeat(2049), revisionSponsor, revisionProblem),
  ).toThrow();
});

test("storage must retain the exact command and the safe retry deadline never renews itself", () => {
  const original = pending();
  expect(() =>
    persistPendingStatementRevision({ getItem: () => null, setItem() {} }, original),
  ).toThrow();
  expect(statementRevisionAttemptExpired(original, now)).toBe(false);
  expect(statementRevisionAttemptExpired(original, now + STATEMENT_REVISION_RETRY_MS - 1)).toBe(
    false,
  );
  expect(statementRevisionAttemptExpired(original, now + STATEMENT_REVISION_RETRY_MS)).toBe(true);
  expect(statementRevisionAttemptExpired(original, now - 1)).toBe(true);
  expect(original.key).toBe("exact-statement-retry");
  expect(original.startedAt).toBe(now);
});
