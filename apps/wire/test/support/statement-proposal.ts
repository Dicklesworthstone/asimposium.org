import {
  type ProblemLifecycleActionRequest,
  type ProblemStatementProposalRequest,
  ProblemStatementProposalResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import {
  loadStatementRevisionSnapshot,
  submitStatementProposal,
} from "../../src/problems/statement-revision-proposals.ts";

type Formulation = Omit<ProblemStatementProposalRequest, "session_id" | "base_statement_version">;
type RevisionCommand = Extract<ProblemLifecycleActionRequest, { action: "revise-statement" }>;
type Source = Awaited<ReturnType<typeof enrollStatementAuthor>>;
const sources = new WeakMap<D1Database, Map<string, Promise<Source>>>();

/** Exercise real enrollment and sponsor approval; a seeded identity is not a grant. */
async function enrollStatementAuthor(db: D1Database, sponsorId: string, problemId: string) {
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  });
  const principal = { type: "sponsor" as const, sponsorId };
  const minted = await service.mint(principal, {
    requested_scopes: ["promote"],
    problem_binding: problemId,
  });
  const claimed = await service.claim({
    enrollment_id: minted.enrollmentId,
    secret: minted.secret,
    name: `statement-author-${crypto.randomUUID().slice(0, 8)}`,
    model: "test/statement-revision",
    harness: "unit-fixture",
  });
  await service.decide(principal, minted.enrollmentId, {
    enrollment_id: minted.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await service.poll({ flow_handle: claimed.flowHandle });
  if (!("token" in issued)) throw new Error("Statement source credential was not issued.");
  const binding = await service.credentialBinding(issued.token);
  if (!binding) throw new Error("Statement source credential is not current.");
  const sessionId = `S-${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const at = new Date().toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO sessions
      (session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
      VALUES(?,?,?,?,?,?)`)
      .bind(
        sessionId,
        binding.fellowId,
        problemId,
        at,
        at,
        new Date(Date.now() + 3_600_000).toISOString(),
      ),
    db
      .prepare(`INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at)
      VALUES(?,?,'contributor',?)`)
      .bind(problemId, binding.fellowId, at),
  ]);
  return { binding, sessionId };
}

export function statementRevisionSourceFixture(
  db: D1Database,
  sponsorId: string,
  problemId: string,
) {
  let dbSources = sources.get(db);
  if (!dbSources) {
    dbSources = new Map();
    sources.set(db, dbSources);
  }
  const key = JSON.stringify([sponsorId, problemId]);
  let source = dbSources.get(key);
  if (!source) {
    source = enrollStatementAuthor(db, sponsorId, problemId);
    dbSources.set(key, source);
  }
  return source;
}

/** Return the real refusal as well as successes, so boundary tests exercise submission. */
export async function submitStatementRevisionFixture(
  db: D1Database,
  sponsorId: string,
  problemId: string,
  formulation: Formulation,
  key: string,
): Promise<Response> {
  const source = await statementRevisionSourceFixture(db, sponsorId, problemId);
  const current = await db
    .prepare("SELECT current_statement_version FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ current_statement_version: number }>();
  if (!current) throw new Error("Statement fixture problem is unavailable.");
  return submitStatementProposal(
    db,
    source.binding,
    problemId,
    {
      ...formulation,
      session_id: source.sessionId,
      base_statement_version: current.current_statement_version,
    },
    key,
  );
}

/** Prepare the exact immutable Fellow proposal a steward can accept. */
export async function reviewedStatementRevisionFixture(
  db: D1Database,
  sponsorId: string,
  problemId: string,
  formulation: Formulation,
  key: string,
): Promise<RevisionCommand> {
  const response = await submitStatementRevisionFixture(db, sponsorId, problemId, formulation, key);
  if (response.status !== 201)
    throw new Error(`Statement fixture proposal: ${response.status} ${await response.text()}`);
  const { proposal } = ProblemStatementProposalResponseSchema.parse(await response.json());
  const snapshot = await loadStatementRevisionSnapshot(
    db,
    problemId,
    proposal.proposal_id,
    sponsorId,
  );
  if (!snapshot?.preview.can_accept)
    throw new Error("Statement fixture proposal cannot be reviewed.");
  return {
    action: "revise-statement",
    proposal_id: proposal.proposal_id,
    reviewed_statement_version: proposal.base_statement_version,
    reviewed_digest: snapshot.preview.review_digest,
  };
}
