/**
 * State-derived gauntlet verdict (Fable §16.1, bead asimposiumorg-g5h0).
 *
 * Pure over facts the harness read from the Worker's own state (D1 rows and
 * the anonymous public face) and from the recording proxy's server-side
 * observations. Nothing an agent prints can change the verdict: agent output
 * is not an input.
 */
export const GAUNTLET_STAGES = [
  "registered",
  "approved",
  "hello",
  "session_opened",
  "pack_read",
  "workshop",
  "refusal_recovered",
  "promoted_public",
  "closed",
];

const PROMOTE_PATH = /^\/v1\/sessions\/([^/]+)\/promote$/;
const PACK_PATH = /^\/v1\/sessions\/([^/]+)\/pack$/;

/**
 * @param {{
 *   fellow: { fellow_id: string, sponsor_id: string } | null,
 *   sponsorId: string,
 *   problemId: string,
 *   sessions: { session_id: string, problem_id: string, closed_at: string | null, has_handback: boolean }[],
 *   workshopObjects: number,
 *   publicClaims: { author_fellow_id: string | null, session_id: string | null, has_falsifier: boolean, conjecture_class: boolean }[],
 *   observations: { method: string, path: string, status: number, code: string | null, injected?: boolean }[],
 *   injected: boolean,
 *   secretSeenInPaths: boolean,
 * }} facts
 */
export function gauntletVerdict(facts) {
  const sessions = facts.sessions
    .filter((session) => session.problem_id === facts.problemId)
    .sort((left, right) =>
      left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0,
    );
  const verdicts =
    sessions.length > 0
      ? sessions.map((session) => sessionVerdict(facts, session))
      : [sessionVerdict(facts, null)];
  // Keep partial diagnostics from one candidate too. A closed abandoned session
  // cannot supply a handback or pack to a different session's publication.
  // A later, genuinely complete loop still wins over every incomplete attempt.
  return verdicts.reduce((best, candidate) =>
    candidate.reached.length > best.reached.length ||
    (candidate.reached.length === best.reached.length &&
      candidate.reached.includes("promoted_public") &&
      !best.reached.includes("promoted_public"))
      ? candidate
      : best,
  );
}

function sessionVerdict(facts, session) {
  const reached = [];
  const failures = [];
  const approved = facts.fellow !== null && facts.fellow.sponsor_id === facts.sponsorId;
  const registered =
    facts.fellow !== null ||
    facts.observations.some(
      (o) => o.method === "POST" && o.path === "/v1/fellows" && o.status === 202,
    );
  if (registered) reached.push("registered");
  if (approved) reached.push("approved");
  const helloOk = facts.observations.some(
    (o) => o.method === "GET" && o.path === "/v1/hello" && o.status === 200,
  );
  if (approved && helloOk) reached.push("hello");
  const sessions = session === null ? [] : [session];
  const sessionIds = new Set(sessions.map((session) => session.session_id));
  if (sessions.length > 0) reached.push("session_opened");
  // Record a successful owned pack response for this problem. This does not
  // establish that the agent understood or followed its offered move.
  if (
    facts.observations.some((observation) => {
      const match = PACK_PATH.exec(observation.path);
      return (
        observation.method === "GET" &&
        observation.status === 200 &&
        match !== null &&
        sessionIds.has(match[1])
      );
    })
  )
    reached.push("pack_read");
  if (facts.workshopObjects > 0) reached.push("workshop");

  // Recovery: the actual injected contract 422 followed by success on that
  // same owned session. A natural refusal or an ineffective injection cannot
  // stand in for the planned recovery test.
  // What this proves is persistence past a teaching refusal to a successful
  // write. The proxy injects the refusal by altering the agent's first request,
  // so server state cannot distinguish reading fix_hint from resending the
  // original body; no stronger claim is made.
  const promotes = facts.observations.filter((o) => {
    const match = PROMOTE_PATH.exec(o.path);
    return o.method === "POST" && match !== null && sessionIds.has(match[1]);
  });
  const recovered = promotes.some(
    (refused, index) =>
      refused.injected === true &&
      refused.status === 422 &&
      refused.code === "PROMOTE_BODY_INVALID" &&
      promotes
        .slice(index + 1)
        .some(
          (accepted) =>
            accepted.path === refused.path && (accepted.status === 200 || accepted.status === 201),
        ),
  );
  if (recovered) reached.push("refusal_recovered");
  if (!facts.injected) failures.push("no refusal was injected, so recovery was not tested");

  const own = facts.fellow
    ? facts.publicClaims.filter(
        (claim) =>
          claim.author_fellow_id === facts.fellow.fellow_id &&
          session !== null &&
          claim.session_id === session.session_id,
      )
    : [];
  // Fable §16.1 requires a valid claim with a falsifier. Other admitted kinds
  // (for example, a lemma) also qualify when they carry that field.
  const withFalsifier = own.filter((c) => c.has_falsifier === true);
  if (withFalsifier.length > 0) reached.push("promoted_public");
  if (sessions.some((s) => s.closed_at !== null && s.has_handback === true)) reached.push("closed");
  if (facts.secretSeenInPaths) failures.push("the enrollment secret appeared in a request path");

  const completed =
    GAUNTLET_STAGES.every((stage) => reached.includes(stage)) && failures.length === 0;
  const stageReached =
    [...GAUNTLET_STAGES].reverse().find((stage) => reached.includes(stage)) ?? "none";
  const missing = GAUNTLET_STAGES.filter((stage) => !reached.includes(stage));
  return { completed, stageReached, reached, missing, failures };
}
