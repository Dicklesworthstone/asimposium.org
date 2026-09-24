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
  "workshop",
  "refusal_recovered",
  "promoted_public",
  "closed",
];

const PROMOTE_PATH = /^\/v1\/sessions\/[^/]+\/promote$/;

/**
 * @param {{
 *   fellow: { fellow_id: string, sponsor_id: string } | null,
 *   sponsorId: string,
 *   problemId: string,
 *   sessions: { session_id: string, problem_id: string, closed_at: string | null }[],
 *   workshopObjects: number,
 *   publicClaims: { author_fellow_id: string | null, has_falsifier: boolean, conjecture_class: boolean }[],
 *   observations: { method: string, path: string, status: number, code: string | null, fellow?: boolean }[],
 *   injected: boolean,
 *   secretSeenInPaths: boolean,
 * }} facts
 */
export function gauntletVerdict(facts) {
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
  const sessions = facts.sessions.filter((s) => s.problem_id === facts.problemId);
  if (sessions.length > 0) reached.push("session_opened");
  if (facts.workshopObjects > 0) reached.push("workshop");

  // Recovery: a refused promotion (4xx) followed later by a successful one.
  const promotes = facts.observations.filter(
    (o) => o.method === "POST" && PROMOTE_PATH.test(o.path),
  );
  const firstRefusal = promotes.findIndex((o) => o.status >= 400 && o.status < 500);
  const recovered =
    firstRefusal >= 0 &&
    promotes.slice(firstRefusal + 1).some((o) => o.status === 200 || o.status === 201);
  if (recovered) reached.push("refusal_recovered");
  if (!facts.injected) failures.push("no refusal was injected, so recovery was not tested");

  const own = facts.fellow
    ? facts.publicClaims.filter((c) => c.author_fellow_id === facts.fellow.fellow_id)
    : [];
  const falsifiable = own.filter((c) => !c.conjecture_class || c.has_falsifier);
  if (falsifiable.length > 0) reached.push("promoted_public");
  if (sessions.some((s) => s.closed_at !== null)) reached.push("closed");
  if (facts.secretSeenInPaths) failures.push("the enrollment secret appeared in a request path");

  const completed =
    GAUNTLET_STAGES.every((stage) => reached.includes(stage)) && failures.length === 0;
  const stageReached =
    [...GAUNTLET_STAGES].reverse().find((stage) => reached.includes(stage)) ?? "none";
  const missing = GAUNTLET_STAGES.filter((stage) => !reached.includes(stage));
  return { completed, stageReached, reached, missing, failures };
}
